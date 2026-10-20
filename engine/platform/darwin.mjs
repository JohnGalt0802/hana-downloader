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
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { toNameList, envPathDirs, firstLine, scanDirs, existsFile, scheduleEscalation } from "./which-core.mjs";

export const name = "darwin";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
// 两级：先系统 which，再兜底目录扫描。找不到 / 任何异常 → ""，不抛。
//
// 为什么要兜底：受管进程的 PATH 常被宿主精简，不含 Homebrew / ~/.local/bin
// （外部贡献者 PR #1 在真 Mac 上实测）。只靠 which，`which brew` 会失败 →
// capabilities.pkgManager 报 null →「明明装了 brew 却说没有」，与踩坑 49 同源。
//
// 三个刻意的决定：
//   1. cmd 可以是 string 或 string[]，按顺序找，命中第一个即返回（which(["python3","python"])）。
//   2. **不看 which 的退出码**：`which a b` 有一个命中就打印一个，但仍可能非 0；只解析 stdout。
//   3. 解析出的每行都要过 existsSync —— PR #1 原实现有此校验，保留。
const FALLBACK_DIRS = [
  "/opt/homebrew/bin",   // Apple Silicon Homebrew
  "/usr/local/bin",      // Intel Homebrew + 手工安装
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), "bin"),
  "/usr/bin",
  "/bin",
];

export function which(cmd) {
  const names = toNameList(cmd);
  if (!names.length) return "";
  for (const target of names) {
    try {
      // 不用 r.error / r.status 提前返回：命令不存在或非零退出时 stdout 仍可能是有效答案
      const r = spawnSync("which", [target], { encoding: "utf8", timeout: 5000 });
      const hit = firstLine(r.stdout, existsFile);
      if (hit) return hit;
    } catch { /* 换下一个名字 */ }
  }
  // PATH 里的目录排在静态兜底之前：用户显式配的优先。
  return scanDirs(names, [...envPathDirs(), ...FALLBACK_DIRS], [""], existsFile);
}

// ── ② 可执行文件名 ──────────────────────────────────────────────────────────
// posix 没有后缀约定，原样返回。不加后缀、不改路径、不查存在。
export function exe(n) {
  return String(n ?? "");
}

// ── ③④ 起子进程的默认选项 + 杀进程树 ★ 必须相邻 ────────────────────────────
// detached:true 让子进程自成进程组（pgid = pid），killTree 才能一次杀掉整棵树：
// 引擎被 SIGKILL / 崩溃时，孙子进程（解码器、shell 管道）不会留下孤儿。
//
// 升级窗口放在两个函数之前（不许插在它们中间，单测有结构断言）。
const KILL_TREE_ESCALATE_MS = 5000;

export function spawnOpts(extra) {
  return { detached: true, ...(extra || {}) };
}

// 杀整棵进程树：先 SIGTERM 给收尾机会（aria2c 要写盘），5 秒后进程组还在就 SIGKILL。
// 等价于 win32 的 taskkill /T /F（那边因为只有 /F 才可靠，一次到位）。
// 返回布尔表示「SIGTERM 发出去了」，**同步返回，不在内部 await**。
// 升级用 unref 的 setTimeout：不 unref 会挂住引擎退出（定时器算活跃句柄）。
// 全过程不抛，任何异常都吞掉。
export function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(-n, "SIGTERM"); } catch { return false; }
  // 5 秒后组还在（信号 0 只探活）就 SIGKILL。定时器内部已 unref。
  scheduleEscalation(
    () => { process.kill(-n, 0); return true; },
    () => { process.kill(-n, "SIGKILL"); },
    KILL_TREE_ESCALATE_MS,
  );
  return true;
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

// ── ⑧ 用户目录 / 临时目录 / 丢弃设备 ─────────────────────────────────────
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

// 丢弃输出去处。posix 恒为 /dev/null。
export function nullDevice() {
  return "/dev/null";
}

// pid 是否还活着。signal 0 只探活、不投递。EPERM 算活着（存在但不属于我们）。
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

// ── ⑧-b 进程树探活（killTree 的对应探活，必须成对看）─────────────────────────
// 为什么不能直接用 pidAlive：spawnOpts 给了 detached，子进程自成进程组，
// killTree 杀的是**进程组**而不是组长。组长先死、组员还活着时 pidAlive 报 false，
// 而组仍存在 —— 拿 pidAlive 当探活口径就会跳过清理（2026-10-21 真机复现）。
//
// ★ 但也不能无条件 kill(-pid,0)：只有 pid 确实是**组长**时这个组才是我们的。
//   pid 活着但 pgid ≠ pid 时，-pid 指向别人的组。先核一次 pgid 再选口径：
//     · pid 活着且 pgid ≠ pid → 不是组长，树就是它自己
//     · pid 是组长，或 pid 已死（拿不到 pgid）→ 查组
export function treeAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (pidAlive(n)) {
    const pg = pgidOf(n);
    if (pg > 0 && pg !== n) return true;
  }
  try {
    process.kill(-n, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// 树内还活着的进程名集合（小写 basename）。给收孤儿的核名用。
// 组长死了也要能问到组员。用 ps -A 自己按 pgid 筛：`ps -g` 在 Linux 上是
// 「会话或有效组名」语义，跨平台不一致。口径与 treeAlive 严格一致。
export function treeNames(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return [];
  if (pidAlive(n)) {
    const pg = pgidOf(n);
    if (pg > 0 && pg !== n) {
      const one = processNameOf(n);
      return one ? [one] : [];
    }
  }
  try {
    const r = spawnSync("ps", ["-A", "-o", "pgid=,comm="], { encoding: "utf8", timeout: 5000 });
    if (!r.error && r.status === 0) {
      const out = [];
      for (const line of String(r.stdout || "").split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        if (Number(m[1]) !== n) continue;
        const base = m[2].split("/").pop().trim().toLowerCase();
        if (base) out.push(base);
      }
      if (out.length) return [...new Set(out)];
    }
  } catch { /* 落到下面的单进程退化 */ }
  const one = processNameOf(n);
  return one ? [one] : [];
}

// 读一个 pid 的 pgid。拿不到给 -1（进程已退出 / ps 不可用）。
function pgidOf(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return -1;
  try {
    const r = spawnSync("ps", ["-o", "pgid=", "-p", String(n)], { encoding: "utf8", timeout: 5000 });
    if (r.error || r.status !== 0) return -1;
    const v = Number(String(r.stdout || "").trim());
    return Number.isInteger(v) && v > 0 ? v : -1;
  } catch { return -1; }
}

// pid 对应的命令名（basename，小写）。拿不到给 ""。
// 用途：restore 收孤儿命令时先核名，避开 PID 复用导致的误杀。
export function processNameOf(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return "";
  try {
    const r = spawnSync("ps", ["-p", String(n), "-o", "comm="], { encoding: "utf8", timeout: 5000 });
    if (r.error || r.status !== 0) return "";
    const line = String(r.stdout || "").trim().split(/\r?\n/)[0] || "";
    if (!line) return "";
    // comm 给的是裸名（node / git / uv），但某些平台会给完整路径 —— 统一取 basename
    return line.split("/").pop().trim().toLowerCase();
  } catch { return ""; }
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
// 但**先用 which 解析出绝对路径再 spawn**：GUI / 受管进程的 PATH 常不含 /opt/homebrew/bin，
// 裸 spawn("brew") 会 ENOENT → 断成 null。which 自己有兜底目录（见 ①）。
// 解析不到就退回裸名，尽量保持原行为。
// 成功结果缓存；负结果 5 秒后重探（用户当场装完 brew 不必重启引擎）。
const PKG_TTL_MS = 5000;
let pkgProbed = false;
let pkgValue = null;
let pkgProbedAt = 0;

function probePkgManager() {
  if (pkgProbed && (pkgValue !== null || Date.now() - pkgProbedAt < PKG_TTL_MS)) return pkgValue;
  let found = null;
  try {
    const bin = which("brew") || "brew";
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
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
