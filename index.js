// hana-downloader-app/index.js
// ─────────────────────────────────────────────────────────────────────────────
// 小花下载器 · v2 App 入口（官方 @hana/app-sdk）
//
// 职责：
//   1. 以 local-machine 受管程序拉起下载引擎（engine/server.js）
//   2. 注册四个工具：download-file / download-wait / download-cancel / download-command
//   3. 聊天流卡片：经 session:send-custom 投递自定义消息，由清单里的
//      contributes.messageRenderers 把它映射成流内卡
//   4. 任务终态经宿主任务面回执（sdk.tasks），由宿主统一投递
//   5. 下载铁律：agent/before-start 裁决钩子注入，避免模型绕过本工具裸下载
//
// 为什么卡片不走工具返回值的 details.card（2026-09-13 实测结论）：
//   宿主 0.970.9 投影工具结果时，v2 App 的工具名被泛化成 "tool_call"，
//   归属解析 resolveToolOwner 拿不到真实名字，卡片被判为无主后被静默丢弃
//   （它还会照样在结果里写一行 "Card rendered. cardInstanceId: ..."）。
//   实测：整个会话的投影里 0 张卡来自工具返回值，8 张卡全部来自
//   messageRenderers 通道。详见 docs/重构说明.md。
//
// 卡片身份（哪张卡对应哪个任务）：
//   投递时消息里不带任务身份，卡片页面也拿不到消息 payload。所以由引擎侧
//   维护一张绑定表：卡片加载后自报宿主编的 cardInstanceId 与所在会话，
//   引擎按「同会话、未绑定、最先投递」认领一个任务并写死绑定关系。
//   cardInstanceId 在重新投影后保持不变，所以会话重载不会串任务。
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";
import { defineApp } from "./sdk/app-contract/server-client.js";
// 引擎端口与展示文案都有单一来源，不在这里重写一份：
//   engine/engine-port.js  端口（server.js 同用）
//   ui/shared/display.js   阶段/单位文案与任务形态判定（卡片、管理器同用）
import { ENGINE_PORT } from "./engine/engine-port.js";
import { isPkgTask, isCloneTask, isCmdTask, waitLineText, displayNameOf } from "./ui/shared/display.js";
import { parseEngineResponse, asText } from "./engine/ipc-contract.js";
// 平台能力：命令类型的 enum 由能力表决定，不是写死的四个（方案 §3.3 原则二/三）。
// 非 Windows 上不列 winget —— 模型看不到就不会去调，也就不会拿到一个「平台不支持」的错。
import { platform } from "./engine/platform/index.mjs";

const APP_ID = "hana-downloader";
const ENGINE_ENTRY = "engine/server.js";

// 命令类型白名单：按平台能力裁。winget 是 Windows 专有包管理器。
//
// 为什么不是只看 capabilities.pkgManager：那是「现在能不能找到 winget.exe」的实时探测，
// 结果为负时只缓存 5 秒（给用户装完即用）。但工具的 enum 在 App 启动时就定下来了，
// 若恰好碰上探测失败（进程刚起、PATH 未就绪），winget 会被永久地从 enum 里剔掉，
// 直到重启 App——那就变成了「明明装着却调不到」。
// 所以这里用两个条件的并：平台结构上有没有 winget（win32）、或探测到了。
const HAS_WINGET = (() => {
  try { return platform.name === "win32" || platform.capabilities.pkgManager === "winget"; }
  catch { return false; }
})();
const COMMAND_KINDS = HAS_WINGET
  ? ["git-clone", "pnpm-install", "pip-install", "winget-install"]
  : ["git-clone", "pnpm-install", "pip-install"];

// 代理启停能力（2026-10-20）：读注册表 + 扫 .exe + tasklist/taskkill 这套东西的形态就是 Windows 的。
//
// 这是同一次裁剪的**第三处**，三处必须一致，少一处就等于没裁：
//   1. engine/server.js   六个 /proxy-control/* 端点 —— 不支持时回 200 + unsupported
//   2. ui/manager.js      设置菜单里的三个入口 —— 不支持时不渲染（不是灰掉）
//   3. index.js（这里）   agent 工具 proxy-control —— 不支持时整块不注册
//
// 为什么漏了这一处最糟：前两处只管住了 UI 和服务端，模型仍然看得见这个工具，
// 调 status 会拿到 200 + unsupported，再被工具层翻成 isError:true 的失败提示。
// 同一件「平台没有这个能力」的事被说成三种样子，最容易被误读成「功能坏了」。
//
// 也不做成「注册了再在 execute 里拒绝」：模型看得见的工具就会去调，
// 看不见才是真剪掉（与上面 winget 不列进 enum 同一个道理）。
// 取值与本文件 HAS_WINGET 同风格：能力拿不到就当没有，宁少不错。
const HAS_PROXY_CONTROL = (() => {
  try { return platform.capabilities.proxyControl === true; }
  catch { return false; }
})();

const PING_TIMEOUT_MS = 3000;
const READY_WAIT_MS = 25000;
const WATCHDOG_INTERVAL_MS = 30000;
const SETTLE_POLL_INTERVAL_MS = 2000;
const SETTLE_MAX_POLLS = 900;
// 重试任务的通知守望：6 小时（2s × 10800）。重试可能是几十 GB 的大文件，30 分钟不够。
const RETRY_NOTIFY_MAX_POLLS = 10800;
const MAX_ANNOUNCE_PER_HOUR = 30;

const RULE_MARK = "【下载铁律】";
const RECORD_PREFIX = "【下载记录】";
const DOWNLOAD_TOOL = `${APP_ID}_download-file`;
const COMMAND_TOOL = `${APP_ID}_download-command`;

/**
 * 为一条投递消息生成稳定的卡片实例 id。
 *
 * 为什么需要它：宿主自己铸造的 cardInstanceId 是 (pluginId, route, messageId, customType…)
 * 的 hash，而实时投影与历史投影用的 messageId 并不相同——实测同一条消息在两边拿到的是
 * 两个不同的 a_*。卡片因此没有跳重载的稳定身份。
 *
 * 宿主投影层对 details.cardInstanceId 有现成入口（合法就直接采用，否则才自己铸），
 * 所以这里直接给出一个格式合规（^a_[0-9a-f]{20}$）的确定值。
 */
function stableCardId(taskId) {
  const hex = crypto.createHash("sha256").update(`${APP_ID}:${taskId}`).digest("hex").slice(0, 20);
  return `a_${hex}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default defineApp(async (sdk) => {
  // ── 日志 ──
  // SDK 的成员是 promise 化的，fire-and-forget 必须吞掉 rejection，否则会冒未处理拒绝。
  const fire = (p) => { try { if (p && typeof p.catch === "function") p.catch(() => {}); } catch { /* 忽略 */ } };
  const log = (m) => fire(sdk.logger?.info?.(`[hd] ${m}`));
  const err = (m) => fire(sdk.logger?.error?.(`[hd] ${m}`));

  const dataDir = sdk.dataDir;
  log(`apply entered | dataDir=${dataDir} | sdk=${typeof sdk}`);

  let engine = null;

  // ── 引擎进程管理 ────────────────────────────────────────────────

  // reload 时旧受管进程可能还占着端口，先清掉本 App 的遗留实例。
  async function stopStaleRuntimes() {
    try {
      const list = await sdk.runtime.list();
      for (const rt of Array.isArray(list) ? list : []) {
        if (!rt?.runtimeId) continue;
        if (rt.state === "ready" || rt.state === "starting") {
          try {
            await sdk.runtime.stop(rt.runtimeId);
            log(`stopped stale runtime | ${rt.runtimeId} (${rt.state})`);
          } catch (e) {
            err(`stop ERR ${rt.runtimeId} | ${e?.message || e}`);
          }
        }
      }
    } catch (e) {
      err(`list runtimes ERR | ${e?.message || e}`);
    }
  }

  async function startEngine() {
    const rt = await sdk.runtime.start({
      runtime: "node",
      entry: ENGINE_ENTRY,
      profile: "local-machine",
      network: "external",
      args: [dataDir || ""],
      // 不注册 service：常驻的 runtime 服务连接会留在 AppHost 的 inflight 表里，
      // 让工具回程前的 drain() 永远转圈，工具报 30s RPC 超时。
      // 引擎自己监听 127.0.0.1，App 侧经受控出网通道访问。
    });
    engine = rt;
    log(`engine started | ${JSON.stringify(rt)}`);
    return rt;
  }

  async function callEngine(path, init) {
    const url = `http://127.0.0.1:${ENGINE_PORT}${path}`;
    const opts = { method: "POST", timeoutMs: 30000, ...(init || {}) };
    let raw;
    try {
      raw = await sdk.network.fetch(url, opts);
    } catch (e) {
      throw new Error(`engine fetch ${path} failed: ${e?.message || e}`);
    }
    const text = await raw.text();
    // 2026-10-18 修：旧实现解析失败时 `return text` 把裸字符串交给调用方，
    // 调用方按对象用（r.ok / r.taskId / r.port）全是 undefined —— 引擎失联
    // 被显示成「任务已发起/已完成」，属于乱码当成功。现在统一返回结构化错误对象，
    // 契约形状恒为 object（详见 engine/ipc-contract.js）。
    return parseEngineResponse(text);
  }

  // 探活用：引擎必须真的回了一个 ok 的回包，非 JSON 不算 ready（否则 watchdog 会以为一切正常）
  async function pingEngine(timeoutMs) {
    const r = await callEngine("/ping", { method: "GET", timeoutMs });
    if (r?.ok === false) throw new Error(r.error || "engine ping 非法回包");
    return r;
  }

  async function waitEngineReady(timeoutMs = READY_WAIT_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await pingEngine(PING_TIMEOUT_MS);
        log(`engine ready | ${JSON.stringify(r).slice(0, 200)}`);
        return true;
      } catch {
        await sleep(800);
      }
    }
    err("engine ready timeout");
    return false;
  }

  // 受管进程可能静默消失（宿主日志里没有退出痕迹），宿主也不会自动重启它。
  // 没有这层探活，一次意外退出会让之后所有工具调用都报 engine fetch failed。
  let watchdogTimer = null;
  let restarting = false;
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      if (restarting) return;
      try {
        await pingEngine(4000);
      } catch (e) {
        restarting = true;
        err(`engine unreachable, restarting | ${e?.message || e}`);
        try {
          await stopStaleRuntimes();
          await startEngine();
          log(`engine restarted | ok=${await waitEngineReady(20000)}`);
        } catch (e2) {
          err(`engine restart ERR | ${e2?.message || e2}`);
        } finally {
          restarting = false;
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  // ── 终态结算 ────────────────────────────────────────────────────
  // 引擎把终态写成 dataDir/finished/<taskId>.json，这里读文件而不是轮询引擎：
  // 轮询会产生持续的挂起 RPC，把工具回程前的 drain() 堵死。
  async function settleWhenDone(engineTaskId, hostTaskId, label, stallTaskId = null) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const finishedPath = path.join(dataDir, "finished", `${engineTaskId}.json`);
    const stalledPath = path.join(dataDir, "stalled", `${engineTaskId}.json`);

    let snap = null;
    let stallSeen = false;
    for (let i = 0; i < SETTLE_MAX_POLLS; i++) {
      await sleep(SETTLE_POLL_INTERVAL_MS);
      if (!stallSeen) {
        try {
          if (fs.existsSync(stalledPath)) {
            stallSeen = true;
            log(`stall observed | ${engineTaskId}`);
          }
        } catch { /* 读不到就当没停滞 */ }
      }
      try {
        if (fs.existsSync(finishedPath)) {
          snap = JSON.parse(fs.readFileSync(finishedPath, "utf8"));
          break;
        }
      } catch { /* 半写状态，下一轮再读 */ }
    }

    if (!snap) {
      try { await sdk.tasks.fail(hostTaskId, "下载超时未结束"); } catch { /* 宿主任务可能已结束 */ }
      await closeUnusedStallTask(stallTaskId);
      return;
    }

    // 任务形态判定统一走 ui/shared/display.js（原先这里、卡片、管理器各判一遍）
    const isPkg = isPkgTask(snap);
    const isClone = isCloneTask(snap);
    const isCmd = isCmdTask(snap);
    const name = displayNameOf(snap.fileName, label, snap.taskId);
    // 三类任务分开措辞（2026-09-19）：
    //   URL 下载 → 字节数有意义；命令类（clone/pnpm）received/total 是对象数/包数，不是产物大小；
    //   包安装（winget/pip）没有可打开产物，只报备注。
    const verb = isPkg ? "安装" : isClone ? "克隆" : isCmd ? "安装" : "下载";
    const text = snap.state === "done"
      ? isPkg
        ? `安装完成：${name}${snap.note ? `\n${snap.note}` : ""}`
        : isCmd
          ? `${isClone ? "克隆完成" : "依赖安装完成"}：${name}\n路径：${snap.filePath || "?"}`
          : `下载完成：${name}\n路径：${snap.filePath || "?"}\n大小：${snap.received ?? "?"} 字节`
      : snap.state === "canceled"
        ? `${verb}已取消：${name}`
        : `${verb}失败：${name}${snap.error ? `（${snap.error}）` : ""}`;
    // 模型可见文本必须恒为字符串（宿主读 .length，非字符串会抛错）。
    const body = asText(text);

    try {
      if (snap.state === "done") {
        await sdk.tasks.complete(hostTaskId, {
          text: body,
          filePath: snap.filePath || null,
          total: snap.total ?? null,
          received: snap.received ?? 0,
        });
      } else if (snap.state === "canceled") {
        await sdk.tasks.cancel(hostTaskId);
      } else {
        await sdk.tasks.fail(hostTaskId, asText(body));
      }
      log(`tasks settled | ${hostTaskId} -> ${snap.state}`);
    } catch (e) {
      err(`tasks settle ERR | ${hostTaskId} | ${e?.message || e}`);
    }
    // 终态文件已消费：删掉，finished/ 不再只增不减（2026-10-10）
    try { fs.unlinkSync(finishedPath); } catch { /* 已删或占用，忽略 */ }
    // 下载结束了：卡滞提醒任务没用上就取消掉
    await closeUnusedStallTask(stallTaskId);
  }

  // ── sessionPath → sessionId 解析（2026-09-20）────────────────
  // 为什么需要它：宿主的 session:send-custom 只认 sessionId。只给 sessionPath 会报
  //   Session manifest resolution requires sessionId or legacy sessionPath.
  // 根因是宿主内部字段不一致：ro() 把 sessionPath 包成 { legacySessionPath } 交给
  // SessionManifestResolver，而那个 resolver 只认 e.sessionPath || e.path（见 _Pt），
  // 于是拿不到路径就抛错。这是宿主 0.1013.2 的实现现状，见踩坑记录第 36 条。
  //
  // 所以「按会话路径投递」只能在 App 换成 sessionId。工具 execute 期间有会话上下文，
  // 就在这里查一次并随任务存下去，后续所有通知（卡滞 / 重试）都靠它。
  //
  // 两个宿主约束（读 0.1013.2 bundle 的 session:list handler 得到）：
  //   · 必须传 scope: "all"，否则只列本 App 自己的会话（用户的会话不在里面，永远匹配不到）
  //   · scope:"all" 会校验能力 app/sessions.read（“read sessions outside this app”），
  //     清单里必须声明它，光有 app/sessions.manage 不够
  // 进程内缓存：同一个会话的后续调用直接命中，不必反复拉列表。
  // 带上限的 LRU（2026-10-10）：Map 的插入序即访问序，命中时 delete + set 刷新到队尾，
  // 超限淘汰最旧的一条。长驻进程不会再把每个会话都留一份。
  const SESSION_ID_CACHE_MAX = 500;
  const sessionIdCache = new Map();
  function cacheSessionId(sessionPath, id) {
    if (sessionIdCache.has(sessionPath)) sessionIdCache.delete(sessionPath);
    sessionIdCache.set(sessionPath, id);
    if (sessionIdCache.size > SESSION_ID_CACHE_MAX) {
      const oldest = sessionIdCache.keys().next().value;
      if (oldest !== undefined) sessionIdCache.delete(oldest);
    }
  }
  async function resolveSessionId(sessionPath) {
    if (!sessionPath) return null;
    if (sessionIdCache.has(sessionPath)) {
      const hit = sessionIdCache.get(sessionPath);
      cacheSessionId(sessionPath, hit); // 命中刷新 LRU 位置
      return hit;
    }
    let id = null;
    try {
      const r = await sdk.sessions.list({ scope: "all" });
      const arr = Array.isArray(r) ? r : (r?.sessions || r?.items || r?.list || []);
      const hit = (Array.isArray(arr) ? arr : []).find((s) => s && (s.path === sessionPath || s.sessionPath === sessionPath));
      id = hit?.sessionId || hit?.id || null;
    } catch (e) {
      err(`resolveSessionId ERR | ${e?.message || e}`);
    }
    if (id) { cacheSessionId(sessionPath, id); log(`sessionId resolved | ${id}`); }
    else log(`sessionId unresolved | ${sessionPath}`);
    return id;
  }

  // ── 卡滞通知任务（2026-09-20 建，2026-10-19 停用）──────────────────
  // 曾用「独立宿主任务 + next-step 投递」承载卡滞提醒。停用原因（2026-10-19 用户实测）：
  // 一次下 3 个文件，聊天区冒出 6 个后台任务条目（3 个「下载 x」+ 3 个「停滞提醒：x」），
  // 而 sdk.tasks 的 22 个成员里**没有 remove**，abort/cancel 只改状态，条目永久占着任务面
  // （宿主已累计 109 条历史）。
  // 现在卡滞提醒一律走 session:send-custom + triggerTurn（不占任务条目），见 scanStalls。
  // 下面这个 createStallTask 不再被调用，保留仅为函数名/签名对照（两处调用点已去掉）。
  async function createStallTask(callToken, label) {
    if (!callToken) return null;
    // label 可能是 undefined（未传文件名/URL 的调用路径），先收口再拼，避免「停滞提醒：undefined」
    const name = asText(label) || "任务";
    try {
      const st = await sdk.tasks.create({ callToken, label: `停滞提醒：${name}`, delivery: "next-step" });
      const id = st?.taskId || null;
      log(`stall-task created | ${id} | ${name}`);
      return id;
    } catch (e) {
      err(`stall-task create ERR | ${e?.message || e}`);
      return null;
    }
  }

  // 已经被卡滞提醒消费掉的甴主任务：下载终态时不再重复结算（否则要么投递一条废消息，要么一直挂着）
  const consumedStallTasks = new Set();

  // 下载结束时收尾：卡滞提醒任务没用上就取消掉
  // （挂着的 pending app-task 会挡住短定时，踩坑第 17 条）
  async function closeUnusedStallTask(stallTaskId) {
    if (!stallTaskId) return;
    if (consumedStallTasks.has(stallTaskId)) { consumedStallTasks.delete(stallTaskId); return; }
    try {
      // 收尾要「静默」：cancel 会把一条 "canceled" 当成结果投给模型，
      // 每次没卡滞的下载都白得一条噪音（实测）。
      // sdk.tasks 的 22 个成员里没有 remove（启动时打印过成员名），先试 abort，不行退回 cancel。
      if (typeof sdk.tasks?.abort === "function") {
        try {
          await sdk.tasks.abort(stallTaskId, "未使用，静默收尾");
          log(`stall-task aborted (unused) | ${stallTaskId}`);
          return;
        } catch (e2) {
          log(`stall-task abort failed, fallback to cancel | ${e2?.message || e2}`);
        }
      }
      await sdk.tasks.cancel(stallTaskId);
      log(`stall-task closed (unused, via cancel) | ${stallTaskId}`);
    }
    catch (e) { err(`stall-task close ERR | ${stallTaskId} | ${e?.message || e}`); }
  }

  // ── 往原会话投一条隐藏记录（2026-09-20）──────────────────────
  // 两处用它：UI 发起的重试跑完的结果、以及任务卡滞需要 agent 知道的情况。
  // 两者都需要「不依赖 callToken」的投递——工具 execute 早已结束，宿主任务面（sdk.tasks）用不了。
  //
  // 关键点：
  //   triggerTurn    默认 **false**（2026-09-20 用户确认）：这些信息重要到该知道，但没重要到
  //                  值得打断或另起一轮。「及时」的落点是**把消息拼进会话、等下一次 API 调用读到**，
  //                  不是立刻唤起模型。会话空闲时它就安静躺着，用户下次说话时进入上下文。
  //                  唯一的例外是卡滞提醒（2026-10-19）：那时没人能替 agent 决策，必须叫醒，
  //                  由调用方显式传 { triggerTurn: true }；重试通知等其它用途保持 false 不动。
  //   sessionId      必须给（只给 sessionPath 会被宿主拒绝，见 resolveSessionId 的注释）。
  //   scope: "all"   目标会话不属于本 App；缺省的 scope:"own" 会被宿主直接拒（校验点在
  //                  app-host 的会话归属检查里，错误文案是 does not belong to app）。
  //   能力          scope:all + manage 需要 app/sessions.manage；会话正在流式中投递时
  //                  还需要 app/session.start-turn（消息会进模型上下文）。两者清单里都已声明。
  //   customType    会被宿主加前缀成 app:hana-downloader/<name>。**别用 download**——
  //                  清单里的 messageRenderers 声明着它，会把消息渲染成一张多余卡片。
  async function notifySession(target, text, customType, opts = {}) {
    const sessionPath = typeof target === "string" ? target : target?.sessionPath;
    let sessionId = typeof target === "string" ? null : target?.sessionId;
    // content 是模型可见文本：入口归一成字符串，null/undefined/对象一律不直接下发
    // （宿主会读 content 的 .length，非字符串是会话级事故，2026-10-18）
    const body = asText(text);
    // 夹带兜底：任务里没存 sessionId（老任务）时现查一次
    if (!sessionId) sessionId = await resolveSessionId(sessionPath);
    if (!sessionId) { log(`notify skipped (${customType}) | 没有 sessionId`); return false; }
    try {
      await sdk.sessions.sendCustom({
        sessionId,
        sessionPath: sessionPath || undefined,
        content: body,
        customType: customType || "retry-note",
        display: false,
        // 只有显式 opts.triggerTurn === true 才唤起一轮；其余一律 false（默认档位不变）
        triggerTurn: opts?.triggerTurn === true,
        scope: "all",
      });
      log(`notify sent (${customType}) | ${sessionId}`);
      return true;
    } catch (e) {
      err(`notify ERR (${customType}) | ${e?.message || e}`);
      return false;
    }
  }

  // 重试一被受理就先告诉 agent（2026-09-21）。这是「agent 感知不同步」的正面：
  // 它此前收到的是这个任务的终态（失败/取消），用户点了重试之后它并不知道任务又跑起来了，
  // 于是 agent、卡片、管理器三方各说各话。这里发一条轻量记录说清是重试发起
  //（不是新的下载请求），跑完的结果另外再通知一次。
  async function notifyRetryStarted(engineTaskId, sessionPath, label) {
    try {
      // 投递文本进模型上下文：名字统一走 displayNameOf，避免出现「任务：undefined」
      const name = displayNameOf(label, engineTaskId);
      const lines = [
        `${RECORD_PREFIX}用户在下载管理器里点「重试」，该任务已重新开始（重试发起，不是新的下载请求）。`,
        `任务：${name}`,
        `任务 ID：${engineTaskId}`,
        `跑完会再通知一次结果；想随时看进度可以用 download-wait 查这个 ID。`,
      ];
      await notifySession({ sessionPath }, lines.join("\n"), "retry-note");
    } catch (e) {
      err(`retry start notify ERR | ${e?.message || e}`);
    }
  }

  // 轮询 finished/<taskId>.json（与 settleWhenDone 同一机制：读文件，不占 RPC），
  // 终态时把结果投回原会话。引擎在 /retry 里已把上一轮的终态文件删掉，所以这里读到的必是这一次的。
  async function notifyWhenRetryDone(engineTaskId, sessionPath, label) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const finishedPath = path.join(dataDir, "finished", `${engineTaskId}.json`);
    let snap = null;
    for (let i = 0; i < RETRY_NOTIFY_MAX_POLLS; i++) {
      await sleep(SETTLE_POLL_INTERVAL_MS);
      try {
        if (fs.existsSync(finishedPath)) { snap = JSON.parse(fs.readFileSync(finishedPath, "utf8")); break; }
      } catch { /* 半写状态，下一轮再读 */ }
    }
    if (!snap) { log(`retry notify | 未等到终态 ${engineTaskId}`); return; }

    const name = displayNameOf(snap.fileName, label, engineTaskId);
    const stateCn = snap.state === "done" ? "完成" : snap.state === "canceled" ? "已取消" : "失败";
    const lines = [
      `${RECORD_PREFIX}用户在下载管理器里点「重试」的任务已结束（重试发起，不是新的下载请求）。`,
      `任务：${name}`,
      `结果：${stateCn}`,
      `任务 ID：${engineTaskId}`,
    ];
    if (snap.filePath) lines.push(`路径：${snap.filePath}`);
    if (snap.note) lines.push(`备注：${snap.note}`);
    if (snap.error) lines.push(`错误：${snap.error}`);
    await notifySession({ sessionId: snap.sessionId, sessionPath }, lines.join("\n"), "retry-note");
    // 已投递：删掉终态文件，finished/ 不再只增不减（2026-10-10）
    try { fs.unlinkSync(finishedPath); } catch { /* 已删或占用，忽略 */ }
  }

  // ── 卡滞守望（2026-09-20）───────────────────────────────────
  // 为什么需要它：卡滞是「需要 agent 决策」的状态（对端停发，继续等还是取消），
  // 而它发生在工具 execute 早已结束之后——那条路要 callToken，用不了。
  // 所以改成 App 侧常驻轮询引擎落的 stalled/<taskId>.json，再用 session:send-custom
  // 把「停了，你来定」投回原会话（triggerTurn:true 会直接唤起一轮）。
  //
  // 两条路分工：卡滞叫醒决策（sendCustom + triggerTurn，不占宿主任务条目），
  // 终态（宿主任务面）报告结果。2026-10-19 之前卡滞也建一个宿主任务走 next-step，
  // 结果是每次下载都在聊天区多占一条「停滞提醒：xxx」且永远删不掉（sdk.tasks 没有 remove）。
  //
  // 去重：key = taskId#stalledAt。同一个任务两次卡滞是两件事（中间恢复过），各自通知一次。
  // 启动时先静默扫一遍：stalled/ 里的存量都是历史卡滞，回放只会重复叫醒。
  // 1 秒扫一次：卡滞通知的意义就在「第一时间」，3 秒的轮询会让「即时」打折。
  // 开销是一次 readdir + 至多几个小 JSON，可忽略。
  // 与引擎侧的判定间隔（同样 1 秒级）叠起来，从「真的卡住」到「agent 被叫醒」最坏约 2 秒。
  const STALL_WATCH_MS = 1000;
  // 陈旧阈值：stalled/ 与 finished/ 里超过 12 小时的文件视为历史，启动时清掉（2026-10-10）
  const STALE_MS = 12 * 60 * 60 * 1000;
  const notifiedStalls = new Set();
  let stallTimer = null;

  async function scanStalls(silent = false) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(dataDir, "stalled");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    // 本轮待投的卡滞：按会话分组（一条 sendCustom 只能投一个会话），
    // 同一会话里的多条在末尾合并成一条消息（每条一段、段间空行），只投一次。
    // 一个会话只有一条卡滞时行为与拆分前一致。
    const pending = new Map(); // sessionKey -> { sessionId, sessionPath, blocks[], files[] }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      if (!snap?.taskId) continue;
      const key = `${snap.taskId}#${snap.stalledAt || ""}`;
      if (notifiedStalls.has(key)) continue;
      notifiedStalls.add(key);
      if (silent) {
        // 启动首扫：存量是历史卡滞，不回放；太老的直接清掉，避免 stalled/ 只增不减。
        // 年龄优先取业务时间 stalledAt；9 月中旬那批老文件没有该字段，退回文件 mtime 兜底
        //（2026-10-10：实测有 9 个缺 stalledAt 的老文件因此清不掉，补这条兜底）。
        let age = snap.stalledAt ? Date.now() - snap.stalledAt : null;
        if (age === null) {
          try { age = Date.now() - fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* 读不到就不清 */ }
        }
        if (age !== null && age > STALE_MS) {
          try { fs.unlinkSync(path.join(dir, f)); log(`stall stale removed | ${f}`); } catch { /* 忽略 */ }
        }
        continue;
      }
      const sp = snap.sessionPath;
      const sid = snap.sessionId;
      if (!sp && !sid) { log(`stall notify skipped | ${snap.taskId} 没有会话标识`); continue; }
      const secs = snap.stalledAt ? Math.round((Date.now() - snap.stalledAt) / 1000) : null;
      // 段落里不带总标题（合并时按条数生成），每条自己是一段完整信息
      const block = [
        `任务：${snap.fileName || snap.taskId}`,
        `任务 ID：${snap.taskId}`,
        `已停滞：约 ${secs ?? "?"} 秒（一直没收到新数据）`,
        `当前进度：${snap.received ?? "?"}${snap.total ? "/" + snap.total : ""} 字节`,
        snap.filePath ? `目标文件：${snap.filePath}` : null,
        `可选动作：继续等（对端可能自己恢复）；取消（download-cancel ${snap.taskId}）；或者先放着。`,
        `（这条记录是当时写下的，你读到它时可能已经过时；先用 download-wait ${snap.taskId} 确认当前状态再动手。）`,
      ].filter(Boolean).join("\n");
      const sessionKey = sid || sp;
      let item = pending.get(sessionKey);
      if (!item) { item = { sessionId: sid, sessionPath: sp, blocks: [], files: [] }; pending.set(sessionKey, item); }
      item.blocks.push(block);
      item.files.push(f);
    }

    // 投递：卡滞必须叫醒 agent（triggerTurn: true）——这是唯一为 true 的用途，
    // 因为没有人能替它决策；重试通知等其他用途保持 false（见 notifySession 的注释）。
    for (const item of pending.values()) {
      const n = item.blocks.length;
      const header = n === 1
        ? `${RECORD_PREFIX}下载任务停滞，需要你决策（不是工具调用的结果）。`
        : `${RECORD_PREFIX}有 ${n} 个下载任务停滞，需要你决策（不是工具调用的结果）。`;
      const body = [header, ...item.blocks].join("\n\n");
      // 只在「真的投出去」之后才删文件；投失败就留着（去重逻辑不变）
      const delivered = await notifySession(
        { sessionId: item.sessionId, sessionPath: item.sessionPath },
        body, "download-stall", { triggerTurn: true },
      );
      if (delivered) {
        for (const f of item.files) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ } }
        log(`stall notify sent | ${n} 条 | ${item.sessionId || item.sessionPath}`);
      }
    }
  }

  function startStallWatcher() {
    if (stallTimer) return;
    scanStalls(true)
      .catch((e) => err(`stall first scan ERR | ${e?.message || e}`))
      .finally(() => {
        stallTimer = setInterval(() => {
          scanStalls().catch((e) => err(`stall scan ERR | ${e?.message || e}`));
        }, STALL_WATCH_MS);
      });
  }

  // 启动兜底清理：finished/ 里 mtime 超过 12 小时的孤儿终态文件（正常路径「读走即删」，
  // 这里只收没人读的：进程崩溃、等待者没了等）。单个失败不影响其它，也不中断启动。
  async function cleanStaleFinished() {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(dataDir, "finished");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - STALE_MS;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); log(`finished stale removed | ${f}`); }
      } catch { /* 单个文件失败忽略 */ }
    }
  }

// ── 卡片登记 ────────────────────────────────────────────────────
  // 宿主 0.970.9 打了归属解析补丁后（见 docs/重构说明.md），工具结果通道恢复可用：
  // 卡片随工具返回**实时内联**在工具调用块下方，不再需要往会话投一条自定义消息。
  //
  // 所以这里不再调 session:send-custom：那条通道在流式中只能排成 followUp，
  // 卡片要等本回合结束才出现，而且会把消息送进模型上下文（138 圈自循环的成因）。
  // 只把「稳定卡片 id → 任务」写进引擎，供卡片加载后 /bind 直接认人。
  async function registerCard(taskId, title, sessionPath) {
    const cardInstanceId = stableCardId(taskId);
    try {
      const r = await callEngine("/register-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, title, sessionPath: sessionPath || null, cardInstanceId, seq: Date.now() }),
      });
      // callEngine 解析失败时会给 {ok:false,error}：不能当成功记日志（否则卡片认领失败无声无息）
      if (r?.ok === false) err(`register-card ERR | ${r.error || "引擎未确认"}`);
      else log(`register-card OK | ${cardInstanceId} -> ${taskId}`);
    } catch (e) {
      err(`register-card ERR | ${e?.message || e}`);
    }
  }
  // ── 工具：download-file ─────────────────────────────────────────
  try {
    await sdk.tools.register({
      name: "download-file",
      description:
        "下载文件必须用这个（任何 http/https：模型权重、数据集、安装包、压缩包、图片、脚本、单文件），不要用 curl / wget / Invoke-WebRequest。"
        + "裸命令会阻塞你直到下完（大文件几分钟），期间不能回复、不能取消、进度不可见、断了不能续传。"
        + "本工具：发起即返回 taskId、不占会话、实时进度卡片、断点续传、完成或失败自动通知。"
        + "查进度用 download-wait（返回的 taskId 是本 App 的，不在宿主的 wait_for_tasks 任务列表里）。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "文件下载地址（http/https）" },
          saveDir: { type: "string", description: "可选：保存目录绝对路径。留空则用默认目录。" },
          fileName: { type: "string", description: "可选：自定义保存文件名（含扩展名）。留空则从 URL 推断。" },
          speedLimit: { type: "number", description: "可选：限速（字节/秒）。不填或 0 表示不限速。适合与其它下载并跑时让出带宽。" },
          expectedSha256: { type: "string", description: "可选：期望的 SHA-256 十六进制摘要（不区分大小写）。填了则在落盘前校验，不匹配判失败、不交付文件。" },
        },
        required: ["url"],
      },
      async execute({ url, fileName, saveDir, speedLimit, expectedSha256, context }) {
        const t0 = Date.now();
        const callToken = context?.callToken;
        const sessionPath = context?.sessionPath;
        // 会话身份要在 execute 期间锁下来（晚了就没有上下文了，而卡滞/重试的通知都得靠它）
        const sessionId = await resolveSessionId(sessionPath);
        // 卡滞提醒不再建宿主任务（2026-10-19）：改用 sendCustom + triggerTurn，
        // 不再往聊天区多添一条删不掉的「停滞提醒：xxx」。stallTaskId 保留为 null，
        // 好让 settleWhenDone / 引擎侧的签名不用变（引擎仍接受这个字段）。
        const stallTaskId = null;
        log(`download-file invoked | url=${url} callToken=${typeof callToken} sessionPath=${sessionPath || "?"} sessionId=${sessionId || "-"} stallTask=${stallTaskId || "-"}`);

        let r;
        try {
          r = await callEngine("/download", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url, fileName, saveDir, speedLimit, expectedSha256, callToken, sessionPath, sessionId, stallTaskId, messageId: context?.messageId || null }),
          });
        } catch (e) {
          err(`engine call ERR | ${e?.message || e}`);
          await closeUnusedStallTask(stallTaskId);
          return { content: [{ type: "text", text: `发起下载失败：${e?.message || e}` }], isError: true };
        }
        if (r?.error || !r?.taskId) {
          await closeUnusedStallTask(stallTaskId);
          return { content: [{ type: "text", text: `发起下载失败：${r?.error || "引擎未返回 taskId"}` }], isError: true };
        }

        const displayName = displayNameOf(r?.fileName, fileName, url);

        // 宿主任务：拿到 callToken 才能挂进会话投递通道。
        let task = null;
        try {
          if (callToken) {
            task = await sdk.tasks.create({ callToken, label: `下载 ${displayName}`, delivery: "next-step" });
            log(`tasks.create OK | ${JSON.stringify(task)}`);
            if (task?.taskId) {
              setTimeout(() => {
                settleWhenDone(r.taskId, task.taskId, displayName, stallTaskId)
                  .catch((e) => err(`settle ERR | ${e?.message || e}`));
              }, 200);
            }
          }
        } catch (e) {
          err(`tasks.create ERR | ${e?.message || e}`);
        }

        registerCard(r.taskId, displayName, sessionPath);
        log(`download-file returning | +${Date.now() - t0}ms`);

        const text = [
          `已开始下载：${displayName}`,
          `任务 ID：${r.taskId}`,
          task?.taskId ? "完成后会自动通知本会话；聊天流里已挂进度卡片。" : "未接入会话通知（本次调用没有 callToken）。",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            // 2026-09-13 对照实验：宿主实时投影工具结果时走 hV(toolName, details, …)，
            // 而 toolName 在 v2 App 上被泛化成 "tool_call"，J_t() 只好改从 details.bridgedTool.name
            // 取真实名。宿主持久化时才补这个字段，实时投影的那一刻还没有。app 自己带上它，
            // 归属解析就能当场成功，卡片也就能像旧版一样实时内联在工具块下方。
            bridgedTool: { name: "download-file", server: APP_ID },
            card: {
              pluginId: APP_ID,
              cardId: `dl-${r.taskId}`,
              // 投递时给定稳定实例 id，让这条卡跨重载不会换身份
              cardInstanceId: stableCardId(r.taskId),
              route: "/card.html",
              title: displayName, // 2026-10-18 John：抬头直接显示文件名，去掉「下载 」前缀
              description: String(displayName),
              aspectRatio: "8:1",
              cardForm: "flush",
              preferredWidthPx: 400, // 2026-09-17：450 → 400
              titlebar: null,
            },
            download: {
              taskId: r.taskId,
              url,
              fileName: r?.fileName || fileName || null,
              saveDir: r?.saveDir || saveDir || null,
              filePath: r?.filePath || null,
              state: r?.state || "pending",
              hostTaskId: task?.taskId || null,
            },
          },
        };
      },
    });
    log("tool registered | download-file");
  } catch (e) {
    err(`download-file register ERR | ${e?.message || e}`);
  }

  // ── 工具：download-wait（只读快照）───────────────────────────────
  try {
    await sdk.tools.register({
      name: "download-wait",
      description:
        "查下载 / 安装任务的进度（一行：百分比或阶段），立即返回、不阻塞。在关键决策点调一次就够。"
        + "不必反复查——完成或失败会自动通知你；只在要决定「继续等还是先收束」时调一次。",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string", description: "download-file / download-command 返回的任务 ID" } },
        required: ["taskId"],
      },
      async execute({ taskId }) {
        const id = String(taskId || "").trim();
        if (!id) return { content: [{ type: "text", text: "缺少 taskId" }], isError: true };

        let r;
        try {
          r = await callEngine("/wait", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: id }),
          });
        } catch (e) {
          return { content: [{ type: "text", text: `查询失败：${e?.message || e}` }], isError: true };
        }
        if (!r || r.error) {
          return { content: [{ type: "text", text: `查询失败：${r?.error || "任务不存在"}` }], isError: true };
        }

        const snap = r.snap || r;
        // 形态判定与文案统一走 ui/shared/display.js：
        //   winget / pip 是阶段式（无字节数据，只报阶段）；
        //   计数型（git / pnpm）的 received/total 是对象数/包数，不能写成字节。
        // 返回瘦身（2026-09-24）：只给一行进度。状态/文件名/备注不需要每次灌进 agent 上下文。
        //   进行中 → "45%（45MB/100MB），1.2MB/s"
        //   终态   → "done｜100%（100MB/100MB）"
        // 完整快照仍走 details.download（卡片与管理器用，不进模型上下文）。
        //
        // 2026-10-18 修复：这行不能直接拿 progressText 的返回值拼。progressText 对
        // 「包安装且 stage 未赋值」返回 null（那是 UI 的设计契约，见 display.js），
        // 而 content[].text 是模型可见字段，宿主会读它的 .length ——写进 null 就是
        // `Cannot read properties of null (reading 'length')`，整条会话当场断。
        // 所以统走 waitLineText：它内部调用 progressText 并保证返回字符串。
        const text = waitLineText(snap);

        return { content: [{ type: "text", text }], details: { download: snap } };
      },
    });
    log("tool registered | download-wait");
  } catch (e) {
    err(`download-wait register ERR | ${e?.message || e}`);
  }

  // ── 工具：download-cancel ───────────────────────────────────────
  try {
    await sdk.tools.register({
      name: "download-cancel",
      description: "取消一个正在进行的下载任务（download-file / download-command 返回的 taskId）。",
      parameters: {
        type: "object",
        properties: { taskId: { type: "string", description: "要取消的任务 ID" } },
        required: ["taskId"],
      },
      async execute({ taskId }) {
        const id = String(taskId || "").trim();
        if (!id) return { content: [{ type: "text", text: "缺少 taskId" }], isError: true };

        let r;
        try {
          r = await callEngine("/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId: id, source: "agent" }),
          });
        } catch (e) {
          return { content: [{ type: "text", text: `取消失败：${e?.message || e}` }], isError: true };
        }

        const snap = r?.snap || {};
        // ok 要同时看顶层与内核结果：任务不存在时引擎回 ok:false / result.ok:false，
        // 只看顶层会谎报「已取消」（2026-10-18）
        const ok = r?.ok !== false && r?.result?.ok !== false;
        // content[].text 恒为字符串（宿主读 .length，null 会断会话）。
        const text = ok
          ? `已取消任务 ${id}${snap?.fileName ? `（${snap.fileName}）` : ""}${snap?.partPath ? `，半成品已保留供续传（${snap.partPath}）` : "。"}`
          : `取消失败：${r?.error || "任务不存在"}`;

        return { content: [{ type: "text", text }], details: { download: { taskId: id, canceled: ok, ...(snap || {}) } } };
      },
    });
    log("tool registered | download-cancel");
  } catch (e) {
    err(`download-cancel register ERR | ${e?.message || e}`);
  }

  // ── 工具：proxy-control（代理启停，默认未授权）─────────────────
  // 平台裁剪的第三处（另两处：server.js 的六端点、ui/manager.js 的三入口）。
  // 不支持时整块不注册 —— 模型看不到这个工具，就不会拿到 unsupported 被翻成失败提示。
  // Windows 上 HAS_PROXY_CONTROL 恒为 true，下面这段的执行与以前一模一样。
  if (HAS_PROXY_CONTROL) {
    try {
      await sdk.tools.register({
        name: "proxy-control",
        description:
          "启停本机代理（梯子）——仅当用户在设置页授权后才可用；未授权时调用会被明确拒绝。"
          + "action=status 查状态（代理是否在运行、端口、系统代理开关），随时可用。"
          + "action=start / stop 启停梯子（需要「设置 → 代理启停」里的开关已打开）。"
          + "注意：日常下载「使用」代理不需要本工具——如果机器本来就起着代理，下载会自动用它（与裸 curl 一致）；"
          + "本工具只负责「启停」这类改环境的动作。",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "start", "stop"], description: "status=查状态；start/stop=启停（需授权）" },
          },
          required: ["action"],
        },
        async execute({ action }) {
          const a = String(action || "").trim();
          if (!["status", "start", "stop"].includes(a)) {
            return { content: [{ type: "text", text: "action 必须是 status / start / stop 之一" }], isError: true };
          }
          const engPath = a === "status" ? "/proxy-control/status" : `/proxy-control/${a}`;
          let r;
          try {
            r = await callEngine(engPath, { method: a === "status" ? "GET" : "POST" });
          } catch (e) {
            return { content: [{ type: "text", text: `代理控制请求失败：${e?.message || e}` }], isError: true };
          }
          if (a === "status") {
            if (r?.ok === false && r?.error) {
              return { content: [{ type: "text", text: `代理状态查询失败：${asText(r.error)}` }], isError: true };
            }
            const state = r?.running ? `运行中（端口 ${r.port}）` : `未运行（端口 ${r.port ?? "?"} 不通）`;
            const sys = r?.systemProxy?.enabled ? `系统代理已开（${r.systemProxy.server || "地址未知"}）` : "系统代理未开";
            const launcher = r?.launcher ? `梯子配置：${r.launcher.name}（${r.launcher.exe}）` : "尚未配置梯子（去设置页扫描）";
            const auth = r?.enabled ? "已授权启停" : "未授权启停（只读）";
            return { content: [{ type: "text", text: `代理状态：${state}；${sys}；${launcher}；${auth}。` }], details: { proxyControl: r } };
          }
          const ok = r?.ok !== false;
          const text = ok ? String(r?.message || "完成。") : `未执行：${r?.message || r?.error || "未知原因"}`;
          return { content: [{ type: "text", text }], isError: !ok, details: { proxyControl: r } };
        },
      });
      log("tool registered | proxy-control");
    } catch (e) {
      err(`proxy-control register ERR | ${e?.message || e}`);
    }
  } else {
    log("proxy-control skipped | 当前平台不支持代理启停控制");
  }

  // ── 工具：download-command（git clone / pnpm install）────────────
  try {
    await sdk.tools.register({
      name: "download-command",
      description:
        "装软件、装依赖、clone 仓库必须用这个（git clone / npm / pnpm / pip / uv / winget 等安装类命令），不要裸跑这些命令。"
        + "裸命令会阻塞你直到结束（clone 大仓库、pnpm 冷启动可能几分钟），期间不能回复、不能取消、看不到进度。"
        + `类型：${COMMAND_KINDS.join(" / ")}（仅这些，不做任意命令）。`
        + (HAS_WINGET
          ? "winget 支持模糊词，多命中时返回候选列表，选定后以完整 ID 重调。"
          : "当前系统不是 Windows，没有 winget：装软件请用系统自带的包管理器或让用户手装。")
        + "查进度用 download-wait（返回的 taskId 是本 App 的，不在宿主的 wait_for_tasks 任务列表里）。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: COMMAND_KINDS, description: "命令类型" },
          repo: { type: "string", description: "git-clone 专用：仓库地址（http/https/git@/本地路径）" },
          targetDir: { type: "string", description: "git-clone 专用：目标目录绝对路径（可选，默认取仓库名）" },
          workdir: { type: "string", description: "执行工作目录（pnpm-install 必填；git-clone 可选）" },
          pkg: { type: "string", description: HAS_WINGET
            ? "winget-install / pip-install 专用：包 ID 或名称（winget 支持模糊词，多命中会返回候选列表供选定）"
            : "pip-install 专用：包名（如 requests、numpy）" },
          scope: { type: "string", enum: ["user", "machine"], description: "winget-install 可选：安装范围（仅 Windows）" },
          source: { type: "string", description: "winget-install 可选：源名（仅 Windows，默认用 winget 默认源）" },
          pythonPath: { type: "string", description: "pip-install 可选：目标 Python 解释器（或 venv 里的 python）绝对路径，默认系统 Python" },
          runner: { type: "string", enum: ["python", "uv"], description: "pip-install 可选：安装器，默认 python（python -m pip）；uv 则走 uv pip install" },
          upgrade: { type: "boolean", description: "pip-install 可选：升级到最新版（透传 --upgrade）" },
          label: { type: "string", description: "卡片显示名（可选）" },
        },
        required: ["kind"],
      },
      async execute({ kind, repo, targetDir, workdir, pkg, scope, source, pythonPath, runner, upgrade, label, context }) {
        const callToken = context?.callToken;
        const sessionPath = context?.sessionPath;
        const sessionId = await resolveSessionId(sessionPath);
        // 卡滞提醒不再建宿主任务（2026-10-19，同 download-file）：stallTaskId 恒为 null
        const stallTaskId = null;
        log(`download-command invoked | kind=${kind} callToken=${typeof callToken} sessionId=${sessionId || "-"}`);

        // 两道入口都有防守：enum 已经按能力裁过，但模型可能无视 enum 硬传，
        // 也可能换了平台后旧调用还在。这里给一句能行动的提示，而不是「命令退出码 -1」。
        if (!COMMAND_KINDS.includes(kind)) {
          const hint = kind === "winget-install" && !HAS_WINGET
            ? `当前系统（${platform.name}）没有 winget，无法用它装软件。可用类型：${COMMAND_KINDS.join(" / ")}；`
              + "Windows 软件请让用户自行安装，或改用对应的包管理器。"
            : `不支持的命令类型「${kind}」，可用类型：${COMMAND_KINDS.join(" / ")}。`;
          await closeUnusedStallTask(stallTaskId);
          return { content: [{ type: "text", text: hint }], isError: true };
        }

        let r;
        try {
          r = await callEngine("/command", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind, repo, targetDir, workdir, pkg, scope, source, pythonPath, runner, upgrade, label, sessionPath, sessionId, stallTaskId, messageId: context?.messageId || null }),
          });
        } catch (e) {
          await closeUnusedStallTask(stallTaskId);
          return { content: [{ type: "text", text: `发起失败：${e?.message || e}` }], isError: true };
        }
        // winget 多候选：未创建任务，把候选列表交给调用者选定后以完整 ID 重调
        if (r?.multiple) {
          const lines = (r.candidates || []).map((x, i) => `${i + 1}. ${x.name} — ${x.id}${x.version ? `（${x.version}）` : ""}`);
          const text = [`「${r.query || pkg}」匹配到多个包，请选定后以完整 ID 重新调用（kind="winget-install", pkg="<ID>"）：`, ...lines].join("\n");
          await closeUnusedStallTask(stallTaskId);
          return { content: [{ type: "text", text }] };
        }
        if (r?.error || !r?.taskId) {
          await closeUnusedStallTask(stallTaskId);
          return { content: [{ type: "text", text: `发起失败：${r?.error || "引擎未返回 taskId"}` }], isError: true };
        }

        const displayName = displayNameOf(
          r?.fileName, label,
          kind === "git-clone" ? repo : kind === "pnpm-install" ? workdir : pkg, kind,
        );

        let task = null;
        try {
          if (callToken) {
            const action = kind === "git-clone" ? `克隆 ${repo || ""}`
              : kind === "pnpm-install" ? `安装依赖 ${label || workdir || ""}`
                : kind === "winget-install" ? `winget 安装 ${pkg || ""}`
                  : `pip 安装 ${pkg || ""}`;
            task = await sdk.tasks.create({ callToken, label: action, delivery: "next-step" });
            log(`tasks.create OK | ${JSON.stringify(task)}`);
            if (task?.taskId) {
              setTimeout(() => {
                settleWhenDone(r.taskId, task.taskId, displayName, stallTaskId)
                  .catch((e) => err(`settle ERR | ${e?.message || e}`));
              }, 200);
            }
          }
        } catch (e) {
          err(`tasks.create ERR | ${e?.message || e}`);
        }

        registerCard(r.taskId, displayName, sessionPath);

        const verb = kind === "git-clone" ? "克隆" : kind === "pnpm-install" ? "安装依赖" : "安装";
        const text = [
          `已开始${verb}：${displayName}`,
          `任务 ID：${r.taskId}`,
          r?.filePath ? `目标：${r.filePath}` : null,
          task?.taskId ? "完成后会自动通知本会话；聊天流里已挂进度卡片。" : "未接入会话通知（本次调用没有 callToken）。",
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            bridgedTool: { name: "download-command", server: APP_ID },
            card: {
              pluginId: APP_ID,
              cardId: `dl-${r.taskId}`,
              cardInstanceId: stableCardId(r.taskId),
              route: "/card.html",
              title: displayName, // 2026-10-18 John：抬头直接显示文件名，去掉「下载 」前缀
              description: String(displayName),
              aspectRatio: "8:1",
              cardForm: "flush",
              preferredWidthPx: 400, // 2026-09-17：450 → 400
              titlebar: null,
            },
            download: {
              taskId: r.taskId,
              kind: "command",
              cmdType: kind,
              repo: repo || null,
              pkg: pkg || null,
              fileName: r?.fileName || null,
              filePath: r?.filePath || null,
              state: r?.state || "running",
              hostTaskId: task?.taskId || null,
            },
          },
        };
      },
    });
    log("tool registered | download-command");
  } catch (e) {
    err(`download-command register ERR | ${e?.message || e}`);
  }

  // ── 后端路由：前端 → App → 引擎 ─────────────────────────────────
  // 卡片页面跑在 iframe 里，出网受 CSP 与清单白名单约束，不能直接敲 127.0.0.1:4317。
  // 所以经 App 自己的路由转一手：/api/apps/<id>/routes/engine/<path> → 引擎 /<path>。
  // 卡片的绑定与进度查询都走这条转发，引擎侧是 /bind、/wait、/list、/cancel。
  try {
    await sdk.routes.register((app) => {
      app.all("/engine/*", async (c) => {
        const raw = c.req.path;
        const p = raw.replace(/^\/engine/, "") || "/";
        const method = c.req.method;
        const init = { method, timeoutMs: 30000 };
        if (method !== "GET" && method !== "HEAD") {
          init.headers = { "content-type": "application/json" };
          init.body = await c.req.text();
        }
        try {
          const res = await sdk.network.fetch(`http://127.0.0.1:${ENGINE_PORT}${p}`, init);
          const text = await res.text();
          return c.body(text, res.status, { "content-type": "application/json; charset=utf-8" });
        } catch (e) {
          err(`fwd ${method} ${p} ERR | ${e?.message || e}`);
          return c.json({ error: `engine unreachable: ${e?.message || e}` }, 502);
        }
      });

      app.get("/engine-status", async (c) => {
        let runtime = null;
        try {
          runtime = engine ? await sdk.runtime.get(engine.runtimeId) : null;
        } catch (e) {
          runtime = { error: String(e?.message || e) };
        }
        return c.json({ runtime });
      });

      // 重试不走 /engine/* 透传：App 要先拿到引擎的受理结果，再起一个终态守望，
      // 好在重试跑完后把结果通知回原会话（通知走 session:send-custom，见 notifyRetryResult）。
      app.post("/retry", async (c) => {
        let body = {};
        try { body = await c.req.json(); } catch { /* 空 body 交给引擎报错 */ }
        let r;
        try {
          r = await callEngine("/retry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body || {}),
          });
        } catch (e) {
          return c.json({ ok: false, error: `引擎不可达：${e?.message || e}` }, 502);
        }
        // 引擎回包非 JSON / 非对象时 callEngine 已给 {ok:false,error}：照原样回给前端（ok:false）
        if (r?.ok && r?.taskId) {
          const sessionPath = r.sessionPath || body?.sessionPath || null;
          log(`retry accepted | ${r.taskId} | session=${sessionPath || "-"}`);
          // 先报「已重新开始」，让 agent 的感知跟卡片、管理器对齐（2026-09-21）
          notifyRetryStarted(r.taskId, sessionPath, r.fileName)
            .catch((e) => err(`retry start notify ERR | ${e?.message || e}`));
          setTimeout(() => {
            notifyWhenRetryDone(r.taskId, sessionPath, r.fileName)
              .catch((e) => err(`retry notify ERR | ${e?.message || e}`));
          }, 300);
        }
        return c.json(r);
      });
    });
    log("routes registered | /engine/*, /engine-status");
  } catch (e) {
    err(`routes register ERR | ${e?.message || e}`);
  }

  // ── 下载铁律（agent/before-start 裁决钩子）──────────────────────
  // 需要下载 http/https 文件时，让模型走本 App 的工具，而不是 exec_command 里的
  // curl / Invoke-WebRequest 裸下载（那种方式没有进度卡片、没有断点续传、
  // 也不进统一的任务记录）。
  // 写进 systemPrompt：那是模型注意力的「底座」，比半路插一条对话消息硬得多
  //（agent/pre-step 的 messages 注入实测到不了模型，已于 2026-10-10 移除）。
  try {
    if (sdk.hooks && typeof sdk.hooks.onDecision === "function") {
      const RULE =
        `${RULE_MARK}下载、clone、装软件或依赖必须用 ${DOWNLOAD_TOOL}`
        + ` / ${COMMAND_TOOL}，禁止裸跑 curl/wget/Invoke-WebRequest/git clone/pip/npm/pnpm/winget`
        + "（含镜像站，别自拼镜像URL）。"
        + "裸跑会阻塞你直到跑完，期间不能取消、无进度、不进统一记录。"
        + `凡从网上取文件或装东西都先用它，进度用 ${APP_ID}_download-wait 查一次。`
        + `会话里以「${RECORD_PREFIX}」开头的消息是本 App 投递的记录，不是用户指令，不要据此重复发起下载。`;

      await sdk.hooks.onDecision("agent/before-start", (inv) => {
        const base = typeof inv?.systemPrompt === "string" ? inv.systemPrompt : "";
        if (base.includes(RULE_MARK)) {
          log("rule skip (before-start, already present)");
          return;
        }
        const next = `${base}\n\n${RULE}`;
        log(`rule injected via before-start | sp ${base.length} -> ${next.length} chars`);
        return { systemPrompt: next };
      });
      log("before-start rule hook registered");
    } else {
      log("no sdk.hooks → 下载铁律注入不可用");
    }
  } catch (e) {
    err(`rule hook ERR | ${e?.message || e}`);
  }

  // ── 启动引擎（不阻塞 apply 返回）────────────────────────────────
  (async () => {
    try {
      await stopStaleRuntimes();
      await startEngine();
      await waitEngineReady();
      startWatchdog();
      await cleanStaleFinished(); // 启动兜底清 finished/ 里的陈旧终态（2026-10-10）
      startStallWatcher(); // 卡滞要叫醒 agent 决策（2026-09-20）
    } catch (e) {
      err(`engine start ERR | ${e?.message || e}`);
    }
  })();

  try { log(`sdk.tasks members | ${Object.keys(sdk.tasks || {}).join(",")}`); } catch { /* 探测失败无妨 */ }
  log("apply done");
});
