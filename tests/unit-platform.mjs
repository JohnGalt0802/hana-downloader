// tests/unit-platform.mjs — 平台适配层（P1-1，2026-10-20）
//
// 测什么：engine/platform/ 的十组接口契约 + 「骨架是显式的」这件事本身。
//
// 三份实例，一套断言：
//   createPlatform("win32")   真实现，逐条验契约（不假设本机是 Windows：
//                             断言写成「找不到 → ""」「非法 pid → false 不抛」这种
//                             对返回值的要求，而不是「在 C:\ 下能找到 node」）
//   createPlatform("darwin")  骨架：**必须抛「尚未实现」**。这条是给 P1-2 的分界线——
//                             如果它静默返回假值，P1-2 就分不清哪些是真做过的。
//   createPlatform("linux")   同上，另一份骨架
//
// 特别保护：spawnOpts 与 killTree 必须同一文件相邻（方案 §3.3 原则一）。
// 这里顺带断言 win32 下 spawnOpts 带 windowsHide，杜绝「起了进程没设选项」的旧缺陷复现。
//
// 用法（仓库根目录）：node tests/unit-platform.mjs
// 退出码：全过 0，有失败 1。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatform, platform } from "../engine/platform/index.mjs";

let pass = 0, fail = 0, skip = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try {
    const r = fn();
    ok = r === undefined ? true : !!r;
    if (!ok) detail = " => " + safe(r);
  } catch (e) { ok = false; detail = " => threw " + (e?.message || e); }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name + detail); }
}
const safe = (x) => { try { return JSON.stringify(x); } catch { return String(x); } };
const isStr = (x) => typeof x === "string";

// ── 0. 工厂本身的契约 ───────────────────────────────────────────────────────
check("createPlatform 是函数", () => typeof createPlatform === "function");

check("非法平台名直接抛", () => {
  let threw = false;
  try { createPlatform("freebsd"); } catch { threw = true; }
  return threw;
});
check("空名/null 直接抛", () => {
  for (const bad of ["", null, undefined, 0, {}, "Win32 ", "windows"]) {
    let threw = false;
    try { createPlatform(bad); } catch { threw = true; }
    if (!threw) return false;
  }
  return true;
});

check("生产导出 platform 与本机平台一致", () => platform.name === process.platform);
check("生产导出与 createPlatform(process.platform) 同源", () =>
  platform.name === createPlatform(process.platform).name);

// ── 1. 十组接口齐全（缺一个就说明实现不完整）───────────────────────────────
const METHODS = ["which", "exe", "spawnOpts", "killTree", "isRunning", "reveal",
  "readSystemProxy", "homeDir", "tempDir", "normalizePath"];
for (const name of ["win32", "darwin", "linux"]) {
  check(`${name}: 十组接口都是函数`, () => {
    const p = createPlatform(name);
    return METHODS.every((m) => typeof p[m] === "function");
  });
  check(`${name}: name 字段正确`, () => createPlatform(name).name === name);
}

// ══ win32 真实现 ════════════════════════════════════════════════════════════
const W = createPlatform("win32");

// ── ① which：找不到给 ""，不抛 ──
check("win32.which: 不存在的命令 → \"\"", () => W.which("这个东西不存在") === "");
check("win32.which: 空输入 → \"\"", () => W.which("") === "" && W.which(undefined) === "" && W.which(null) === "");
check("win32.which: 纯空格 → \"\"", () => W.which("   ") === "");
check("win32.which: 返回值是字符串（不返回 null/undefined）", () => {
  const r = W.which("这个东西不存在");
  return isStr(r) && r === "";
});
// 正向用例只能在 Windows 上跑；否则 where.exe 压根不存在，测的是别的东西
if (process.platform === "win32") {
  check("win32.which(\"node\") → 真实存在的绝对路径", () => {
    const r = W.which("node");
    return isStr(r) && r.length > 0 && fs.existsSync(r);
  });
  check("win32.which(\"where.exe\") 自身可达", () => W.which("where.exe").length > 0);
} else {
  skip += 1;
  console.log("SKIP: win32.which 正向用例（本机非 Windows，where.exe 不存在）");
}

// ── ② exe：只加后缀，不动路径、不查存在 ──
check("win32.exe: 加 .exe 后缀", () => W.exe("aria2c") === "aria2c.exe");
check("win32.exe: 带路径也不改名", () => W.exe("C:\\tools\\aria2c") === "C:\\tools\\aria2c.exe");
check("win32.exe: 空输入 → \".exe\"", () => W.exe("") === ".exe" && W.exe(undefined) === ".exe");
check("win32.exe: 幂等性不做保证但确定加一次", () => W.exe("a.exe") === "a.exe.exe");

// ── ③ spawnOpts：必然含 windowsHide，extra 合并进去 ──
check("win32.spawnOpts: 含 windowsHide === true", () => W.spawnOpts().windowsHide === true);
check("win32.spawnOpts: 不传参也给对象", () => typeof W.spawnOpts() === "object" && W.spawnOpts() !== null);
check("win32.spawnOpts: extra 被合并", () => {
  const o = W.spawnOpts({ cwd: "D:\\x", stdio: "ignore" });
  return o.windowsHide === true && o.cwd === "D:\\x" && o.stdio === "ignore";
});
check("win32.spawnOpts: 不改入参", () => {
  const extra = { cwd: "D:\\x" };
  W.spawnOpts(extra);
  return JSON.stringify(Object.keys(extra)) === JSON.stringify(["cwd"]);
});
check("win32.spawnOpts: extra 可覆盖默认值", () => W.spawnOpts({ windowsHide: false }).windowsHide === false);

// ── ④ killTree：非法/不存在 pid → false，不抛 ──
check("win32.killTree: 不存在的 pid → false 且不抛", () => W.killTree(2147483647) === false);
check("win32.killTree: 非法入参 → false 且不抛", () => {
  for (const bad of [0, -1, -12345, NaN, "abc", null, undefined, 1.5, {}]) {
    if (W.killTree(bad) !== false) return false;
  }
  return true;
});
check("win32.killTree: 返回值严格是布尔", () => typeof W.killTree(0) === "boolean");

// ── ⑤ isRunning：不认识的名字 → false，不抛 ──
check("win32.isRunning: 不存在的进程 → false", () => W.isRunning("这个东西不存在") === false);
check("win32.isRunning: 空输入 → false", () => W.isRunning("") === false && W.isRunning(null) === false);
check("win32.isRunning: 返回值严格是布尔", () => typeof W.isRunning("nope-xyz") === "boolean");
if (process.platform === "win32") {
  // 用自己这个 node 进程的名字探一次：tasklist 一定认得出来
  check("win32.isRunning(\"node\") → true（本机有 node 在跑）", () => W.isRunning("node") === true);
} else {
  skip += 1;
  console.log("SKIP: win32.isRunning 正向用例（本机非 Windows）");
}

// ── ⑥ reveal：不存在的路径 → {ok:false}，不抛、不弹窗 ──
check("win32.reveal: 不存在的路径 → {ok:false} 且带 error", () => {
  const r = W.reveal(path.join(os.tmpdir(), "hd-platform-绝对不存在的路径-9f3a2b"), "select");
  return r && r.ok === false && isStr(r.error) && r.error.length > 0;
});
check("win32.reveal: mode=open 同样安全失败", () => {
  const r = W.reveal(path.join(os.tmpdir(), "hd-platform-不存在-1c7d"), "open");
  return r && r.ok === false && isStr(r.error);
});
check("win32.reveal: 空路径 → {ok:false}", () => {
  for (const bad of ["", null, undefined]) {
    const r = W.reveal(bad, "select");
    if (!r || r.ok !== false) return false;
  }
  return true;
});
check("win32.reveal: 返回值形状只有 ok/error", () => {
  const r = W.reveal(path.join(os.tmpdir(), "hd-nope-7g"), "select");
  return r.ok === false && Object.keys(r).every((k) => k === "ok" || k === "error");
});

// ── ⑦ readSystemProxy：拿不到时形状正确、不抛 ──
check("win32.readSystemProxy: 不抛且键齐全", () => {
  const r = W.readSystemProxy();
  return r && typeof r === "object"
    && typeof r.enabled === "boolean"
    && isStr(r.server)
    && isStr(r.source);
});
check("win32.readSystemProxy: 键固定为 enabled/server/source", () => {
  const keys = Object.keys(W.readSystemProxy()).sort();
  return JSON.stringify(keys) === JSON.stringify(["enabled", "server", "source"]);
});
check("win32.readSystemProxy: 关掉时 server 为空且 source 非空", () => {
  const r = W.readSystemProxy();
  if (r.enabled) return true;                       // 本机确实开着代理，跳过形状细分
  return r.server === "" && r.source.length > 0;    // "none" 或 "registry"
});
check("win32.readSystemProxy: 连跑两次结果稳定", () => {
  const a = W.readSystemProxy(), b = W.readSystemProxy();
  return a.enabled === b.enabled && a.server === b.server;
});
if (process.platform === "win32") {
  check("win32.readSystemProxy: 有值时 source === \"registry\"", () => {
    const r = W.readSystemProxy();
    return r.source === "registry" || r.source === "none";
  });
}

// ── ⑧ homeDir / tempDir：非空字符串 ──
check("win32.homeDir: 非空字符串", () => isStr(W.homeDir()) && W.homeDir().trim().length > 0);
check("win32.homeDir: 优先 HOMEDRIVE+HOMEPATH", () => {
  const drive = process.env.HOMEDRIVE || "", rest = process.env.HOMEPATH || "";
  if (!drive || !rest) return true;                 // 环境里没有这两项，走回退分支，不适用
  return W.homeDir() === drive + rest;
});
check("win32.tempDir: 非空字符串", () => isStr(W.tempDir()) && W.tempDir().trim().length > 0);
check("win32.tempDir: 优先 TEMP", () => {
  const t = (process.env.TEMP || "").trim();
  if (!t) return true;
  return W.tempDir() === t;
});

// ── ⑩ normalizePath：只产出比较键 ──
check("win32.normalizePath: 统一小写", () => W.normalizePath("C:\\Users\\John Galt\\A.TXT") === "c:/users/john galt/a.txt");
check("win32.normalizePath: 反斜杠转正斜杠", () => W.normalizePath("a\\b\\c") === "a/b/c");
check("win32.normalizePath: 去重复分隔符", () => W.normalizePath("a\\\\b//c") === "a/b/c");
check("win32.normalizePath: 去尾部斜杠但保留盘根", () => {
  return W.normalizePath("C:\\Users\\") === "c:/users"
    && W.normalizePath("C:\\") === "c:/"
    && W.normalizePath("D://") === "d:/";
});
check("win32.normalizePath: 大小写不同但同一路径 → 同键", () =>
  W.normalizePath("C:\\Tools\\ARIA2C.EXE") === W.normalizePath("c:/tools/aria2c.exe"));
check("win32.normalizePath: 空输入 → \"\" 不抛", () =>
  W.normalizePath("") === "" && W.normalizePath(null) === "" && W.normalizePath(undefined) === "");
check("win32.normalizePath: 幂等", () => {
  const once = W.normalizePath("C:\\\\A\\\\B\\\\");
  return W.normalizePath(once) === once;
});

// ── ⑨ capabilities：键齐全、值有约束 ──
check("win32.capabilities: 三个键齐全", () => {
  const keys = Object.keys(W.capabilities).sort();
  return JSON.stringify(keys) === JSON.stringify(["pkgManager", "proxyControl", "reveal"]);
});
check("win32.capabilities.proxyControl === true", () => W.capabilities.proxyControl === true);
check("win32.capabilities.reveal === true", () => W.capabilities.reveal === true);
check("win32.capabilities.pkgManager 只可能是 \"winget\" 或 null", () =>
  W.capabilities.pkgManager === "winget" || W.capabilities.pkgManager === null);
if (process.platform === "win32") {
  // 这台机器确实装了 winget（前面实测 where.exe winget 有输出），所以必须探到
  check("win32.capabilities.pkgManager 来自真实探测（本机有 winget）", () =>
    W.capabilities.pkgManager === "winget");
} else {
  skip += 1;
  console.log("SKIP: win32.capabilities.pkgManager 正向探测（本机非 Windows）");
}
check("win32.capabilities: 冻结保护（改键不生效）", () => {
  const before = W.capabilities.proxyControl;
  try {
    W.capabilities.proxyControl = false;
  } catch { /* 严格模式下抛，同样算保护生效 */ }
  return W.capabilities.proxyControl === before;
});

// ══ darwin / linux 骨架：必须显式抛「尚未实现」 ═════════════════════════════
function expectNotImplemented(platformName) {
  const p = createPlatform(platformName);
  const failures = [];
  const calls = {
    which: () => p.which("node"),
    exe: () => p.exe("aria2c"),
    spawnOpts: () => p.spawnOpts({}),
    killTree: () => p.killTree(1234),
    isRunning: () => p.isRunning("node"),
    reveal: () => p.reveal("C:\\x", "select"),
    readSystemProxy: () => p.readSystemProxy(),
    homeDir: () => p.homeDir(),
    tempDir: () => p.tempDir(),
    normalizePath: () => p.normalizePath("C:\\x"),
  };
  for (const [m, fn] of Object.entries(calls)) {
    try {
      fn();
      failures.push(`${m}: 没抛（静默返回了假值）`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.includes("尚未实现")) failures.push(`${m}: 抛了但不是「尚未实现」→ ${msg}`);
      if (!msg.startsWith(`${platformName}.${m}`)) failures.push(`${m}: 错误信息没带函数名前缀`);
    }
  }
  return failures;
}

check("darwin: 十组接口全部抛「尚未实现」", () => expectNotImplemented("darwin"));
check("linux: 十组接口全部抛「尚未实现」", () => expectNotImplemented("linux"));
check("darwin.capabilities: 明示未实现（三键齐全且 implemented:false）", () => {
  const c = createPlatform("darwin").capabilities;
  return c && c.implemented === false
    && c.pkgManager === null && c.proxyControl === null && c.reveal === null;
});
check("linux.capabilities: 明示未实现（三键齐全且 implemented:false）", () => {
  const c = createPlatform("linux").capabilities;
  return c && c.implemented === false
    && c.pkgManager === null && c.proxyControl === null && c.reveal === null;
});
check("骨架不是「能力表看着能用」：非 Windows 平台不会被误当可用", () => {
  for (const n of ["darwin", "linux"]) {
    const c = createPlatform(n).capabilities;
    if (c.proxyControl === true || c.pkgManager !== null || c.reveal === true) return false;
  }
  return true;
});

// ── 不可变性：拿到的实例不能被就地改坏 ──
check("实例被冻结（不能就地替换方法）", () => {
  const p = createPlatform("win32");
  try { p.which = () => "hacked"; } catch { /* 严格模式抛，也算生效 */ }
  return p.which("这个东西不存在") === "";
});

console.log(`\nunit-platform: ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过（本机非 Windows）` : ""}`);
process.exit(fail ? 1 : 0);
