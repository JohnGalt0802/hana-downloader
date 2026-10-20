// engine/platform/linux.mjs — 平台适配层的 Linux 实现（P1-2，2026-10-20）
//
// 归属：docs/跨平台适配层重构方案-20261019.md §3.2（十组接口）+ §3.3（三条设计原则）
//
// 与 win32.mjs 同一套约定（读那个文件的头注释即可，这里只写 linux 侧的差异）：
//   1. 探测类接口（which / isRunning / readSystemProxy / capabilities）失败一律返回
//      「空结果」，绝不抛。调用方不需要 try/catch。
//   2. 能力必须来自真实往返：pkgManager 真调 `brew/apt/dnf/pacman --version`，不看路径。
//   3. spawn 出去的东西必须挂 'error' 监听 —— 没挂的 'error' 是未捕获异常。
//
// ★ 顺序纪律：spawnOpts 与 killTree 必须相邻（方案 §3.3 原则一）。posix 侧
//   detached:true 与 kill(-pid) 是同一枚硬币的两面：detached 让子进程成为新进程组
//   组长，kill(-pid) 才有「组」可杀。拆开就会重现 dlcore.js 的老缺陷。
//
// ★ 本文件只在 Windows 上靠参数注入单测验过逻辑（tests/unit-platform.mjs），
//   **真机（Linux）行为未验证**。改动前先在真机上跑一遍 which/pgrep/gsettings/xdg-open。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { toNameList, envPathDirs, firstLine, scanDirs, existsFile, scheduleEscalation } from "./which-core.mjs";

export const name = "linux";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
// 两级：先系统 which，再兜底目录扫描。找不到 / 任何异常 → ""，不抛。
//
// 为什么要兜底：受管进程的 PATH 常被宿主精简（外部贡献者 PR #1 在真 Mac 上实测，
// Linux 同理：systemd / 容器 / 精简 shell 都可能不含 ~/.local/bin）。只靠 which 会
// 把「明明装了 aria2c」报成没装（踩坑 49）。
//
// 三个刻意的决定：
//   1. cmd 可以是 string 或 string[]，按顺序找，命中第一个即返回。
//   2. **不看 which 的退出码**：`which a b` 有一个命中就打印一个，但仍可能非 0；只解析 stdout。
//   3. 解析出的每行都要过 existsSync —— PR #1 原实现有此校验，保留。
const FALLBACK_DIRS = [
  "/opt/homebrew/bin",           // Homebrew on Linux（极少数装这里）
  "/usr/local/bin",              // Linuxbrew / 手工安装
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), "bin"),
  "/usr/bin",
  "/bin",
  "/snap/bin",                   // snap 装的命令行工具
  "/usr/local/sbin",
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
// 引擎被 SIGKILL 时，孙子进程（解码器、shell 管道）不会留下孤儿。
//
// 升级窗口放在两个函数之前（不许插在它们中间，单测有结构断言）。
const KILL_TREE_ESCALATE_MS = 5000;

export function spawnOpts(extra) {
  return { detached: true, ...(extra || {}) };
}

// 杀整棵进程树：先 SIGTERM 给收尾机会（aria2c 要写盘），5 秒后进程组还在就 SIGKILL。
// 等价于 win32 的 taskkill /T /F。返回布尔表示「SIGTERM 发出去了」，
// **同步返回，不在内部 await**。升级用 unref 的 setTimeout：不 unref 会挂住引擎退出。
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
// pgrep -x：全名精确匹配，避免 `aria2` 命中 `aria2c-helper`。只看退出码
// （0 = 至少命中一个），不解析输出文本，语言环境与编码都不影响。
export function isRunning(nm) {
  const base = String(nm ?? "").trim();
  if (!base) return false;
  try {
    const r = spawnSync("pgrep", ["-x", base], { encoding: "utf8", timeout: 5000 });
    return r.error ? false : r.status === 0;
  } catch { return false; }
}

// ── ⑥ 打开文件所在位置 ──────────────────────────────────────────────────────
// Linux 的文件管理器没有跨桌面环境的「在目录里选中文件」标准语义，所以 select
// 降级为打开父目录（xdg-open <dirname>）；mode=open 打开文件自己。
// **永远不抛**，返回 {ok, error?} 让上层决定怎么提示。
export function reveal(p, mode) {
  const target = String(p ?? "");
  if (!target) return { ok: false, error: "路径为空" };
  let exists = false;
  try { exists = fs.existsSync(target); } catch { exists = false; }
  // 先自查存在性：xdg-open 对不存在的路径也只会静默失败或起一个报错窗口，不如直接说清。
  if (!exists) return { ok: false, error: `路径不存在：${target}` };
  try {
    let arg = target;
    if (mode === "select") {
      const dir = path.dirname(target);
      // 路径本身是目录时 dirname 会退到上一级，这里保持「打开它自己」更符合预期
      arg = dir && dir !== target ? dir : target;
    }
    const child = spawn("xdg-open", [arg], { detached: true, stdio: "ignore" });
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
// 两级：① 环境变量（http_proxy / https_proxy / all_proxy，大小写两种都看，命令行
// 场景下用户常用小写）② GNOME 的 gsettings 桌面设置（图形会话里梯子客户端写的是这里）。
// 都没有 → {enabled:false, server:"", source:"none"}，不抛。
const NONE_PROXY = { enabled: false, server: "", source: "none" };

// 环境变量里可能是 `http://127.0.0.1:7890`、`127.0.0.1:7890`、末尾带 `/`、
// 甚至带 user:pass@。这里只做「剥 scheme + 去尾斜杠 + 砍掉路径」，输出 host:port。
// 端口缺失时原样保留主机，**不猜默认端口**：猜错会让请求静默走错代理，比留空更坏。
export function normalizeProxyServer(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ""); // 剥 scheme
  s = s.replace(/^.*@/, "");                           // 剥 user:pass@
  s = s.split("/")[0].split("?")[0].split("#")[0];      // 砍路径/查询
  s = s.trim();
  return s;
}

export function readSystemProxy() {
  // ① 环境变量。大小写两种都看；同一协议小写优先（惯例）。
  for (const [keys] of [[["http_proxy", "HTTP_PROXY"]],
    [["https_proxy", "HTTPS_PROXY"]],
    [["all_proxy", "ALL_PROXY"]]]) {
    for (const k of keys) {
      const server = normalizeProxyServer(process.env[k]);
      if (server) return { enabled: true, server, source: "env" };
    }
  }

  // ② gsettings。只有 mode 为 'manual' 才算启用；auto/none 一律没有代理。
  try {
    const mode = gsettingsGet("org.gnome.system.proxy", "mode");
    if (mode === "manual") {
      // 先 http 再 https，与 darwin 侧同一优先级；主机与端口都要非空。
      for (const scheme of ["http", "https"]) {
        const host = gsettingsGet(`org.gnome.system.proxy.${scheme}`, "host");
        const port = gsettingsGet(`org.gnome.system.proxy.${scheme}`, "port");
        if (!host || !port || !/^\d+$/.test(port)) continue;
        return { enabled: true, server: `${host}:${port}`, source: "gsettings" };
      }
    }
  } catch { /* gsettings 不存在 / 非 GNOME 会话 → 当作没有 */ }

  return { ...NONE_PROXY };
}

// 读一个 gsettings 值，去掉它带的单引号（字符串值形如 'manual'），失败返回 ""。
// 单独导出给单测：不碰命令，只测「命令行输出 → 值」这一步。
export function parseGsettingsValue(text) {
  let s = String(text ?? "").trim();
  if (!s || s === "@as []") return "";
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith("\"") && s.endsWith("\""))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function gsettingsGet(schema, key) {
  try {
    const r = spawnSync("gsettings", ["get", schema, key], {
      encoding: "utf8", timeout: 5000,
    });
    if (r.error || r.status !== 0) return "";
    return parseGsettingsValue(r.stdout);
  } catch { return ""; }
}

// ── ⑧ 用户目录 / 临时目录 / 丢弃设备 ─────────────────────────────────────
// os.homedir() 读 HOME（root 下读 /root）。取不到再兜底读环境变量。
export function homeDir() {
  try {
    const h = os.homedir();
    if (h && String(h).trim()) return String(h);
  } catch { /* 落到下面的兜底 */ }
  return (process.env.HOME || "").trim();
}

// TMPDIR → TMP → os.tmpdir()。TMP 是给「按 Windows 习惯设了 TMP 的环境」兜底用的，
// 纯 Linux 上通常只有 TMPDIR。
export function tempDir() {
  for (const k of ["TMPDIR", "TMP"]) {
    const v = (process.env[k] || "").trim();
    if (v) return v;
  }
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
    return line.split("/").pop().trim().toLowerCase();
  } catch { return ""; }
}

// ── ⑩ 路径规范化 ────────────────────────────────────────────────────────────
// 与 win32 同构，唯一差别：**不 toLowerCase**。Linux 文件系统普遍大小写敏感，
// 抹平大小写会把两个真实不同的文件判成同一个。这个函数产出的是比较键，
// 别拿它去 open/read。
export function normalizePath(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1); // 保留 "/" 根
  return s;
}

// ── ⑨ 能力表 ────────────────────────────────────────────────────────────────
// 键固定三个：pkgManager / proxyControl / reveal。
// pkgManager 依次真实探测 brew → apt → dnf → pacman，第一个 `--version` 退出 0 的胜出；
// 不看路径上有没有文件（项目铁律）；但 spawn 用 which 解出的绝对路径（见下）。
// 成功结果缓存；负结果 5 秒后重探（用户当场装完包管理器不必重启引擎）。
const PKG_CANDIDATES = ["brew", "apt", "dnf", "pacman"];
const PKG_TTL_MS = 5000;
let pkgProbed = false;
let pkgValue = null;
let pkgProbedAt = 0;

function probePkgManager() {
  if (pkgProbed && (pkgValue !== null || Date.now() - pkgProbedAt < PKG_TTL_MS)) return pkgValue;
  let found = null;
  for (const cmd of PKG_CANDIDATES) {
    try {
      // 先用 which 解析绝对路径（兼顶 PATH 被精简 + 兜底目录），解不到才裸名
      const bin = which(cmd) || cmd;
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
      if (!r.error && r.status === 0 && String(r.stdout || "").trim()) { found = cmd; break; }
    } catch { /* 换下一个 */ }
  }
  pkgValue = found;
  pkgProbed = true;
  pkgProbedAt = Date.now();
  return pkgValue;
}

export const capabilities = Object.freeze({
  get pkgManager() { return probePkgManager(); },
  // false：proxy-control.js 那套「扫安装目录 + tasklist/taskkill 杀进程」的梯子控制
  // 在 Linux 上不成立（阶段三裁掉）。**这不影响 readSystemProxy** —— 读系统代理
  // 照常可用，两件事别混。上层看到 proxyControl:false 应隐藏梯子控制入口。
  proxyControl: false,
  reveal: true,
});
