// engine/platform/win32.mjs — 平台适配层的 Windows 实现（P1-1，2026-10-20）
//
// 归属：docs/跨平台适配层重构方案-20261019.md §3.2（十组接口）+ §3.3（三条设计原则）
//
// 这一层存在的唯一理由：把「起进程」和「杀进程树」绑成一对，让「加了 detached 忘了
// killTree」或「killTree 依赖 detached 却没人设」这类错误从结构上不可能发生。
// 所以 spawnOpts 与 killTree 必须相邻，中间不许插别的函数 —— 改动这个文件时先读
// 方案 §3.3 原则一，别为了排字母顺序把它们拆开。
//
// 约定（三条，全平台一致）：
//   1. 探测类接口（which / isRunning / readSystemProxy / capabilities）失败一律返回
//      「空结果」，绝不抛。调用方不需要 try/catch。
//   2. 能力必须来自真实往返：pkgManager 真调一次 where.exe winget，不看路径上有没有文件。
//   3. spawn 出去的东西必须挂 'error' 监听 —— 没挂的 'error' 是未捕获异常，会直接把
//      整个引擎进程带走（server.js:484 在 mac 上就是这样退出的）。
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

export const name = "win32";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
// 用 where.exe（Windows 上的 which）。找不到 / 命令不存在 / 非零退出 → ""，不抛。
//
// **不拿 existsSync 二次过滤**：where.exe 自己就会查文件系统，返回 0 即已确认可达；
// 而 App Execution Alias（winget.exe 这类 0 字节重定向桩）existsSync 会给 false /
// EACCES，一过滤就把「明明能跑的 winget」判死（2026-10-20 本机实测，踩坑 53 同源）。
export function which(cmd) {
  const target = String(cmd ?? "").trim();
  if (!target) return "";
  try {
    const r = spawnSync("where.exe", [target], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (r.status !== 0) return "";
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      const p = line.trim();
      if (p) return p;
    }
    return "";
  } catch { return ""; }
}

// ── ② 可执行文件名 ──────────────────────────────────────────────────────────
// 只做「加后缀」这一件事，不猜路径、不查存在性。传裸名进来。
export function exe(n) {
  return String(n ?? "") + ".exe";
}

// ── ③④ 起子进程的默认选项 + 杀进程树 ★ 必须相邻 ────────────────────────────
// 这两条是本层存在的理由，别拆。Windows 下不存在进程组 kill(-pid) 那套，
// 杀树靠 taskkill /T，因此也不需要 detached；detached 只在 posix 侧成对出现。
export function spawnOpts(extra) {
  return { windowsHide: true, ...(extra || {}) };
}

// 杀整棵进程树。失败（进程已退 / pid 不存在 / 权限不足）返回 false，不抛。
export function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    const r = spawnSync("taskkill", ["/pid", String(n), "/T", "/F"], {
      encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    return r.status === 0;
  } catch { return false; }
}

// ── ⑤ 进程是否在跑（按名字）─────────────────────────────────────────────────
// 靠 tasklist 的事实，不靠 taskkill 的输出文本（中文 Windows 下编码不匹配会失效，
// 2026-10-04 实测）。同理这里**不能**用「输出里有『没有运行的任务』」当否定条件：
// 那句提示是本地化的、编码还不稳。只认「输出里有这个进程名的行」这一肯定事实。
export function isRunning(nm) {
  const base = String(nm ?? "").trim().replace(/\.exe$/i, "");
  if (!base) return false;
  try {
    const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${base}.exe`, "/NH"], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    if (r.status !== 0) return false;
    const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s*${esc}\\.exe\\b`, "im").test(String(r.stdout || ""));
  } catch { return false; }
}

// ── ⑥ 打开文件所在位置 ──────────────────────────────────────────────────────
// mode: "open" 用默认关联程序打开文件本身；"select" 在资源管理器里定位并选中。
// 返回 {ok, error?}：**永远不抛**，让上层能决定回 500 还是提示。
export function reveal(p, mode) {
  const target = String(p ?? "");
  if (!target) return { ok: false, error: "路径为空" };
  let exists = false;
  try { exists = fs.existsSync(target); } catch { exists = false; }
  // 先自查存在性：explorer 对不存在的路径会弹一个 GUI 错误框并挂住，比返回 false 更糟。
  if (!exists) return { ok: false, error: `路径不存在：${target}` };
  try {
    const args = mode === "open" ? [target] : ["/select,", target];
    const child = spawn("explorer.exe", args, { detached: true, stdio: "ignore" });
    // ★ 必须挂 error 监听：未处理的 'error' 事件会变成未捕获异常，整个引擎进程直接退出
    //  （server.js:484 的历史缺陷）。这里从源头堵住，上层不必重复防。
    child.on("error", () => { /* 交给上层从 {ok:false} 反映，这里只保证不炸 */ });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── ⑦ 读系统代理 ────────────────────────────────────────────────────────────
// 一次 reg query 取两个值（原先 proxy-control.js 跑两次，白等一倍）。
// 拿不到（键不存在 / reg 不可用 / 解析不上）给 {enabled:false, server:"", source:"none"}。
const REG_INET = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

// 把注册表 ProxyServer 的原文归一成 host:port。**为什么必须归一**：注册表这个值
// 有三种真实形态——单协议 `127.0.0.1:7890`、多协议（Windows 界面默认写法）
// `http=127.0.0.1:7890;https=127.0.0.1:7890`、仅 socks `socks=127.0.0.1:1080`。
// 下游（dlcore.js resolveProxyUrl）只在这串前面补一个 `http://` 就交给 new URL()：
// 多协议原文会被拼成 `http://http=127.0.0.1:7890;https=...`，new URL() 直接抛
// Invalid URL，tunnel-agent 的 catch 把错误吞成 null → **静默直连**：用户明明开着代理，
// 下载器绕过它。所以这里只输出 `host:port`，与 darwin（parseScutilProxy 拼
// `${host}:${port}`）、linux（`${host}:${port}` / normalizeProxyServer）保持同形。
// 修复 2026-10-20 审查发现的问题（多协议 ProxyServer 原样下发导致代理失效）。
//
// 单独导出的理由与 parseScutilProxy / parseGsettingsValue 一致：只吃字符串、不碰命令，
// 让 Windows 上也能直接喂值做单测。

// 单条值 → host:port。容 raw 里混进 `scheme://` 与尾斜杠；就认「主机非空 + 端口为数字」，
// 端口缺失一律判无效（不猜默认端口：猜错会让请求静默走错代理，比留空更坏）。IPv6 字面量
// `[::1]:7890` 走方括号分支。
function asHostPort(v) {
  let s = String(v ?? "").trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const m = /^([^\s;=/:]+|\[[0-9a-f:.]+\]):(\d{1,5})$/.exec(s);
  if (!m) return "";
  const port = Number(m[2]);
  if (!(port > 0 && port <= 65535)) return "";
  return `${m[1]}:${m[2]}`;
}

export function parseProxyServer(raw) {
  const src = String(raw ?? "").trim();
  if (!src) return "";
  // 无 `=`：单协议形态，原样（校验后）返回，不补前缀
  if (!src.includes("=")) return asHostPort(src);
  // 有 `=`：多协议形态，按 http → https → socks 的优先级取第一个有值的 host:port。
  // 同协议出现多次取第一次；认不出的协议名（ftp 之类）不参与，也不当兜底——
  // 拿错协议的代理去跑 HTTP 请求，和静默直连一样坏。
  const best = new Map([["http", ""], ["https", ""], ["socks", ""]]);
  for (const part of src.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const scheme = part.slice(0, i).trim().toLowerCase();
    if (!best.has(scheme) || best.get(scheme)) continue;
    const value = asHostPort(part.slice(i + 1));
    if (value) best.set(scheme, value);
  }
  return best.get("http") || best.get("https") || best.get("socks") || "";
}

export function readSystemProxy() {
  const none = { enabled: false, server: "", source: "none" };
  try {
    const r = spawnSync("reg", ["query", REG_INET], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    if (r.status !== 0) return none;
    const out = String(r.stdout || "");
    // 值名与类型名是 ASCII，中文系统下 reg 的中文提示乱码也不影响这两条正则。
    const me = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
    const ms = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(out);
    if (!me && !ms) return none;
    // 只有「ProxyEnable=1 且 ProxyServer 非空」才算真有代理；其余一律 none。
    // 两者缺一的组合在真机上见过（历史残留：装机软件改过又删了代理），
    // 报 enabled 却没有 server 会把请求拨到不存在的代理上，比报「没代理」更坏；
    // 报 enabled:false 却留着 server/source，又会让调用方以为有可用配置。
    const enabled = me ? parseInt(me[1], 16) === 1 : false;
    const server = ms ? parseProxyServer(ms[1]) : "";
    if (!enabled || !server) return none;
    return { enabled: true, server, source: "registry" };
  } catch { return none; }
}

// ── ⑧ 用户目录 / 临时目录 / 丢弃设备 ─────────────────────────────────────
// 宿主沙箱会把 USERPROFILE / TEMP 重定向到影子目录（踩坑 53），而 HOMEDRIVE+HOMEPATH
// 不被重定向 —— 所以真实用户目录优先拼这两个。实测：拼出来是 C:\Users\<name>。
export function homeDir() {
  const drive = (process.env.HOMEDRIVE || "").trim();
  const rest = (process.env.HOMEPATH || "").trim();
  if (drive && rest) return drive + rest;
  const profile = (process.env.USERPROFILE || "").trim();
  if (profile) return profile;
  return os.homedir();
}

// TEMP → TMP → os.tmpdir()。与 posix 侧（TMPDIR）保持同一优先级语义。
export function tempDir() {
  for (const k of ["TEMP", "TMP"]) {
    const v = (process.env[k] || "").trim();
    if (v) return v;
  }
  return os.tmpdir();
}

// 丢弃输出去处。Windows 上是 NUL（不是 /dev/null —— curl 在 win 上认 NUL）。
// 写成函数而不是常量，是为了与其它接口同形状、便于测试注入。
export function nullDevice() {
  return "NUL";
}

// pid 是否还活着。只探活不发信号（signal 0）。
// EPERM 也算「活着」：进程存在但不属于我们——对「收孤儿命令」这个用途，
// 报死比报活危险（报死就会跳过清理，而它还占着目录在写）。
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// pid 对应的镜像名（不含 .exe，小写）。拿不到给 ""。
// 用途：restore 收孤儿命令时先核名，避免 PID 被系统复用后误杀无关进程。
export function processNameOf(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return "";
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${n}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8", windowsHide: true, timeout: 5000,
    });
    if (r.status !== 0) return "";
    // CSV 第一行形如 "node.exe","1234","Console","1","12,345 K"
    const m = /^"([^"]+)"/m.exec(String(r.stdout || "").trim());
    if (!m) return "";
    return m[1].replace(/\.exe$/i, "").toLowerCase();
  } catch { return ""; }
}

// ── ⑩ 路径规范化 ────────────────────────────────────────────────────────────
// Windows 不区分大小写，且 `\` 与 `/` 等价。这个函数产出的是**比较键**，
// 不是可用的实际路径 —— 别拿它去 open/read。也不解析符号链接（那要碰磁盘，
// 比较键必须是纯函数才有资格被缓存和单测）。
export function normalizePath(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 3 && s.endsWith("/")) s = s.slice(0, -1); // 保留 "C:/" 这种根
  return s.toLowerCase();
}

// ── ⑨ 能力表 ────────────────────────────────────────────────────────────────
// 键固定三个：pkgManager / proxyControl / reveal。上层只问「有没有」，不问「是不是 win32」。
// pkgManager 必须真实探测（项目铁律）：真调一次 where.exe winget。
// 成功结果缓存；负结果 5 秒后重探 —— 用户当场装完 winget 不必重启引擎。
const PKG_TTL_MS = 5000;
let pkgProbed = false;
let pkgValue = null;
let pkgProbedAt = 0;

function probePkgManager() {
  if (pkgProbed && (pkgValue !== null || Date.now() - pkgProbedAt < PKG_TTL_MS)) return pkgValue;
  const found = which("winget");
  pkgValue = found ? "winget" : null;
  pkgProbed = true;
  pkgProbedAt = Date.now();
  return pkgValue;
}

export const capabilities = Object.freeze({
  get pkgManager() { return probePkgManager(); },
  proxyControl: true, // Windows 专有能力（读注册表 + tasklist/taskkill），posix 侧为 false
  reveal: true,
});
