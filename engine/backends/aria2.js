// engine/backends/aria2.js — aria2 受管实例 backend（JSON-RPC）
//
// 设计（2026-10-18，W2）：
//   · **受管实例**：由本进程 spawn 一个 aria2c，自己选端口、自己生成 RPC secret、
//     只关自己 spawn 出来的那个 ChildProcess。绝不 `taskkill aria2c.exe` / `pkill aria2c`。
//   · **传输归 backend，生命周期归 dlcore**：这里只把字节弄到磁盘并写 task 的传输字段。
//
// 三条硬规则（都来自上一轮的血泪教训）：
//   1. 进度只信 RPC 的 completedLength。aria2 会预分配文件长度，`.part` 的文件大小在
//      多段下载时是假的（实测 1MB 的 .part、completedLength 才 300KB）。绝不 statSync 当进度。
//   2. `complete` **不等于** done。aria2 报 complete 只说明它认为传完了；交付前必须做内容级
//      校验（有 expectedSha256 就比对 SHA-256，另外再核字节数），通过后才把 .part 改名交付。
//      「state === done」不等于「文件正确」——这条上一轮用真金白银换来的。
//   3. 失败一律如实：RPC 失联、提交结果不明、取消未确认 —— 保持未完成并写 error，绝不假报成功。
//
// 并发：dlcore 是唯一的并发权威。这里不做第二个调度器——每次 addUri 前把 aria2 的
// max-concurrent-downloads 抬到「本 backend 当前在跑的任务数」，保证 aria2 永远不会
// 因为自己的队列上限把某个任务干晾着（否则 dlcore 的停滞监视会误报）。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { deliverPartFile, validateContext } from "./contract.js";
import { platform } from "../platform/index.mjs";

const NAME = "aria2";
const POLL_MS = 600;            // 轮询节拍（与 dlcore 的 SPEED_SAMPLE_MS=700 同量级）
const SPEED_SAMPLE_MS = 700;    // 测速采样窗口
const SPEED_SAMPLES_MAX = 5;    // 滑动窗口样本数（≈3.5s）
// 进度节流落盘间隔（与 node-http 同口径，1.5s ≈ 每 2 秒一次）。
// 为什么要落盘：进度原先只在内存里，引擎被硬杀后重启，restore 只能读到 0 或很早的值，
// 用户看到两小时的下载从 0 重来（文件其实还在盘上）。
const PERSIST_INTERVAL_MS = 1500;
const START_TIMEOUT_MS = 12000; // 起实例 + 首次握手的总预算
const RPC_TIMEOUT_MS = 8000;    // 单次 RPC 超时
const POLL_FAIL_LIMIT = 8;      // 连续轮询失败次数上限（≈5s）后判定 RPC 失联
const DEFAULT_BASE_PORT = 6802;
const PORT_SPAN = 8;            // 6802..6810
// 能力探测缓存（2026-10-19 修）：成功结果长时间有效，失败结果仍然只留 5s。
// 为什么分开：用户点一次开关就够了，不该每次开管理器都重跑一遍「找 exe → 起实例 → RPC 握手」。
// 为什么失败不能长留（踩坑 49）：用户刚装好 aria2 就必须马上能识别，不能等缓存过期、更不能重启。
const DETECT_POSITIVE_TTL_MS = 10 * 60 * 1000;
const DETECT_NEGATIVE_TTL_MS = 5000;
const INSTANCE_FILE = "aria2-instance.json";
const FEATURES = ["resume", "sha256", "cancel", "proxy", "speed-limit", "multi-connection"];

// ── 模块态：一个引擎进程只养一个受管实例（dlcore 单例，够用且省端口）──
const state = {
  proc: null,          // 本进程 spawn 的 ChildProcess（只有它才允许 kill）
  adopted: false,      // true = 复用上一条进程留下的实例（不持有 handle，不 kill）
  port: 0,
  secret: "",
  bin: "",
  version: null,
  ready: false,
  dataDir: "",
  recordPath: "",
  // 选项（由 dlcore 从 engine-config.json 灌入）
  options: { bin: "", port: DEFAULT_BASE_PORT },
  adoptedPid: 0,       // adopted 实例的 pid（没 handle，只能靠 pid 探活）
  activeTasks: 0,      // 本 backend 当前在跑的任务数（并发对齐 aria2 用）
  // capabilities() 的探测缓存。ok: true=成功结果 / false=失败结果 / null=未落定或探测中
  detection: { at: 0, value: null, ok: null },
  probes: 0,           // 真实跑过的探测次数（只给诊断/测试看，缓存命中不增）
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// 纯函数（单测直接打这些，不需要真 aria2）
// ════════════════════════════════════════════════════════════

/**
 * aria2 状态 → dlcore 语义。
 *
 * **complete 刻意不映射成 done**：aria2 的 complete 只是「它的传输结束了」，
 * 交付判定必须由归一的收尾流程（内容级校验）给出。这里返回 "complete"，
 * 由 run() 走 deliverPartFile 决定 done / failed。
 *
 * 注：waiting / paused 在 run() 里**不会**把 task.state 降级成 pending——
 * dlcore 用 state==="running" 数并发槽位，降级会让 _pumpQueue 多放行任务。
 * 运行中一律保持 running，aria2 的真实状态记在 task.aria2Status 上。
 *
 * @param {string} status aria2 的 status 字段
 * @returns {"running"|"pending"|"complete"|"failed"|"canceled"|"unknown"}
 */
export function mapAria2Status(status) {
  switch (String(status || "").toLowerCase()) {
    case "active": return "running";
    case "waiting": return "pending";
    case "paused": return "pending";
    case "complete": return "complete"; // ← 不是 done：等内容校验
    case "error": return "failed";
    case "removed": return "canceled";
    default: return "unknown";
  }
}

/**
 * 进度映射：只有 RPC 的 completedLength / totalLength / downloadSpeed 可信。
 * aria2 的字段都是字符串，必须转数字；非法值给 0/null 而不是 NaN。
 *
 * @param {object} st tellStatus 的 result
 * @returns {{received:number, total:number|null, speed:number}}
 */
export function mapProgress(st) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const received = num(st?.completedLength) ?? 0;
  const rawTotal = num(st?.totalLength);
  const total = rawTotal != null && rawTotal > 0 ? rawTotal : null;
  const speed = num(st?.downloadSpeed) ?? 0;
  return {
    // 夹一下：aria2 偶发 completedLength 略大于 total（尾部补齐），别让百分比 > 100
    received: total != null ? Math.min(received, total) : received,
    total,
    speed,
  };
}

/** aria2 errorCode → 人话（只翻能确定的，不做过度演绎） */
const ARIA2_ERRORS = {
  1: "aria2 报未知错误",
  2: "连接超时",
  3: "资源不存在（404）",
  4: "连续 404，aria2 已放弃重试",
  5: "下载速度过慢，aria2 主动放弃",
  6: "网络问题（连接中断 / DNS 失败）",
  7: "远端没有响应",
  8: "服务器不支持断点续传",
  9: "磁盘空间不足",
  10: "分片大小与控制文件不一致",
  11: "系统调用被重复调用",
  12: "aria2 配置有误",
  13: "目标文件已存在",
  16: "无法创建目标文件",
  17: "文件系统错误（权限/只读）",
  18: "DNS 解析失败",
  19: "Metalink 解析失败",
  20: "HTTP 响应头异常",
  21: "服务器返回了 aria2 不认识的内容",
  22: "HTTP 响应码异常",
  23: "重定向次数过多",
  24: "HTTP 认证失败",
  26: "Torrent 文件损坏",
  27: "磁力链接无效",
  28: "aria2 参数不合法",
  29: "远端服务暂时不可用，aria2 已放弃",
  30: "RPC 请求解析失败",
  32: "校验和不符（aria2 自己的 checksum）",
};

/**
 * @param {number|string} code aria2 errorCode
 * @param {string} [message] errorMessage（通常为空）
 * @returns {string}
 */
export function friendlyAria2Error(code, message) {
  const c = Number(code);
  const base = ARIA2_ERRORS[c] || `aria2 错误码 ${Number.isFinite(c) ? c : "?"}`;
  const extra = String(message || "").trim();
  return extra ? `${base}（${extra}）` : base;
}

/** 端口候选列表：配置端口起，往下 8 个（默认 6802..6810） */
export function portCandidates(basePort = DEFAULT_BASE_PORT) {
  const start = Number.isFinite(Number(basePort)) && Number(basePort) > 0 ? Math.floor(Number(basePort)) : DEFAULT_BASE_PORT;
  return Array.from({ length: PORT_SPAN }, (_, i) => start + i);
}

/**
 * 轮询结果 → task 字段（纯函数，供 run() 与单测共用）。
 * speed 直接用 aria2 的瞬时值；run() 里会再盖成滑动平均值（测速要平滑）。
 * @param {object} task
 * @param {object} st tellStatus 的 result
 * @returns {object}
 */
export function applyStatus(task, st) {
  const { received, total, speed } = mapProgress(st);
  return {
    state: mapAria2Status(st?.status),
    aria2Status: st?.status || null,
    received,
    total,
    speed,
  };
}

// ════════════════════════════════════════════════════════════
// 可执行文件探测
// ════════════════════════════════════════════════════════════

let binCache = { at: 0, value: null };

/**
 * 在 PATH 与几个常见安装位置里找 aria2c。
 *
 * 缓存取舍（2026-10-18 修）：**只缓存找到的结果，不缓存失败**。
 * 此前把 `""`（没找到）也缓存 30 秒，叠加 capabilities 的 5 秒探测缓存，��成
 * 「引擎跑着的时候用户装了 aria2，死活不生效，必须重启引擎」——实测复现过
 * （宿主引擎 /aria2/status 恒回“未检测到 aria2c”，而同一环境下 resolveAria2Bin() 却能找到）。
 * 不缓存失败的代价只是一次 where.exe（毫秒级，且本来就要顺着几个常见位置挨个 existsSync），
 * 换来「用户装完立即可用」，值得。
 *
 * 例外：explicit 非空但文件不存在，**不进缓存**（也不算“探测失败”）——
 * 那是「配错了」，应当稳定报错；不回落 PATH 是为了不被“碰巧找到的另一个 aria2”掩盖配置错误。
 * 它本来就不查缓存，所以行为与以前一致。
 *
 * **沙箱环境（2026-10-18 修）**：宿主把 App 引擎进程的 `LOCALAPPDATA` 与 `USERPROFILE`
 * 都重定向到 `app-data/<id>/.runtime-tmp`（实测诊断：两者均指向该目录）。
 * 于是所有“拼环境变量”的候选路径全部落空——用户明明装了 aria2c，引擎却恒报“未检测到”。
 * 但 `HOMEDRIVE`(=C:) 与 `HOMEPATH`(=\Users\<name>) **未被重定向**，把它们拼起来
 * 仍是真实用户目录（实测 exists=true、其下 aria2c 可达）。故候选表首位放这条，
 * 其次才是环境变量路径（非沙箱环境仍有用），最后是系统级位置。
 *
 * **候选表可注入（2026-10-19 加，仅供测试）**：内置候选表是硬编码的绝对路径
 * （`/usr/bin/aria2c`、`/opt/homebrew/bin/aria2c`、`C:\ProgramData\chocolatey\bin\aria2c.exe` 等），
 * **不受任何环境变量控制**。CI runner 预装了 aria2c，所以「改环境变量造一个空环境」的测试
 * 在三平台都探到了真 aria2c 而失败。给 `opts.candidates` 后，测试可以彻底替换候选表，
 * 不再依赖机器是否干净。不传 `opts` 时行为与以前完全一致。
 *
 * @param {string} [explicit] 用户显式配置的 bin 路径
 * @param {{candidates?: string[]|(() => string[])}} [opts] 仅测试用：覆盖内置候选表
 *   （数组，或每次探测求值的函数）
 * @returns {string} 找到的绝对路径；没找到给 ""
 */
export function resolveAria2Bin(explicit = "", opts = {}) {
  if (explicit && String(explicit).trim()) {
    const p = path.resolve(String(explicit).trim());
    if (fs.existsSync(p)) return p;
    return ""; // 显式指定但不存在：视为没有，不悄悄回落到 PATH（否则「配错了」会被掩盖）
  }
  const customCandidates = opts ? opts.candidates : undefined;
  const hasCustom = customCandidates !== undefined && customCandidates !== null;
  const now = Date.now();
  // 自定义候选表**绕过缓存**：缓存是模块级单例，若先用内置表探测成功（缓存了 A），
  // 再用自定义表探测会直接拿到 A，隔离形同虚设。自定义探测本身也不写缓存，
  // 免得把测试用的候选路径泄漏给后续的真实探测。
  if (!hasCustom && binCache.value !== null && now - binCache.at < 30000) return binCache.value;
  const found = (() => {
    // 探测手段与路径归一都走 platform 层（win: where.exe + 大小写不敏感；posix: which + 大小写敏感）。
    // 这里只留「候选表」——它是 aria2 特有的，不是平台通用知识（方案 P2-3 边界）。
    // 自定义候选表时**跳过** platform.which：它在 posix 上会扫 /usr/bin、
    // /opt/homebrew/bin 等兜底目录，直接把「隔离环境」破掉——测试正是靠
    // opts.candidates 造一个空环境，来验证「用户装完立即可用」那条回归
    // （踩坑 49）。2026-10-21：收编 platform 后这里曾把隔离绕过，
    // 三平台 CI 上 unit-aria2 又红了三条。
    if (!hasCustom) {
      const hit = platform.which("aria2c");
      if (hit) return hit;
    }
    // 真实用户目录：platform.homeDir() 已处理 win 沙箱下 USERPROFILE 被重定向的事
    // （优先 HOMEDRIVE+HOMEPATH），边界与旧代码等价。
    const realHome = platform.homeDir();
    const envHome = process.env.USERPROFILE || "";
    const envLocal = process.env.LOCALAPPDATA || "";
    const winCandidates = [
      // ① 沙箱下唯一可靠的：HOMEDRIVE+HOMEPATH → AppData\Local\...\WinGet\Links
      realHome && path.join(realHome, "AppData", "Local", "Microsoft", "WinGet", "Links", "aria2c.exe"),
      realHome && path.join(realHome, "scoop", "shims", "aria2c.exe"),
      // ② 非沙箱环境的常规位置（环境变量正确时才有意义）
      envLocal && path.join(envLocal, "Microsoft", "WinGet", "Links", "aria2c.exe"),
      envHome && envHome !== realHome && path.join(envHome, "scoop", "shims", "aria2c.exe"),
      // ③ 系统级安装位置（不受用户环境变量影响）
      "C:\\ProgramData\\chocolatey\\bin\\aria2c.exe",
      path.join(process.env.ProgramFiles || "C:\\Program Files", "aria2", "aria2c.exe"),
      // ④ 本 App 自己的 dataDir（沙箱下 winget 安装会落到 .runtime-tmp，见 docs）
      path.join(process.env.LOCALAPPDATA || "", "..", "..", "aria2c.exe"),
    ].filter(Boolean);
    const guesses = hasCustom
      ? ((typeof customCandidates === "function" ? customCandidates() : customCandidates) || [])
      : (platform.name === "win32"
        ? winCandidates
        : ["/usr/bin/aria2c", "/usr/local/bin/aria2c", "/opt/homebrew/bin/aria2c"]);
    for (const g of guesses) if (g && fs.existsSync(g)) return g;
    return "";
  })();
  // 只缓存成功结果：没找到（""）不写缓存，下次调用重新探测（用户装完即可用）。
  // 自定义候选表的结果不进缓存（见上方说明）。
  if (found && !hasCustom) binCache = { at: now, value: found };
  return found;
}

// ════════════════════════════════════════════════════════════
// JSON-RPC
// ════════════════════════════════════════════════════════════

function rpcUrl(port) {
  return `http://127.0.0.1:${port}/jsonrpc`;
}

/**
 * 发一条 JSON-RPC。成功返回 result；失败抛错（带 code/message）。
 * 注意：aria2 用 HTTP 200 + error 对象表示业务错误，所以不能只看状态码。
 */
async function rpc(method, params = [], opts = {}) {
  const port = opts.port ?? state.port;
  const secret = opts.secret ?? state.secret;
  if (!port) throw Object.assign(new Error("aria2 RPC 端口未知（实例未就绪）"), { rpcCode: "NO_PORT" });
  let res;
  try {
    res = await fetch(rpcUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "hd",
        method,
        params: secret ? [`token:${secret}`, ...params] : params,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || RPC_TIMEOUT_MS),
    });
  } catch (e) {
    throw Object.assign(new Error(`aria2 RPC 不可达：${e?.message || e}`), { rpcCode: "UNREACHABLE" });
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    // 不是 aria2 的回包（可能端口被别的 HTTP 服务占了）
    throw Object.assign(new Error("aria2 RPC 返回了非 JSON 响应"), { rpcCode: "BAD_RESPONSE" });
  }
  if (json?.error) {
    throw Object.assign(new Error(json.error.message || "aria2 RPC 错误"), {
      rpcCode: json.error.code,
      rpcMessage: json.error.message || "",
    });
  }
  return json?.result;
}

/** 端口是否可绑定（不做任何抢占） */
function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** 对面真的是 aria2 吗？（getVersion 带 secret 能通说明是） */
async function probeAria2(port, secret) {
  try {
    const v = await rpc("aria2.getVersion", [], { port, secret, timeoutMs: 2000 });
    return v && typeof v.version === "string" ? v : null;
  } catch { return null; }
}

/**
 * 识别某个端口上坐的是谁（只用于能力探测，不碰任何实例）。
 *
 * 为什么需要它（2026-10-18 修）：`available:true` 必须建立在**真实 RPC 往返**之上。
 * 此前第三个分支只做「exe 存在 + 找到空闲端口」就判可用，于是端口上坐着任何 HTTP 服务
 * 都会通过，问题拖到提交任务时才爆。判定分三态：
 *   free   —— 没人监听，可以起自己的实例
 *   aria2  —— 对面在讲 aria2 的 JSON-RPC（可能因为 secret 不对而回 Unauthorized，那也算）
 *   other  —— 有人在听但不像 aria2（非 JSON / 非 JSON-RPC 形状 / 缺 version 字段）
 *
 * @param {number} port
 * @returns {Promise<{kind:"free"|"aria2"|"other", version?:string|null, detail?:string}>}
 */
async function identifyOccupant(port) {
  if (await isPortFree(port)) return { kind: "free" };
  // 直接发一条不带 secret 的 getVersion，按回包形状判定。
  // 不用 rpc() 包：它会抛错，而这里「报错」本身就是需要分类的信号（Unauthorized 恰恰证明是 aria2）。
  // 超时必须 ≥3s：aria2 对未授权请求**故意延迟约 2s** 再回 Unauthorized（防暴力猜 secret，
  // 2026-10-18 实测无 token / 空 token / 错误 token 均为 ~1.9s）。给 1.5s 会把自家实例误判成非 aria2。
  let json;
  try {
    const res = await fetch(rpcUrl(port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "hd", method: "aria2.getVersion", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    json = JSON.parse(await res.text());
  } catch (e) {
    const msg = String(e?.message || e);
    // 连不上 / 超时：可能是对方只收特定格式、也可能不是 HTTP 服务——都不该判可用
    if (/timeout|aborted/i.test(msg)) return { kind: "other", detail: "探测超时，无 RPC 回包" };
    return { kind: "other", detail: `探测失败：${msg}` };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { kind: "other", detail: "回包不是 JSON-RPC" };
  }
  // ① aria2 正常回包：result.version
  if (typeof json.result?.version === "string" && json.result.version) {
    return { kind: "aria2", version: json.result.version };
  }
  // ② aria2 的 JSON-RPC error（Unauthorized / 方法不存在）：带数字 code 的 error 对象——确实是 aria2
  if (json.error && Number.isFinite(Number(json.error.code))) {
    return { kind: "aria2", version: null, detail: String(json.error.message || "") };
  }
  // ③ 有 jsonrpc 外形却没有 version/error：不是 aria2
  if (json.jsonrpc) return { kind: "other", detail: "JSON-RPC 响应缺 version 字段" };
  return { kind: "other", detail: "回包不是 aria2 的 JSON-RPC" };
}

// ════════════════════════════════════════════════════════════
// 受管实例生命周期
// ════════════════════════════════════════════════════════════

function readRecord(recordPath) {
  try {
    const r = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    return r && typeof r === "object" ? r : null;
  } catch { return null; }
}

function writeRecord(recordPath, rec) {
  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    // 权限 600：secret 属于凭据，不能给同机其他用户读（Windows 上 mode 基本无效，但仍写上）
    fs.writeFileSync(recordPath, JSON.stringify(rec, null, 2), { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(recordPath, 0o600); } catch { /* Windows 忽略 */ }
  } catch { /* 记录写不了不影响下载，只是下次起新实例 */ }
}

function clearRecord(recordPath) {
  try { fs.rmSync(recordPath, { force: true }); } catch { /* 忽略 */ }
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 只探活，不发信号
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // 存在但无权限：算活着
  }
}

/**
 * 记录文件里的实例进程是否还活着（**同步、只做粗筛**）。
 *
 * 为什么只算粗筛：引擎被硬杀（App reload / 宿主重启）时，它 spawn 的 aria2c 是独立进程，
 * 不会跟着死，还会继续往同一个 `.part` 写。恢复任务时若一律按「引擎重启=任务被打断」处理，
 * 用户就看到「下载失败」，而文件其实还在下、最后会下完，只是没人记录（2026-10-19 的误报）。
 * 所以要区分「实例还活着」与「实例已经没了」。
 *
 * 但 pid 存活**不等于**实例可用：pid 可能被系统复用给别的进程。真正的判据是
 * `aria2.getVersion` 用正确 secret 能通（见 adoptRecordedInstance）——本项目铁律：
 * `available:true` 必须建立在真实 RPC 往返之上。这里返回 true 只代表「值得去握一次手」。
 *
 * @param {string} dataDir
 * @returns {boolean}
 */
export function recordedInstanceAlive(dataDir) {
  if (!dataDir) return false;
  const rec = readRecord(path.join(dataDir, INSTANCE_FILE));
  if (!rec || !rec.pid || !rec.port || !rec.secret) return false;
  return pidAlive(rec.pid);
}

/**
 * 把「上一条引擎进程留下的、仍然活着的实例」接回本进程（**不 spawn、不 kill**）。
 *
 * 与 _ensureInstance 的分支②同源，但刻意分开：恢复任务时绝不能因为「记录失效」就
 * 起一个新实例——那会变成两个 aria2 同时写同一份 `.part`。接不回来就如实返回失败，
 * 由 dlcore 退回「任务被中断」的原有语义。
 *
 * @param {string} dataDir
 * @returns {Promise<{ok:boolean, port?:number, adopted?:boolean, version?:string, reason?:string}>}
 */
async function adoptRecordedInstance(dataDir) {
  if (!dataDir) return { ok: false, reason: "缺少 dataDir" };
  state.dataDir = dataDir;
  state.recordPath = path.join(dataDir, INSTANCE_FILE);
  // ① 本进程内存里已有就绪实例（同进程重建 TaskManager 的场景）：仍然握手一次再认
  // dataDir 必须对得上：一个引擎进程只养一个实例，换了 dataDir 就不能认上一份的实例
  if (state.ready && state.port && state.dataDir === dataDir
      && (!state.proc || state.proc.exitCode === null)) {
    const v = await probeAria2(state.port, state.secret);
    if (v) return { ok: true, port: state.port, adopted: state.adopted === true, version: v.version };
  }
  // ② 记录文件里的实例：pid 活着 + getVersion 用正确 secret 能通，两个都过才算活着
  const rec = readRecord(state.recordPath);
  if (!rec || !rec.pid || !rec.port || !rec.secret) return { ok: false, reason: "没有可复用的实例记录" };
  if (!pidAlive(rec.pid)) return { ok: false, reason: `记录的实例进程已不在（pid ${rec.pid}）` };
  const v = await probeAria2(rec.port, rec.secret);
  if (!v) return { ok: false, reason: "实例端口上 aria2 RPC 握手失败（secret/端口不匹配）" };
  // 接回来的实例不是本进程 spawn 的：不持有 handle，只靠 pid 探活，绝不 kill
  state.proc = null;
  state.adopted = true;
  state.adoptedPid = rec.pid;
  state.port = rec.port;
  state.secret = rec.secret;
  state.bin = rec.bin || state.bin;
  state.version = v.version;
  state.ready = true;
  invalidateDetection();
  return { ok: true, port: rec.port, adopted: true, version: v.version };
}

/**
 * 关掉本进程 spawn 的实例。**只关自己持有的 ChildProcess**——
 * 复用来的实例（adopted）只断 RPC，不 kill（那个进程不是我们起的）。
 */
export async function shutdownInstance({ quiet = true } = {}) {
  const proc = state.proc;
  const wasReady = state.ready;
  const port = state.port;
  const secret = state.secret;
  const recordPath = state.recordPath;
  state.proc = null;
  state.ready = false;
  state.adopted = false;
  state.adoptedPid = 0;
  state.activeTasks = 0;
  invalidateDetection(); // 实例没了，成功缓存必须一起失效
  if (proc) {
    // 先礼后兵：aria2.shutdown 让控制文件落盘，再 kill 兜底
    if (wasReady) {
      try { await rpc("aria2.shutdown", [], { port, secret, timeoutMs: 2000 }); } catch { /* 已经走了 */ }
      for (let i = 0; i < 30; i++) {
        if (proc.exitCode !== null || proc.signalCode) break;
        await sleep(100);
      }
    }
    if (proc.exitCode === null && !proc.signalCode) {
      try { proc.kill(); } catch { /* 忽略 */ }
      await sleep(150);
    }
  }
  state.port = 0;
  state.secret = "";
  // 只在自己持有过 handle 的情况下清记录：adopted 的实例是别的进程起的，它的记录还要留着
  if (proc && recordPath) clearRecord(recordPath);
  if (!quiet) return;
}

// 注：（原 pickPort 已删）它只回答「这个端口空不空」，不回答「对面是不是 aria2」——
// 正是 capabilities 误报 available:true 的来源，保留它等于给旧 bug 留下回头路。
// 现在选端口只在 ensureInstance 内部按候选逐个试，并靠 aria2.getVersion 真实握手确认。

/**
 * 确保有一个可用的受管实例（单飞：并发到达的任务共用同一次启动，避免起出两个 aria2c）。
 * 复用顺序：内存里的活实例 → 记录文件里 pid 还活着的实例 → 新起一个。
 */
let ensureInFlight = null;
async function ensureInstance(dataDir, opts) {
  state.dataDir = dataDir;
  state.recordPath = path.join(dataDir, INSTANCE_FILE);
  // ① 内存里已经起好了
  if (state.ready && state.port && (!state.proc || state.proc.exitCode === null)) {
    return { ok: true, port: state.port, secret: state.secret, adopted: state.adopted };
  }
  if (!ensureInFlight) {
    ensureInFlight = _ensureInstance(opts).finally(() => { ensureInFlight = null; });
  }
  return ensureInFlight;
}

async function _ensureInstance({ bin, port }) {
  const dataDir = state.dataDir; // 由 ensureInstance 设过
  // ② 上一轮进程留下的实例：记录 + pid 活着 + getVersion 通 → 复用（不 kill）
  const rec = readRecord(state.recordPath);
  if (rec && rec.pid && pidAlive(rec.pid) && rec.port && rec.secret) {
    const v = await probeAria2(rec.port, rec.secret);
    if (v) {
      state.port = rec.port;
      state.secret = rec.secret;
      state.bin = rec.bin || bin;
      state.version = v.version;
      state.ready = true;
      state.adopted = true;
      state.proc = null;
      state.adoptedPid = rec.pid; // 没有 handle，靠 pid 判活（缓存失效条件要用）
      return { ok: true, port: state.port, secret: state.secret, adopted: true };
    }
  }
  // 记录指向的实例已死 / 不是 aria2：清掉记录，重新起（绝不 kill 那个 pid）
  if (rec) clearRecord(state.recordPath);

  // ③ 新起一个：端口占用就换下一个，绝不抢占
  const exe = bin || resolveAria2Bin(state.options.bin);
  if (!exe) return { ok: false, reason: "未检测到 aria2c" };

  const secret = randomBytes(24).toString("hex"); // 每次启动都换
  const tried = [];
  for (const p of portCandidates(port || DEFAULT_BASE_PORT)) {
    if (!(await isPortFree(p))) { tried.push(p); continue; }
    const args = buildArgs({ port: p, secret, dataDir });
    let proc;
    try {
      proc = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
    } catch (e) {
      tried.push(p);
      continue;
    }
    // 出错也不能把 secret 打进日志
    let exited = false;
    proc.once("exit", () => { exited = true; });
    proc.once("error", () => { exited = true; });

    const deadline = Date.now() + START_TIMEOUT_MS;
    let v = null;
    while (Date.now() < deadline && !exited) {
      await sleep(120);
      v = await probeAria2(p, secret);
      if (v) break;
    }
    if (!v) {
      // 自己起的、自己收：只 kill 这个 proc
      try { proc.kill(); } catch { /* 忽略 */ }
      tried.push(p);
      continue;
    }
    state.proc = proc;
    state.adopted = false;
    state.adoptedPid = 0;
    // 自己起的实例退出（崩了 / 被外部杀掉）：成功缓存立即失效，下次探测会重新起
    proc.once("exit", () => { if (state.proc === proc) invalidateDetection(); });
    state.port = p;
    state.secret = secret;
    state.bin = exe;
    state.version = v.version;
    state.ready = true;
    writeRecord(state.recordPath, {
      pid: proc.pid || 0,
      port: p,
      secret,
      bin: exe,
      version: v.version,
      startedAt: Date.now(),
      app: "hana-downloader",
    });
    return { ok: true, port: p, secret };
  }

  if (tried.length >= PORT_SPAN) return { ok: false, reason: "端口被占用" };
  return { ok: false, reason: "aria2 启动失败（端口耗尽或进程异常退出）" };
}

function buildArgs({ port, secret, dataDir }) {
  const dlDir = path.join(dataDir, "aria2-downloads");
  try { fs.mkdirSync(dlDir, { recursive: true }); } catch { /* 交给 spawn 报错 */ }
  return [
    "--enable-rpc",
    `--rpc-listen-port=${port}`,
    `--rpc-secret=${secret}`,
    "--rpc-listen-all=false",
    "--rpc-allow-origin-all=false",
    `--dir=${dlDir}`,
    "--continue=true",
    "--auto-file-renaming=false",
    "--allow-overwrite=true",
    // 分片长度交给 aria2 默认值：进度只信 completedLength，预分配已关，长度不是问题
    "--file-allocation=none",
    "--max-concurrent-downloads=1", // 初始值；每次 addUri 前抬到实际并发数
    "--disable-ipv6=true",
    "--summary-interval=0",
    "--console-log-level=warn",
    "--quiet=true",
    "--no-conf=true",               // 不吃用户的 ~/.aria2/aria2.conf（别人的配置不该影响我们）
    "--save-session=" + path.join(dataDir, "aria2-session.txt"),
    "--save-session-interval=30",
  ];
}

/** 把 aria2 自己的并发上限对齐到「本 backend 实际在跑的任务数」，不让它成为第二个调度器 */
async function syncConcurrency(n) {
  const limit = Math.max(1, Math.floor(n));
  try {
    await rpc("aria2.changeGlobalOption", [{ "max-concurrent-downloads": String(limit) }]);
  } catch { /* 改不动不影响单任务下载 */ }
}

// ════════════════════════════════════════════════════════════
// backend 对象
// ════════════════════════════════════════════════════════════

/** 丢掉探测缓存（配置变更 / 实例消失 / 手动刷新时调） */
function invalidateDetection() {
  state.detection = { at: 0, value: null, ok: null };
}

/**
 * 缓存的探测结果还能用吗？
 *
 * 三个失效条件（除了 TTL）：
 *   ① 配置变更 → setOptions 里直接 invalidateDetection()
 *   ② 实例已启动但 pid 不在了 → 这里判（adopted 实例没 handle，只能靠 pid）
 *   ③ 手动刷新 → capabilities({ force:true }) / refreshCapabilities()
 *
 * TTL 按结果分档：成功 10 分钟，失败 5 秒（踩坑 49：负结果不能长留）。
 * 判定为「探测中」（ok===null）时按开始时刻算短 TTL，避免并发调用重跑探测。
 */
function detectionValid(now = Date.now()) {
  const d = state.detection;
  if (!d.value) return false;
  if (d.ok === true) {
    // ② 成功结果蕴含「有个活实例」：实例不在了（被关掉 / 进程崩了）就作废
    if (!state.ready) return false;
    if (state.proc) {
      if (state.proc.exitCode !== null || state.proc.signalCode) return false;
    } else if (state.adoptedPid && !pidAlive(state.adoptedPid)) {
      return false;
    }
  }
  const ttl = d.ok === true ? DETECT_POSITIVE_TTL_MS : DETECT_NEGATIVE_TTL_MS;
  return now - d.at < ttl;
}

export const aria2Backend = {
  name: NAME,

  /** dlcore 从 engine-config.json 读到配置后灌进来（只改内存，不写盘） */
  setOptions(opts = {}) {
    const nextBin = typeof opts.bin === "string" ? opts.bin.trim() : state.options.bin;
    const nextPort = Number(opts.port);
    const changed = nextBin !== state.options.bin
      || (Number.isFinite(nextPort) && nextPort > 0 && nextPort !== state.options.port);
    state.options = {
      bin: nextBin || "",
      port: Number.isFinite(nextPort) && nextPort > 0 ? Math.floor(nextPort) : DEFAULT_BASE_PORT,
    };
    if (changed) invalidateDetection();
    return { ...state.options };
  },

  /**
   * 能力探测。**available:true 必须建立在真实 RPC 往返之上**（2026-10-18 修）。
   *
   * 修复前：没有实例时只做「exe 存在 + 找到一个空闲端口」就返回 available:true，
   * `version: null` 暴露了没握手——端口上坐着任何 HTTP 服务都会通过，问题拖到提交任务时才爆。
   * 现在：
   *   ① 配置端口上坐着非 aria2 的程序 → 立即 available:false（配置错误要当场说清，不静默避让）
   *   ② 否则起/复用受管实例（与 run 同一条路径，不新增进程管理逻辑）
   *   ③ 用正确的 secret 调 aria2.getVersion，拿到合法 version 才算 available:true
   *
   * 避让保留：配置端口被**另一个 aria2** 占着时，跳过它自己找下一个端口（不去抢别人的实例）。
   *
   * 缓存策略（2026-10-19）：
   *   · available:true  → 缓存 10 分钟，并在实例消失时立即失效（见 detectionValid）
   *   · available:false → 只缓存 5s（踩坑 49：用户刚装好 aria2 必须马上能识别）
   *   缓存只影响「要不要重跑探测」，**不影响判定标准**：探测真跑起来时 available:true 仍必须来自真实握手。
   *
   * @param {object} [opts] { dataDir, force }  force=true 跳过缓存，强制重测（手动刷新用）
   */
  capabilities(opts = {}) {
    const now = Date.now();
    const cached = state.detection.value;
    if (!opts.force && cached && detectionValid(now)) return cached;
    const unavailable = (reason, extra = {}) => ({ available: false, name: NAME, features: [], reason, ...extra });
    state.probes += 1;
    const value = (async () => {
      const exe = resolveAria2Bin(state.options.bin);
      if (!exe) return unavailable("未检测到 aria2c", { bin: "" });
      // 没有 dataDir 就无法起实例（实例记录与下载目录都落在那里）——不能凭空声称可用
      if (!opts.dataDir) return unavailable("缺少 dataDir，无法验证 aria2 RPC", { bin: exe });

      // ① 配置端口上坐的是谁？被非 aria2 占着就是配置错了，不静默避让
      const basePort = state.options.port;
      const occ = await identifyOccupant(basePort);
      if (occ.kind === "other") {
        return unavailable(
          `${basePort} 端口被非 aria2 程序占用（${occ.detail || "无法识别"}），无法确认 aria2 可用`,
          { bin: exe },
        );
      }

      // ② 起/复用受管实例（配置端口若被另一个 aria2 占着，ensureInstance 会自己跳到下一个空闲端口）
      const inst = await ensureInstance(opts.dataDir, state.options);
      if (!inst.ok) return unavailable(inst.reason || "aria2 启动失败", { bin: exe });

      // ③ 真实握手：用正确的 secret 拿版本号
      const v = await probeAria2(inst.port, inst.secret);
      if (!v || typeof v.version !== "string" || !v.version) {
        return unavailable(`aria2 实例未通过 RPC 握手（aria2.getVersion 无有效回包，端口 ${inst.port}）`, { bin: exe, port: inst.port });
      }
      return {
        available: true,
        name: NAME,
        features: [...FEATURES],
        reason: null,
        bin: exe,
        port: inst.port,
        version: v.version,
      };
    })();
    state.detection = { at: now, value, ok: null };
    // 缓存的是 Promise：探测失败也要能重试。落定后按结果分别计时（成功 10min / 失败 5s）。
    value.then(
      (v) => { if (state.detection.value === value) state.detection.ok = v?.available === true; },
      () => { if (state.detection.value === value) state.detection = { at: 0, value: null, ok: null }; },
    );
    return value;
  },

  /**
   * 手动刷新：丢掉缓存重新探测。
   * 管理器/诊断想「现在就要真实结果」时用它（capabilities({ force: true }) 等价）。
   */
  refreshCapabilities(opts = {}) {
    invalidateDetection();
    return this.capabilities({ ...opts, force: true });
  },

  /**
   * 提交并跑完一个任务。契约见 backends/contract.js。
   * @param {object} ctx
   */
  async run(ctx) {
    validateContext(ctx);
    const { task } = ctx;
    task.aria2Status = null;
    task.stage = "downloading";

    const inst = await ensureInstance(ctx.dataDir, state.options);
    if (!inst.ok) {
      // 起不来属于「基础设施不可用」：交给 dlcore 决定降级（它认得 ARIA2_UNAVAILABLE）
      const err = new Error(inst.reason || "aria2 不可用");
      err.code = "ARIA2_UNAVAILABLE";
      throw err;
    }
    state.activeTasks += 1;
    await syncConcurrency(state.activeTasks);

    const controller = task.controller;
    let gid = null;
    let canceled = false;
    const onAbort = () => { canceled = true; };
    controller?.signal?.addEventListener("abort", onAbort);
    // dlcore 取消时先置 cancelRequested 再 abort；两个信号都认
    const cancelPoll = () => (canceled || task.cancelRequested === true);

    const samples = [];
    let lastTick = Date.now();
    let lastBytes = task.received || 0;
    // 落盘去重基准：初始化为当前值，避免刚提交（received=0）时白写一次
    task._lastPersistedReceived = task.received || 0;
    const pollFailures = { n: 0 };

    try {
      // 恢复路径（引擎重启后接回活实例）：优先复用实例里已有的 gid，绝不再 addUri 一次
      // ——那会对同一份 `.part` 起第二个下载。复用不成（gid 被清、路径也对不上）才重新提交，
      // 此时 continue=true + `.part.aria2` 控制文件仍能续传。
      if (task._resumeGid) {
        task._resumeGid = null;
        gid = await reuseExisting(task);
      }
      if (!gid) gid = await submit(ctx, task);
      if (!gid) {
        // submit 已经写了任务状态（不可能「结果不明还当成功」）
        return;
      }

      for (;;) {
        if (cancelPoll()) {
          const cr = await stopGid(gid);
          if (cr.ok) {
            // 取消确认：保留 .part 与 .aria2（续传靠它们）
            task.state = "canceled";
            task.error = "已取消";
            task.aria2Status = "removed";
            if (typeof task.received !== "number" || task.received < 0) task.received = 0;
            task.finishedAt = Date.now();
            ctx.persist();
          } else {
            // 取消没确认：绝不假报已取消，也绝不假报完成
            task.state = "failed";
            task.error = `取消未确认：${cr.error}`;
            task.finishedAt = Date.now();
            ctx.persist();
          }
          return;
        }

        let st;
        try {
          st = await rpc("aria2.tellStatus", [gid, [
            "gid", "status", "totalLength", "completedLength", "downloadSpeed",
            "errorCode", "errorMessage", "files", "dir",
          ]]);
        } catch (e) {
          // tellStatus 对已 removed 的 gid 会报错：那不是「失联」
          if (String(e?.rpcMessage || e?.message || "").includes("not found")) {
            task.state = "canceled";
            task.error = "已取消";
            task.finishedAt = Date.now();
            ctx.persist();
            return;
          }
          pollFailures.n += 1;
          if (pollFailures.n >= POLL_FAIL_LIMIT) {
            task.state = "interrupted";
            task.error = `aria2 轮询失联（连续 ${pollFailures.n} 次）：${ctx.friendlyError(e)}`;
            task.finishedAt = Date.now();
            ctx.persist();
            return;
          }
          await sleep(POLL_MS);
          continue;
        }
        pollFailures.n = 0;
        if (!st || typeof st !== "object") {
          await sleep(POLL_MS);
          continue;
        }

        const prog = mapProgress(st);
        const mapped = applyStatus(task, st);
        task.aria2Status = mapped.aria2Status;
        task.received = mapped.received;
        if (mapped.total != null) task.total = mapped.total;

        // 测速：滑动平均（与 node-http 同口径，避免抖动）
        const now = Date.now();
        if (now - lastTick >= SPEED_SAMPLE_MS) {
          const instSpeed = (prog.received - lastBytes) / ((now - lastTick) / 1000);
          if (Number.isFinite(instSpeed)) {
            samples.push(instSpeed);
            if (samples.length > SPEED_SAMPLES_MAX) samples.shift();
            task.speed = samples.reduce((a, b) => a + b, 0) / samples.length;
          }
          lastTick = now;
          lastBytes = prog.received;
        }
        if (prog.received > (task._aria2LastReceived ?? -1)) {
          task._aria2LastReceived = prog.received;
          task._lastProgressAt = now; // 停滞判定的心跳：真有进展才更新（waiting 不算）
          if (task.stalledAt != null) { task.stalledAt = null; task.stallNotified = false; }
        }

        // 进度节流落盘：走 dlcore 的 ctx.persist()（不另开写盘路径），
        // 每 PERSIST_INTERVAL_MS 最多写一次，且只在 received 真的变了才写。
        // 进度来源仍然只有 RPC 的 completedLength（mapProgress），绝不看 .part 大小。
        // 终态由 dlcore 的 finally / 各分支自行落盘，这里不重复写终态。
        if (task.received !== task._lastPersistedReceived
            && now - (task._lastPersistAt || 0) >= PERSIST_INTERVAL_MS) {
          task._lastPersistAt = now;
          task._lastPersistedReceived = task.received;
          ctx.persist();
        }

        if (mapped.state === "complete") {
          await finalizeComplete(ctx, task, st, gid);
          return;
        }
        if (mapped.state === "failed") {
          const code = Number(st.errorCode);
          // 网络类中断（EOF / 超时 / 连接断 / 远端无响应）不算「这个文件下不下来」，
          // 算「这次没传完」：.part 留着，状态落 interrupted，与 node-http 同语义（可续传/重试）。
          const transient = new Set([1, 2, 5, 6, 7, 29]).has(code) && (task.received || 0) > 0;
          task.state = transient ? "interrupted" : "failed";
          // errorCode 32 = aria2 用自己的 checksum 自检失败：有期望摘要时说清楚是内容不符，
          // 别让用户只看到「校验和」三个字而不知道到底哪边不对。
          task.error = (code === 32 && task.expectedSha256)
            ? `SHA-256 校验失败（aria2 自检）：期望 ${task.expectedSha256}，实际内容与之不符`
            : friendlyAria2Error(st.errorCode, st.errorMessage);
          task.finishedAt = Date.now();
          ctx.persist();
          // 让「不可续传」的残留别误导：
          //  8  服务器不支持续传 → 半成品与控制文件清掉，下次从头下
          //  32 内容校验不符（aria2 自检）→ 半成品是错的，必须清掉，否则重试会立即「完成」并再失败一次
          if (code === 8 || code === 32) {
            try { fs.rmSync(task.partPath, { force: true }); } catch { /* 忽略 */ }
            try { fs.rmSync(task.partPath + ".aria2", { force: true }); } catch { /* 忽略 */ }
            task.received = 0;
            task.error += "（半成品已清除，重试将从零开始）";
          }
          return;
        }
        if (mapped.state === "canceled") {
          task.state = "canceled";
          task.error = "已取消";
          task.finishedAt = Date.now();
          ctx.persist();
          return;
        }
        // running / pending / unknown：继续轮询
        await sleep(POLL_MS);
      }
    } catch (e) {
      // 兜底：任何未预料异常都要落成「未完成」，不能带着 running 静默结束
      if (task.state === "running" || task.state === "pending" || !task.state) {
        const aborted = canceled || task.cancelRequested || controller?.signal?.aborted;
        task.state = aborted ? "canceled" : "interrupted";
        task.error = aborted ? "已取消" : `aria2 传输异常：${ctx.friendlyError(e)}`;
        task.finishedAt = Date.now();
        ctx.persist();
      }
      throw e;
    } finally {
      try { controller?.signal?.removeEventListener("abort", onAbort); } catch { /* 忽略 */ }
      state.activeTasks = Math.max(0, state.activeTasks - 1);
      await syncConcurrency(state.activeTasks || 1);
      task.stage = null;
      delete task._aria2LastReceived;
      delete task._lastPersistedReceived;
    }
  },

  /**
   * 取消（dlcore 的 cancel() 走 controller.abort，这条是给「想直接叫停」的调用方留的）。
   * @param {object} task
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async cancel(task) {
    const gid = task?.aria2Gid;
    if (!gid) return { ok: false, error: "该任务没有 aria2 gid（可能是别的 backend 在跑）" };
    return stopGid(gid);
  },

  /** 供测试/关闭引擎时收尾：只关自己起的实例 */
  async shutdown() { return shutdownInstance(); },

  /**
   * 引擎重启后「接回」还活着的实例，并确认这条任务确实还在它那儿。
   *
   * 两条硬条件（缺一不可）：
   *   1. 记录过的 pid 进程存活（只做粗筛：pid 可能被复用）
   *   2. `aria2.getVersion` 用记录的 secret 真能通（真实 RPC 往返）
   * 再加一条业务条件：实例里能找到这条任务（持久化的 gid，或按 `.part` 路径回找）。
   * 全部成立才返回 ok——任何一条不成立都如实报 reason，由 dlcore 退回「任务被中断」语义。
   *
   * **绝不 spawn**：恢复时起新实例 = 两个 aria2 同时写同一份 `.part`。
   *
   * @param {{dataDir:string, task:object}} args
   * @returns {Promise<{ok:boolean, gid?:string|null, port?:number, version?:string, adopted?:boolean, reason?:string}>}
   */
  async adopt({ dataDir, task } = {}) {
    const inst = await adoptRecordedInstance(dataDir);
    if (!inst.ok) return { ok: false, reason: inst.reason || "实例不可用" };
    const gid = await reuseExisting(task || {});
    if (!gid) return { ok: false, reason: "实例活着，但这条任务已不在它的队列里" };
    return { ok: true, gid, port: inst.port, version: inst.version, adopted: inst.adopted === true };
  },

  /** 供诊断：实例现状（不含 secret） */
  instanceInfo() {
    return {
      ready: state.ready,
      adopted: state.adopted,
      pid: state.proc?.pid || null,
      port: state.port || null,
      version: state.version || null,
      activeTasks: state.activeTasks,
      // 探测缓存现状（供诊断与测试观察；不含 secret）
      probes: state.probes,
      detectionAt: state.detection.at,
      detectionOk: state.detection.ok,
    };
  },
};

// ════════════════════════════════════════════════════════════
// 内部：提交 / 取消 / 收尾
// ════════════════════════════════════════════════════════════

// 路径比较用的归一（大小写与分隔符规则交给平台层）
function normPath(p) {
  try {
    const r = path.resolve(String(p || ""));
    return platform.normalizePath(r);
  } catch { return String(p || ""); }
}

/**
 * 在实例的活动/等待/已停队列里按落盘路径找回这条任务的 gid。
 *
 * 为什么需要它：`aria2Gid` 是 v30 才开始持久化的，升级前创建的任务重启后没有 gid；
 * 但它的 aria2 实例可能还在下。按 `files[].path` 匹配 `.part` 绝对路径是唯一可靠的回指
 *（out 就是我们给的 `.part`，auto-file-renaming=false 保证不会被改名）。
 *
 * @param {string} partPath
 * @returns {Promise<string|null>}
 */
async function findGidByPath(partPath) {
  if (!partPath) return null;
  const want = normPath(partPath);
  const queries = [
    ["aria2.tellActive", [["gid", "status", "files"]]],
    ["aria2.tellWaiting", [0, 1000, ["gid", "status", "files"]]],
    ["aria2.tellStopped", [0, 1000, ["gid", "status", "files"]]],
  ];
  for (const [method, params] of queries) {
    let list;
    try { list = await rpc(method, params); } catch { continue; }
    for (const it of Array.isArray(list) ? list : []) {
      const files = Array.isArray(it?.files) ? it.files : [];
      if (files.some((f) => f?.path && normPath(f.path) === want)) return it.gid || null;
    }
  }
  return null;
}

/**
 * 复用实例里已有的这条任务：先用持久化的 gid，gid 不认再按落盘路径找。
 * 成功时把 task 的归属字段对齐（这份 `.part` 确实归 aria2），返回 gid；找不到返回 null。
 *
 * @param {object} task
 * @returns {Promise<string|null>}
 */
async function reuseExisting(task) {
  const gid = task?.aria2Gid;
  if (gid) {
    try {
      const st = await rpc("aria2.tellStatus", [gid, ["gid", "status"]]);
      // removed = 已被 aria2 从活动列表摘掉（我们不在时它被取消了），不能当成「还在下」
      if (st && st.status && st.status !== "removed") {
        task.partOwner = NAME;
        task.aria2Status = st.status;
        return gid;
      }
    } catch { /* 走路径查找 */ }
  }
  const found = await findGidByPath(task?.partPath);
  if (found) {
    task.partOwner = NAME;
    return found;
  }
  return null;
}

/** 提交任务，返回 gid（失败时已把 task 写成 failed 并返回 null） */
async function submit(ctx, task) {
  const partPath = task.partPath;
  const dir = path.dirname(partPath);
  const out = path.basename(partPath); // 直接落到 .part：续传靠 .part + .part.aria2
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* submit 会报 */ }

  // 回环目标永不走代理（与 node-http 同一口径）
  let proxy = "";
  try {
    const host = new URL(task.url).hostname;
    const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) || /^127\./.test(host);
    if (!isLoopback) proxy = ctx.resolveProxy(ctx.dataDir, task.url) || "";
  } catch {
    task.state = "failed";
    task.error = "URL 不合法";
    task.finishedAt = Date.now();
    ctx.persist();
    return null;
  }

  const opts = {
    dir,
    out,
    "continue": "true",            // 续传（含其他程序留下的半成品）
    "auto-file-renaming": "false", // 绝不自动改名，否则 .part 契约就断了
    "allow-overwrite": "true",
    "file-allocation": "none",     // 不预分配：进度只信 completedLength
    "max-connection-per-server": "5",
    "min-split-size": "1M",
    "content-disposition-default-utf8": "true",
  };
  if (proxy) opts["all-proxy"] = proxy;
  if (task.speedLimit > 0) opts["max-download-limit"] = String(task.speedLimit);
  if (task.expectedSha256) {
    // 让 aria2 顺带自检一次：它报 errorCode=32 时我们也算失败（内容级，不是只看状态）
    opts["checksum"] = `sha-256=${String(task.expectedSha256).toLowerCase()}`;
  }

  let gid;
  try {
    gid = await rpc("aria2.addUri", [[task.url], opts]);
  } catch (e) {
    if (e?.rpcCode === "UNREACHABLE" || e?.rpcCode === "NO_PORT" || e?.rpcCode === "BAD_RESPONSE") {
      // 实例挂了：不算任务失败，交给 dlcore 决定降级
      const err = new Error(`aria2 不可用：${e.message}`);
      err.code = "ARIA2_UNAVAILABLE";
      throw err;
    }
    if (e?.rpcCode === 28) {
      // 参数不被接受（版本太老/选项拼错）：明确失败，不静默降级
      task.state = "failed";
      task.error = `aria2 拒绝了下载参数：${e.message}`;
      task.finishedAt = Date.now();
      ctx.persist();
      return null;
    }
    task.state = "failed";
    task.error = `aria2 提交失败：${e?.message || e}`;
    task.finishedAt = Date.now();
    ctx.persist();
    return null;
  }
  if (typeof gid !== "string" || !gid) {
    // 结果不明：绝不当作已提交
    task.state = "failed";
    task.error = "aria2 提交结果不明（未返回 gid）";
    task.finishedAt = Date.now();
    ctx.persist();
    return null;
  }
  task.aria2Gid = gid;
  // 归属标记：从这里开始这份 .part 归 aria2。aria2 写的是「多段稀疏文件」，
  // st_size 只是最远分片写到的偏移（file-allocation=none 时一上来就是全长），
  // 绝不能当成「已下载的连续前缀」交给 node-http 续写（那会交付带洞文件却报 done）。
  task.partOwner = NAME;
  ctx.persist();
  return gid;
}

/** remove → 等 removed → removeDownloadResult；返回是否确认 */
async function stopGid(gid) {
  if (!gid) return { ok: false, error: "没有 gid" };
  let removed = false;
  try {
    await rpc("aria2.remove", [gid]);
  } catch (e) {
    const msg = String(e?.rpcMessage || e?.message || "");
    if (!msg.includes("not found") && !msg.includes("cannot be")) {
      return { ok: false, error: e?.message || String(e) };
    }
    removed = true; // 已经不在活动列表里（可能已终态）
  }
  if (!removed) {
    // 等状态变 removed，最多 ~3s
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      try {
        const st = await rpc("aria2.tellStatus", [gid, ["status"]]);
        if (st?.status === "removed") { removed = true; break; }
        if (st?.status === "complete" || st?.status === "error") { removed = true; break; }
      } catch (e) {
        if (String(e?.rpcMessage || e?.message || "").includes("not found")) { removed = true; break; }
        return { ok: false, error: e?.message || String(e) };
      }
    }
  }
  if (!removed) return { ok: false, error: "等待 removed 状态超时" };
  try { await rpc("aria2.removeDownloadResult", [gid]); } catch { /* 已被清理 */ }
  return { ok: true };
}

/** aria2 报 complete 之后：内容级校验 → 交付。校验不过绝不 done。 */
async function finalizeComplete(ctx, task, st, gid) {
  const partPath = task.partPath;
  if (!partPath || !task.filePath) {
    task.state = "failed";
    task.error = "缺少落盘路径，无法交付";
    task.finishedAt = Date.now();
    ctx.persist();
    return;
  }
  if (!fs.existsSync(partPath)) {
    // aria2 说完了但 .part 不在：可能是 out 被改到了别处（meta 里带 disposition）
    const files = Array.isArray(st?.files) ? st.files : [];
    const alt = files.map((f) => f?.path).filter(Boolean)[0];
    if (alt && fs.existsSync(alt)) {
      try { fs.renameSync(alt, partPath); } catch { /* 交给下面的存在性判断 */ }
    }
  }
  if (!fs.existsSync(partPath)) {
    task.state = "failed";
    task.error = "aria2 报完成但半成品文件不存在";
    task.finishedAt = Date.now();
    ctx.persist();
    return;
  }

  // 字节数核对：completedLength（不是文件大小）与 totalLength 不一致就不交付
  const prog = mapProgress(st);
  let size = -1;
  try { size = fs.statSync(partPath).size; } catch { size = -1; }
  if (size < 0) {
    task.state = "failed";
    task.error = "半成品文件不可读，无法交付";
    task.finishedAt = Date.now();
    ctx.persist();
    return;
  }
  if (prog.total != null && prog.received !== prog.total) {
    task.state = "failed";
    task.error = `字节数不符：已完成 ${prog.received}/${prog.total}，aria2 却报 complete`;
    task.finishedAt = Date.now();
    ctx.persist();
    return;
  }
  if (prog.total != null && size !== prog.total) {
    // 预分配被关了，正常情况两者应当相等；不等说明落盘被动过
    task.state = "failed";
    task.error = `落盘字节数与预期不符：文件 ${size} 字节，预期 ${prog.total}`;
    task.finishedAt = Date.now();
    ctx.persist();
    return;
  }

  task.received = prog.total != null ? prog.total : size;
  if (prog.total != null) task.total = prog.total;

  const delivered = deliverPartFile(task);
  task.finishedAt = Date.now();
  if (delivered.ok) {
    task.state = "done";
    task.error = null;
    task.speed = 0;
    // 交付成功后把 aria2 的控制文件一起清掉：那份 .aria2 对应的是刚被改名的半成品，
    // 留着下次同名任务会误以为可续传（实测：留着它重试会直接报 complete 而不再下载）。
    try { fs.rmSync(partPath + ".aria2", { force: true }); } catch { /* 忽略 */ }
  } else {
    task.state = "failed";
    task.error = delivered.error;
    task.speed = 0;
    // 校验失败：留着 .part 供排查；重试会重下
    if (delivered.shaMismatch) {
      try { fs.rmSync(partPath + ".aria2", { force: true }); } catch { /* 忽略 */ }
      try { fs.rmSync(partPath, { force: true }); } catch { /* 忽略 */ }
      task.received = 0;
    }
  }
  try { await rpc("aria2.removeDownloadResult", [gid]); } catch { /* 已清理 */ }
  ctx.persist();
}

// 进程退出时收尾：只关自己 spawn 的实例（adopted 的不动）
try {
  process.once("exit", () => {
    try { if (state.proc && state.proc.exitCode === null) state.proc.kill(); } catch { /* 忽略 */ }
  });
} catch { /* 忽略 */ }
