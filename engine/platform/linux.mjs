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

export const name = "linux";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
// 用系统的 which。找不到 / 命令不存在 / 非零退出 → ""，不抛。
// 同样不做 existsSync 二次过滤（which 已确认可达，再过滤只会误杀，踩坑 53 同源）。
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
// 引擎被 SIGKILL 时，孙子进程（解码器、shell 管道）不会留下孤儿。
export function spawnOpts(extra) {
  return { detached: true, ...(extra || {}) };
}

// 杀整棵进程树：向进程组 -pid 发信号。失败（组已解散 / 权限不足 / 平台不支持
// 负 pid）返回 false，不抛。SIGTERM 而非 SIGKILL：让 aria2c 有机会收尾写盘。
export function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(-n, "SIGTERM");
    return true;
  } catch { return false; }
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

// ── ⑧ 用户目录 / 临时目录 ───────────────────────────────────────────────────
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
// 全失败给 null。不看路径上有没有文件（项目铁律）。
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
      const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 5000 });
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
