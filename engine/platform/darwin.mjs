// engine/platform/darwin.mjs — 平台适配层的 macOS 实现（P1-2，2026-10-20）
//
// 归属：docs/跨平台适配层重构方案-20261019.md §3.2（十组接口）+ §3.3（三条设计原则）
//
// 与 win32.mjs 同一套约定（读那个文件的头注释即可，这里只写 mac 侧的差异）：
//   1. 探测类接口（which / isRunning / readSystemProxy / capabilities）失败一律返回
//      「空结果」，绝不抛。调用方不需要 try/catch。
//   2. 能力必须来自真实往返：pkgManager 真调一次 `brew --version`，不看路径上有没有文件。
//   3. spawn 出去的东西必须挂 'error' 监听 —— 没挂的 'error' 是未捕获异常。
//
// ★ 顺序纪律：spawnOpts 与 killTree 必须相邻（方案 §3.3 原则一）。posix 侧
//   detached:true 与 kill(-pid) 是同一枚硬币的两面：detached 让子进程成为新进程组
//   组长，kill(-pid) 才有「组」可杀。拆开就会重现 dlcore.js 的老缺陷。
//
// ★ 本文件只在 Windows 上靠参数注入单测验过逻辑（tests/unit-platform.mjs），
//   **真机（macOS）行为未验证**。改动前先在真机上跑一遍 which/pgrep/scutil/open。
import fs from "node:fs";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

export const name = "darwin";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
// 用系统的 /usr/bin/which。找不到 / 命令不存在 / 非零退出 → ""，不抛。
// 刻意不拿 existsSync 二次过滤：which 自己就查过 PATH 与可执行位，返回 0 即已确认；
// 再过滤一次只会让「明明能跑的东西」被误判（win32.mjs 里同样的坑，踩坑 53 同源）。
export function which(cmd) {
  const target = String(cmd ?? "").trim();
  if (!target) return "";
  try {
    const r = spawnSync("which", [target], { encoding: "utf8", timeout: 5000 });
    if (r.error || r.status !== 0) return "";
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      const p = line.trim();
      if (p) return p;
    }
    return "";
  } catch { return ""; }
}

// ── ② 可执行文件名 ──────────────────────────────────────────────────────────
// posix 没有后缀约定，原样返回。不加后缀、不改路径、不查存在。
export function exe(n) {
  return String(n ?? "");
}

// ── ③④ 起子进程的默认选项 + 杀进程树 ★ 必须相邻 ────────────────────────────
// detached:true 让子进程自成进程组（pgid = pid），killTree 才能一次杀掉整棵树：
// 引擎被 SIGKILL / 崩溃时，孙子进程（解码器、shell 管道）不会留下孤儿。
export function spawnOpts(extra) {
  return { detached: true, ...(extra || {}) };
}

// 杀整棵进程树：向进程组 -pid 发信号。失败（组已解散 / 权限不足 / 平台不支持
// 负 pid）返回 false，不抛。用 SIGTERM 而非 SIGKILL：让 aria2c 有机会收尾写盘，
// 与 win32 的 taskkill /T 语义对齐（win32 那边因为 taskkill 只有 /F 才可靠）。
export function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(-n, "SIGTERM");
    return true;
  } catch { return false; }
}

// ── ⑤ 进程是否在跑（按名字）─────────────────────────────────────────────────
// pgrep -x：全名精确匹配，避免 `aria2` 命中 `aria2c-helper` 这类前缀误判。
// 不解析输出文本，只看退出码（0 = 至少命中一个），语言环境与编码都不影响。
export function isRunning(nm) {
  const base = String(nm ?? "").trim();
  if (!base) return false;
  try {
    const r = spawnSync("pgrep", ["-x", base], { encoding: "utf8", timeout: 5000 });
    return r.error ? false : r.status === 0;
  } catch { return false; }
}

// ── ⑥ 打开文件所在位置 ──────────────────────────────────────────────────────
// mode: "open" → open <path>（默认关联程序打开）；"select" → open -R <path>
// （Finder 里定位并选中）。**永远不抛**，返回 {ok, error?} 让上层决定怎么提示。
export function reveal(p, mode) {
  const target = String(p ?? "");
  if (!target) return { ok: false, error: "路径为空" };
  let exists = false;
  try { exists = fs.existsSync(target); } catch { exists = false; }
  // 先自查存在性：open 对不存在的路径会起一个 GUI 报错，比返回 false 更难收拾。
  if (!exists) return { ok: false, error: `路径不存在：${target}` };
  try {
    const args = mode === "select" ? ["-R", target] : [target];
    const child = spawn("open", args, { detached: true, stdio: "ignore" });
    // ★ 必须挂 error 监听：未处理的 'error' 会变成未捕获异常，直接带走引擎进程
    //  （server.js:484 的历史缺陷）。这里从源头堵住。
    child.on("error", () => { /* 只保证不炸，失败由上层从 {ok:false} 反映 */ });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── ⑦ 读系统代理 ────────────────────────────────────────────────────────────
// `scutil --proxy` 输出的是 plist 文本，长这样：
//   <dictionary> {
//     HTTPEnable : 1
//     HTTPPort : 7890
//     HTTPProxy : 127.0.0.1
//     HTTPSEnable : 1
//     ...
//   }
// 只认「键 : 值」这种扁平行，不引入 plist 解析器（它是纯文本 key-value，不需要）。
const NONE_PROXY = { enabled: false, server: "", source: "none" };

// 纯文本解析，单独导出给单测用：不碰命令、不碰环境，只吃字符串。
// 容三种形态：①有代理 ②无代理（*Enable 为 0 或键缺失）③垃圾文本/空 → 一律 none。
// 先看 HTTP，没有再翻 HTTPS；主机与端口都非空才算有效（半个条目比没有更危险）。
export function parseScutilProxy(text) {
  const src = String(text ?? "");
  if (!src) return { ...NONE_PROXY };
  const kv = new Map();
  for (const line of src.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(\S.*?)\s*$/.exec(line);
    if (m) kv.set(m[1], m[2]);
  }
  for (const scheme of ["HTTP", "HTTPS"]) {
    const flag = (kv.get(`${scheme}Enable`) || "").trim();
    const host = (kv.get(`${scheme}Proxy`) || "").trim();
    const port = (kv.get(`${scheme}Port`) || "").trim();
    if (flag !== "1") continue;
    if (!host || !port) continue;
    if (!/^\d+$/.test(port)) continue;
    return { enabled: true, server: `${host}:${port}`, source: "scutil" };
  }
  return { ...NONE_PROXY };
}

export function readSystemProxy() {
  try {
    const r = spawnSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 5000 });
    if (r.error || r.status !== 0) return { ...NONE_PROXY };
    return parseScutilProxy(r.stdout);
  } catch { return { ...NONE_PROXY }; }
}

// ── ⑧ 用户目录 / 临时目录 ───────────────────────────────────────────────────
// mac 上没有 win32 那套 USERPROFILE 沙箱重定向，os.homedir() 直接读 HOME，够用。
export function homeDir() {
  try {
    const h = os.homedir();
    if (h && String(h).trim()) return String(h);
  } catch { /* 落到下面的兜底 */ }
  return (process.env.HOME || "").trim();
}

// TMPDIR → os.tmpdir()。macOS 的 TMPDIR 是每用户私有目录
// （/var/folders/xx/.../T/），比 /tmp 更贴系统预期，所以优先它。
export function tempDir() {
  const t = (process.env.TMPDIR || "").trim();
  if (t) return t;
  return os.tmpdir();
}

// ── ⑩ 路径规范化 ────────────────────────────────────────────────────────────
// 与 win32 同构，唯一差别：**不 toLowerCase**。APFS 默认大小写不敏感、但可格式化为
// 大小写敏感，两种卷同时存在 —— 把大小写抹平会把两个真实不同的文件判成同一个。
// 这个函数产出的是比较键，别拿它去 open/read。
export function normalizePath(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1); // 保留 "/" 根
  return s;
}

// ── ⑨ 能力表 ────────────────────────────────────────────────────────────────
// 键固定三个：pkgManager / proxyControl / reveal。
// pkgManager 必须真实探测（项目铁律）：真调一次 `brew --version`，不看路径。
// 注意这里**不做** /opt/homebrew/bin 之类的路径兜底：靠 PATH 找不到就是找不到，
// GUI 启动的进程 PATH 可能不含 brew —— 真机上若确认这是问题，再单独加探测路径。
// 成功结果缓存；负结果 5 秒后重探（用户当场装完 brew 不必重启引擎）。
const PKG_TTL_MS = 5000;
let pkgProbed = false;
let pkgValue = null;
let pkgProbedAt = 0;

function probePkgManager() {
  if (pkgProbed && (pkgValue !== null || Date.now() - pkgProbedAt < PKG_TTL_MS)) return pkgValue;
  let found = null;
  try {
    const r = spawnSync("brew", ["--version"], { encoding: "utf8", timeout: 5000 });
    if (!r.error && r.status === 0 && String(r.stdout || "").trim()) found = "brew";
  } catch { found = null; }
  pkgValue = found;
  pkgProbed = true;
  pkgProbedAt = Date.now();
  return pkgValue;
}

export const capabilities = Object.freeze({
  get pkgManager() { return probePkgManager(); },
  // false：proxy-control.js 那套「扫安装目录 + tasklist/taskkill 杀进程」的梯子控制
  // 在 mac 上不成立（阶段三裁掉）。**这不影响 readSystemProxy** —— 读系统代理照常可用，
  // 两件事别混。上层看到 proxyControl:false 应隐藏梯子控制入口，而不是跳过代理设置。
  proxyControl: false,
  reveal: true,
});
