// engine/platform/which-core.mjs — which() 的公共骨架（2026-10-21）
//
// 归属：platform 层内部工具，只给 win32 / darwin / linux 三份实现用。
// index.mjs **不** import 本文件、也不导出它 —— 对外仍只有 createPlatform / platform，
// 十组接口契约一个字都没变。三份实现各写一遍「解析 + 兜底扫描」只会慢慢跑偏，所以抽这里。
//
// 为什么要加兜底目录：受管进程的 PATH 常被宿主精简（外部贡献者 PR #1 在真 Mac 上实测：
// 不含 /opt/homebrew/bin、~/.local/bin）。只靠系统 which/where，就会出现「明明装了 brew
// 却说没装」—— 与踩坑 49（装了 aria2c 报没检测到）同源。
//
// 四条纪律：
//   1. which(cmd) 的 cmd 可以是 string，也可以是 string[]；按数组顺序找，命中第一个即返回。
//   2. 系统查找命令**不看退出码**，只解析 stdout，逐行取第一个「可达」的路径：
//      PR #1 原话「`which a b` 有一个命中就打印一个，但仍可能返回非 0」。
//   3. 系统命令没找到才扫兜底目录；PATH 里的目录排最前（用户显式配的优先）。
//   4. **不做任何缓存**。兜底扫描是若干次 lstat/existsSync，代价可接受；缓存策略是另一件事
//      （capabilities.pkgManager 已有自己的 5 秒负缓存），别在这一层夹带。
import fs from "node:fs";
import path from "node:path";

// cmd → 有序的名字列表；任何不合规输入给 []（调用方据此返回 ""，不抛）。
// 数组里混入非字符串 / 空串 → **整条作废**返回 []，而不是跳过那一项：静默跳过会让
// `which(["python3", undefined])` 悄悄退化成 `which("python3")`，比返回空更难查。
export function toNameList(cmd) {
  if (typeof cmd === "string") {
    const t = cmd.trim();
    return t ? [t] : [];
  }
  if (!Array.isArray(cmd)) return [];
  const out = [];
  for (const x of cmd) {
    if (typeof x !== "string") return [];
    const t = x.trim();
    if (!t) return [];
    out.push(t);
  }
  return out;
}

// process.env.PATH 拆成目录列表（按平台分隔符）。空段丢掉（尾部 ";" 很常见）。
export function envPathDirs() {
  const raw = String(process.env.PATH || "");
  return raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
}

// 逐行取第一个 accept 通过的行。不看退出码 —— 退出码在本用途上不可靠（见头注释 2）。
export function firstLine(stdout, accept) {
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    try { if (accept(p)) return p; } catch { /* 换下一行 */ }
  }
  return "";
}

// 在若干目录 × 若干后缀里找第一个可达的候选，返回绝对路径或 ""。
export function scanDirs(names, dirs, exts, accept) {
  for (const nm of names) {
    for (const dir of dirs) {
      if (!dir) continue;
      for (const ext of exts) {
        const p = path.join(dir, nm + ext);
        try { if (accept(p)) return p; } catch { /* 换下一个候选 */ }
      }
    }
  }
  return "";
}

// posix 的「可达」判定：文件系统里真有这条路径。
export function existsFile(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

// Windows 的「可达」判定：**lstat** 而不是 existsSync。
// 本机实测（2026-10-21）：winget 是 App Execution Alias（0 字节重定向桩），
//   existsSync(...\WindowsApps\winget.exe) → false
//   statSync   → EACCES
//   lstatSync  → 成功（符号链接 99 字节）
// 用 existsSync 过滤会把「明明能跑的 winget」判死，pkgManager 直接变 null（踩坑 53 同源）。
// lstat 只问「文件系统里有这个东西」，不跟随重定向桩。
export function lstatsFile(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

// SIGTERM 之后的升级：delayMs 后若 probeAlive() 仍为真就 sendKill()。
// 抽出来是为了能实测三件事（killTree 本体只能在真 posix 上跑到，Windows 上跑不到）：
//   ① 延时到了才发；② 组已解散就不发；③ 定时器必须 unref，否则挂住引擎退出。
// 返回定时器对象（已被 unref）；起不来返回 null。**不抛**。
export function scheduleEscalation(probeAlive, sendKill, delayMs) {
  try {
    const t = setTimeout(() => {
      try { if (probeAlive()) sendKill(); } catch { /* 探活失败 = 组已不在 */ }
    }, delayMs);
    if (t && typeof t.unref === "function") t.unref();
    return t ?? null;
  } catch { return null; }
}
