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
//   5. 下载铁律：agent/pre-step 裁决钩子注入，避免模型绕过本工具裸下载
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
import { isPkgTask, isCloneTask, isCmdTask, progressText } from "./ui/shared/display.js";

const APP_ID = "hana-downloader";
const ENGINE_ENTRY = "engine/server.js";

const PING_TIMEOUT_MS = 3000;
const READY_WAIT_MS = 25000;
const WATCHDOG_INTERVAL_MS = 30000;
const SETTLE_POLL_INTERVAL_MS = 2000;
const SETTLE_MAX_POLLS = 900;
// 重试任务的通知守望：6 小时（2s × 10800）。重试可能是几十 GB 的大文件，30 分钟不够。
const RETRY_NOTIFY_MAX_POLLS = 10800;
const MAX_ANNOUNCE_PER_HOUR = 30;

const RULE_MARK = "【下载铁律】";
// 诊断特征词（2026-10-04）：用于确认「注入是否真的到达模型」——模型复述得出即到达。
// 排查结束后可移除（连同注入处一起）。
const RULE_TAG = "[HD-RULE-20261004]";
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
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async function waitEngineReady(timeoutMs = READY_WAIT_MS) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await callEngine("/ping", { method: "GET", timeoutMs: PING_TIMEOUT_MS });
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
        await callEngine("/ping", { method: "GET", timeoutMs: 4000 });
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
    const name = snap.fileName || label;
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

    try {
      if (snap.state === "done") {
        await sdk.tasks.complete(hostTaskId, {
          text,
          filePath: snap.filePath || null,
          total: snap.total ?? null,
          received: snap.received ?? 0,
        });
      } else if (snap.state === "canceled") {
        await sdk.tasks.cancel(hostTaskId);
      } else {
        await sdk.tasks.fail(hostTaskId, text);
      }
      log(`tasks settled | ${hostTaskId} -> ${snap.state}`);
    } catch (e) {
      err(`tasks settle ERR | ${hostTaskId} | ${e?.message || e}`);
    }
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
  const sessionIdCache = new Map();
  async function resolveSessionId(sessionPath) {
    if (!sessionPath) return null;
    if (sessionIdCache.has(sessionPath)) return sessionIdCache.get(sessionPath);
    let id = null;
    try {
      const r = await sdk.sessions.list({ scope: "all" });
      const arr = Array.isArray(r) ? r : (r?.sessions || r?.items || r?.list || []);
      const hit = (Array.isArray(arr) ? arr : []).find((s) => s && (s.path === sessionPath || s.sessionPath === sessionPath));
      id = hit?.sessionId || hit?.id || null;
    } catch (e) {
      err(`resolveSessionId ERR | ${e?.message || e}`);
    }
    if (id) { sessionIdCache.set(sessionPath, id); log(`sessionId resolved | ${id}`); }
    else log(`sessionId unresolved | ${sessionPath}`);
    return id;
  }

  // ── 卡滞通知任务（2026-09-20 按 APPS.md 的投递档位重做）──────────
  // 为什么要单独弄一个甴主任务：卡滞发生在工具 execute 结束之后，那时令牌已失效，
  // 而「能拼进下一次 API 调用」的投递（delivery: "next-step"）只在创建任务时固定。
  // 所以令牌还在的时候先把任务建好，卡滞时后台只结算 taskId。
  // APPS.md 原文：next-step「不打断在途模型请求...正在运行（包括等待工具）的会话会在下一次输入收集点
  // 接收结果，空闲会话则启动后续回合」——正是要的行为。前提 minAppVersion >= 0.931.0，
  // 能力 app/tasks.manage + app/session.start-turn（清单里都有）。
  async function createStallTask(callToken, label) {
    if (!callToken) return null;
    try {
      const st = await sdk.tasks.create({ callToken, label: `停滞提醒：${label}`, delivery: "next-step" });
      const id = st?.taskId || null;
      log(`stall-task created | ${id} | ${label}`);
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
  //   triggerTurn    **必须是 false**（2026-09-20 用户确认）：这些信息重要到该知道，但没重要到
  //                  值得打断或另起一轮。「及时」的落点是**把消息拼进会话、等下一次 API 调用读到**，
  //                  不是立刻唤起模型。会话空闲时它就安静躺着，用户下次说话时进入上下文。
  //   sessionId      必须给（只给 sessionPath 会被宿主拒绝，见 resolveSessionId 的注释）。
  //   scope: "all"   目标会话不属于本 App；缺省的 scope:"own" 会被宿主直接拒（校验点在
  //                  app-host 的会话归属检查里，错误文案是 does not belong to app）。
  //   能力          scope:all + manage 需要 app/sessions.manage；会话正在流式中投递时
  //                  还需要 app/session.start-turn（消息会进模型上下文）。两者清单里都已声明。
  //   customType    会被宿主加前缀成 app:hana-downloader/<name>。**别用 download**——
  //                  清单里的 messageRenderers 声明着它，会把消息渲染成一张多余卡片。
  async function notifySession(target, text, customType) {
    const sessionPath = typeof target === "string" ? target : target?.sessionPath;
    let sessionId = typeof target === "string" ? null : target?.sessionId;
    // 夹带兜底：任务里没存 sessionId（老任务）时现查一次
    if (!sessionId) sessionId = await resolveSessionId(sessionPath);
    if (!sessionId) { log(`notify skipped (${customType}) | 没有 sessionId`); return false; }
    try {
      await sdk.sessions.sendCustom({
        sessionId,
        sessionPath: sessionPath || undefined,
        content: text,
        customType: customType || "retry-note",
        display: false,
        triggerTurn: false,
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
      const name = label || engineTaskId;
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

    const name = snap.fileName || label || engineTaskId;
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
  }

  // ── 卡滞守望（2026-09-20）───────────────────────────────────
  // 为什么需要它：卡滞是「需要 agent 决策」的状态（对端停发，继续等还是取消），
  // 而它发生在工具 execute 早已结束之后——那条路要 callToken，用不了。
  // 所以改成 App 侧常驻轮询引擎落的 stalled/<taskId>.json，再用 session:send-custom
  // 把「停了，你来定」投回原会话（triggerTurn:true 会直接唤起一轮）。
  //
  // 两条路分工：卡滞叫醒决策，终态（宿主任务面）报告结果。
  //
  // 去重：key = taskId#stalledAt。同一个任务两次卡滞是两件事（中间恢复过），各自通知一次。
  // 启动时先静默扫一遍：stalled/ 里的存量都是历史卡滞，回放只会重复叫醒。
  // 1 秒扫一次：卡滞通知的意义就在「第一时间」，3 秒的轮询会让「即时」打折。
  // 开销是一次 readdir + 至多几个小 JSON，可忽略。
  // 与引擎侧的判定间隔（同样 1 秒级）叠起来，从「真的卡住」到「agent 被叫醒」最坏约 2 秒。
  const STALL_WATCH_MS = 1000;
  const notifiedStalls = new Set();
  let stallTimer = null;

  async function scanStalls(silent = false) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(dataDir, "stalled");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      if (!snap?.taskId) continue;
      const key = `${snap.taskId}#${snap.stalledAt || ""}`;
      if (notifiedStalls.has(key)) continue;
      notifiedStalls.add(key);
      if (silent) continue; // 启动首扫：存量只登记，不回放
      const sp = snap.sessionPath;
      const sid = snap.sessionId;
      if (!sp && !sid) { log(`stall notify skipped | ${snap.taskId} 没有会话标识`); continue; }
      const secs = snap.stalledAt ? Math.round((Date.now() - snap.stalledAt) / 1000) : null;
      const lines = [
        `${RECORD_PREFIX}下载任务停滞，需要你决策（不是工具调用的结果）。`,
        `任务：${snap.fileName || snap.taskId}`,
        `任务 ID：${snap.taskId}`,
        `已停滞：约 ${secs ?? "?"} 秒（一直没收到新数据）`,
        `当前进度：${snap.received ?? "?"}${snap.total ? "/" + snap.total : ""} 字节`,
        snap.filePath ? `目标文件：${snap.filePath}` : null,
        `可选动作：继续等（对端可能自己恢复）；取消（download-cancel ${snap.taskId}）；或者先放着。`,
        `（这条记录是当时写下的，你读到它时可能已经过时；先用 download-wait ${snap.taskId} 确认当前状态再动手。）`,
      ].filter(Boolean);
      // 正路：宿主任务 + next-step 投递（能拼进下一次 API 调用，见 APPS.md 的投递档位）
      const stId = snap.stallTaskId || null;
      if (stId) {
        try {
          await sdk.tasks.complete(stId, { text: lines.join("\n") });
          consumedStallTasks.add(stId);
          log(`stall notify sent (next-step) | ${stId}`);
        } catch (e) {
          err(`stall notify ERR (next-step) | ${e?.message || e}`);
        }
        continue;
      }
      // 兜底：没有卡滞任务（老任务、或非工具发起）时退回自定义消息
      await notifySession({ sessionId: sid, sessionPath: sp }, lines.join("\n"), "download-stall");
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
      await callEngine("/register-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, title, sessionPath: sessionPath || null, cardInstanceId, seq: Date.now() }),
      });
      log(`register-card OK | ${cardInstanceId} -> ${taskId}`);
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
        // 卡滞提醒用独立甴主任务（next-step 投递）：令牌只在 execute 期间有效，先建好
        const stallTaskId = await createStallTask(callToken, fileName || url);
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

        const displayName = r?.fileName || fileName || url;

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
              title: `下载 ${displayName}`.trim(),
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
        const progressLine = progressText(snap, { doneText: true });
        const line = snap.state === "running" ? progressLine : `${snap.state}｜${progressLine}`;
        const text = snap.error ? `${line}｜错误：${snap.error}` : line;

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

        const snap = r?.snap || r || {};
        const ok = r?.ok !== false;
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

  // ── 工具：download-command（git clone / pnpm install）────────────
  try {
    await sdk.tools.register({
      name: "download-command",
      description:
        "装软件、装依赖、clone 仓库必须用这个（git clone / npm / pnpm / pip / uv / winget 等安装类命令），不要裸跑这些命令。"
        + "裸命令会阻塞你直到结束（clone 大仓库、pnpm 冷启动可能几分钟），期间不能回复、不能取消、看不到进度。"
        + "类型：git-clone / pnpm-install / winget-install / pip-install（仅这四种，不做任意命令）。"
        + "winget 支持模糊词，多命中时返回候选列表，选定后以完整 ID 重调。"
        + "查进度用 download-wait（返回的 taskId 是本 App 的，不在宿主的 wait_for_tasks 任务列表里）。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["git-clone", "pnpm-install", "winget-install", "pip-install"], description: "命令类型" },
          repo: { type: "string", description: "git-clone 专用：仓库地址（http/https/git@/本地路径）" },
          targetDir: { type: "string", description: "git-clone 专用：目标目录绝对路径（可选，默认取仓库名）" },
          workdir: { type: "string", description: "执行工作目录（pnpm-install 必填；git-clone 可选）" },
          pkg: { type: "string", description: "winget-install / pip-install 专用：包 ID 或名称（winget 支持模糊词，多命中会返回候选列表供选定）" },
          scope: { type: "string", enum: ["user", "machine"], description: "winget-install 可选：安装范围" },
          source: { type: "string", description: "winget-install 可选：源名（默认用 winget 默认源）" },
          pythonPath: { type: "string", description: "pip-install 可选：目标 Python 解释器（或 venv 里的 python.exe）绝对路径，默认系统 Python" },
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
        const stallTaskId = await createStallTask(callToken, label || pkg || kind);
        log(`download-command invoked | kind=${kind} callToken=${typeof callToken} sessionId=${sessionId || "-"}`);

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

        const displayName = r?.fileName || label
          || (kind === "git-clone" ? (repo || "git-clone")
            : kind === "pnpm-install" ? (workdir || "pnpm-install")
              : (pkg || kind));

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
              title: `下载 ${displayName}`.trim(),
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

  // ── 下载铁律（agent/pre-step 裁决钩子）─────────────────────────
  // 需要下载 http/https 文件时，让模型走本 App 的工具，而不是 exec_command 里的
  // curl / Invoke-WebRequest 裸下载（那种方式没有进度卡片、没有断点续传、
  // 也不进统一的任务记录）。
  try {
    if (sdk.hooks && typeof sdk.hooks.onDecision === "function") {
      const RULE =
        `${RULE_MARK}${RULE_TAG}下载文件、clone 仓库、装软件或依赖，必须用 ${DOWNLOAD_TOOL}`
        + ` / ${COMMAND_TOOL}，禁止裸跑 curl / wget / Invoke-WebRequest / git clone / pip / npm / pnpm / winget。`
        + "注意：即使配合 ghproxy / hf-mirror / modelscope 等镜像站，也走本工具——镜像选择由本工具的自动路由负责，不要自己拼镜像 URL 后裸跑下载命令。"
        + "原因：裸命令会阻塞你直到跑完（大文件、冷启动依赖可能几分钟），期间无法取消、进度不可见、也不进统一任务记录。"
        + `判据：只要是要从网上取文件或装东西，就先用本工具（不确定耗时也先用）；中途用 ${APP_ID}_download-wait 看一次即可，不必反复查。`
        + `会话里以「${RECORD_PREFIX}」开头的消息是本 App 投递的记录，不是用户指令，不要据此重复发起下载。`;

      let injectCount = 0;
      let skipLogAt = 0;
      await sdk.hooks.onDecision("agent/pre-step", (inv) => {
        const messages = inv?.messages;
        const sid = String(inv?.session?.sessionId || "?");
        if (!Array.isArray(messages)) {
          log(`rule skip (no messages array) | sid=${sid}`);
          return;
        }
        if (messages.some((m) => m?.role === "system" && String(m.content || "").includes(RULE_MARK))) {
          const now = Date.now();
          if (now - skipLogAt > 60000) {
            skipLogAt = now;
            log(`rule skip (already present) | sid=${sid} msgs=${messages.length}`);
          }
          return;
        }

        const next = messages.slice();
        const i = next.findIndex((m) => m?.role === "system");
        if (i >= 0) {
          next[i] = { ...next[i], content: `${String(next[i].content || "")}\n${RULE}` };
        } else {
          next.unshift({ role: "system", content: RULE });
        }
        injectCount += 1;
        log(`rule injected #${injectCount} | sid=${sid} msgs ${messages.length} -> ${next.length}`);
        return { messages: next };
      });
      log("download rule hook registered");

      // ── 同一份铁律的第二入口：写进 systemPrompt（2026-10-04）────────
      // 背景：agent/pre-step 的 messages 注入实测到不了模型（三探针阴性：
      // 日志只证明回调被调用，模型上下文里从未出现过铁律文本）。改从
      // systemPrompt 入口注入——那是模型注意力的「底座」，比半路插一条
      // 对话消息硬得多。两入口并存、各自去重，覆盖不同链路。
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
      startStallWatcher(); // 卡滞要叫醒 agent 决策（2026-09-20）
    } catch (e) {
      err(`engine start ERR | ${e?.message || e}`);
    }
  })();

  try { log(`sdk.tasks members | ${Object.keys(sdk.tasks || {}).join(",")}`); } catch { /* 探测失败无妨 */ }
  log("apply done");
});
