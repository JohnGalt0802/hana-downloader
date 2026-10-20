// tests/unit-platform.mjs — 平台适配层（P1-2，2026-10-20）
//
// 测什么：engine/platform/ 的十组接口契约，**三份实例跑同一套断言**。
//
// 为什么能在 Windows 上验 darwin/linux：所有探测类接口的实现都是「spawnSync 一次命令 →
// 看退出码 / 解析输出」，被测的是**逻辑**而不是真机。在 Windows 上跑 darwin.which("node")
// 时 which 命令不存在 → 走的正是「命令不存在 → 返回空」这条真实路径，反而是最有价值的覆盖。
// 纯解析逻辑（scutil plist / gsettings 值 / 代理串归一）抽成了导出函数，直接喂字符串验。
//
// 分三段：
//   共通断言        三平台同一套（找不到给空、非法入参不抛、形状正确、幂等）
//   平台差异断言    逐条硬编码期望值（后缀 / detached / 大小写 / 能力表）
//   纯函数参数注入  scutil 三种形态、env 代理串、gsettings 输出
//
// ★ 这些断言证明的是「逻辑对」，**不是「mac/linux 真机能跑」**。真机行为未验证。
//
// 用法（仓库根目录）：node tests/unit-platform.mjs
// 退出码：全过 0，有失败 1。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatform, platform } from "../engine/platform/index.mjs";
import * as darwinImpl from "../engine/platform/darwin.mjs";
import * as linuxImpl from "../engine/platform/linux.mjs";

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

const PLATFORMS = ["win32", "darwin", "linux"];
const P = {};
for (const n of PLATFORMS) P[n] = createPlatform(n);

// 每个平台允许的 pkgManager 取值（不许出现别家的包管理器）
const PKG_ALLOWED = {
  win32: ["winget"],
  darwin: ["brew"],
  linux: ["brew", "apt", "dnf", "pacman"],
};
// readSystemProxy().source 的合法取值（跨平台并集；逐平台细分在差异段）
const ALLOWED_SOURCE = ["none", "registry", "scutil", "gsettings", "env"];

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

// ══ 一、共通断言：三份实例同一套 ════════════════════════════════════════════
const METHODS = ["which", "exe", "spawnOpts", "killTree", "isRunning", "reveal",
  "readSystemProxy", "homeDir", "tempDir", "nullDevice", "pidAlive", "processNameOf", "normalizePath"];

for (const n of PLATFORMS) {
  const p = P[n];

  // ── 实例形状 ──
  check(`${n}: name 字段正确`, () => p.name === n);
  check(`${n}: 十组接口都是函数`, () => METHODS.every((m) => typeof p[m] === "function"));
  check(`${n}: 实例被冻结（不能就地替换方法）`, () => {
    try { p.which = () => "hacked"; } catch { /* 严格模式抛，同样算生效 */ }
    return p.which("这个东西不存在") === "";
  });

  // ── ① which：找不到给 ""，绝不抛 ──
  // 在 Windows 上跑 darwin/linux，这里走的正是「which 命令不存在」的真实路径。
  check(`${n}.which: 不存在的命令 → ""（不抛）`, () => p.which("这个东西不存在") === "");
  check(`${n}.which: 空输入 → ""`, () =>
    p.which("") === "" && p.which(undefined) === "" && p.which(null) === "");
  check(`${n}.which: 纯空格 → ""`, () => p.which("   ") === "");
  check(`${n}.which: 返回值是字符串，不返回 null/undefined`, () => {
    const r = p.which("这个东西不存在");
    return isStr(r) && r === "";
  });

  // ── ② exe：返回值类型与「不加后缀」的共性 ──
  check(`${n}.exe: 返回字符串`, () => isStr(p.exe("a")) && isStr(p.exe("")));
  check(`${n}.exe: 不改动路径分隔符`, () => p.exe("dir/a").includes("dir/a"));

  // ── ③ spawnOpts：返回新对象、合并 extra、不改入参 ──
  check(`${n}.spawnOpts: 不传参也给对象`, () =>
    typeof p.spawnOpts() === "object" && p.spawnOpts() !== null);
  check(`${n}.spawnOpts: extra 被合并`, () => {
    const o = p.spawnOpts({ cwd: "x", stdio: "ignore" });
    return o.cwd === "x" && o.stdio === "ignore";
  });
  check(`${n}.spawnOpts: 不改入参`, () => {
    const extra = { cwd: "x" };
    p.spawnOpts(extra);
    return JSON.stringify(Object.keys(extra)) === JSON.stringify(["cwd"]);
  });
  check(`${n}.spawnOpts: 每次返回新对象（不共享同一个 dict）`, () => p.spawnOpts() !== p.spawnOpts());

  // ── ④ killTree：非法/不存在 pid → false，不抛 ──
  check(`${n}.killTree: 不存在的 pid → false 且不抛`, () => p.killTree(2147483647) === false);
  check(`${n}.killTree: 非法入参 → false 且不抛`, () => {
    for (const bad of [0, -1, -12345, NaN, "abc", null, undefined, 1.5, {}]) {
      if (p.killTree(bad) !== false) return false;
    }
    return true;
  });
  check(`${n}.killTree: 返回值严格是布尔`, () => typeof p.killTree(0) === "boolean");

  // ── ⑤ isRunning：不认识的名字 → false，不抛 ──
  check(`${n}.isRunning: 不存在的进程 → false`, () => p.isRunning("这个东西不存在") === false);
  check(`${n}.isRunning: 空输入 → false`, () => p.isRunning("") === false && p.isRunning(null) === false);
  check(`${n}.isRunning: 返回值严格是布尔`, () => typeof p.isRunning("nope-xyz") === "boolean");

  // ── ⑥ reveal：不存在的路径 → {ok:false}，不抛、不起 GUI ──
  check(`${n}.reveal: 不存在的路径 → {ok:false} 且带 error`, () => {
    const r = p.reveal(path.join(os.tmpdir(), "hd-platform-绝对不存在的路径-9f3a2b"), "select");
    return r && r.ok === false && isStr(r.error) && r.error.length > 0;
  });
  check(`${n}.reveal: mode=open 同样安全失败`, () => {
    const r = p.reveal(path.join(os.tmpdir(), "hd-platform-不存在-1c7d"), "open");
    return r && r.ok === false && isStr(r.error);
  });
  check(`${n}.reveal: 空路径 → {ok:false}`, () => {
    for (const bad of ["", null, undefined]) {
      const r = p.reveal(bad, "select");
      if (!r || r.ok !== false) return false;
    }
    return true;
  });
  check(`${n}.reveal: 返回值形状只有 ok/error`, () => {
    const r = p.reveal(path.join(os.tmpdir(), "hd-nope-7g"), "select");
    return r.ok === false && Object.keys(r).every((k) => k === "ok" || k === "error");
  });

  // ── ⑦ readSystemProxy：形状与稳定性（不假设本机有没有代理）──
  check(`${n}.readSystemProxy: 不抛且键类型正确`, () => {
    const r = p.readSystemProxy();
    return r && typeof r === "object"
      && typeof r.enabled === "boolean" && isStr(r.server) && isStr(r.source);
  });
  check(`${n}.readSystemProxy: 键固定为 enabled/server/source`, () => {
    const keys = Object.keys(p.readSystemProxy()).sort();
    return JSON.stringify(keys) === JSON.stringify(["enabled", "server", "source"]);
  });
  check(`${n}.readSystemProxy: 启停两态自洽（enabled → server 非空且 source 非 none；否则 server 空、source=none）`, () => {
    // 这条在 CI runner 上真捕到过一个缺陷：reg query 回 `ProxyEnable 0x0` 但没有 ProxyServer，
    // 旧实现报 {enabled:false, server:"", source:"registry"} —— 两态各自都"看起来合理"，
    // 拼在一起就自相矛盾，调用方不知道该看 enabled 还是 source。现在实现改成两者缺一即 none。
    const r = p.readSystemProxy();
    if (r.enabled) return r.server.length > 0 && r.source !== "none";
    return r.server === "" && r.source === "none";
  });
  check(`${n}.readSystemProxy: source 在允许集合内`, () =>
    ALLOWED_SOURCE.includes(p.readSystemProxy().source));
  check(`${n}.readSystemProxy: 连跑两次结果稳定`, () => {
    const a = p.readSystemProxy(), b = p.readSystemProxy();
    return a.enabled === b.enabled && a.server === b.server && a.source === b.source;
  });

  // ── ⑧ homeDir / tempDir：非空字符串 ──
  check(`${n}.homeDir: 非空字符串`, () => isStr(p.homeDir()) && p.homeDir().trim().length > 0);
  check(`${n}.tempDir: 非空字符串`, () => isStr(p.tempDir()) && p.tempDir().trim().length > 0);
  check(`${n}.nullDevice: 非空字符串，且不以分隔符结尾`, () => {
    // 不断言「不含分隔符」：/dev/null 本身就是一条路径。真正的契约只是「能当 -o 的实参」。
    const d = p.nullDevice();
    return isStr(d) && d.trim().length > 0 && !/[\\/]$/.test(d);
  });

  // ⑧ pid 探活 / 进程名：非法入参不抛
  check(`${n}.pidAlive: 非法 pid → false 且不抛`, () => {
    for (const bad of [0, -1, NaN, "abc", null, undefined, 1.5, {}]) {
      if (p.pidAlive(bad) !== false) return false;
    }
    return true;
  });
  check(`${n}.pidAlive: 当前进程 → true`, () => p.pidAlive(process.pid) === true);
  check(`${n}.pidAlive: 不存在的超大 pid → false`, () => p.pidAlive(2147483647) === false);
  check(`${n}.processNameOf: 非法 pid → ""`, () => {
    for (const bad of [0, -1, NaN, null, undefined, {}]) {
      if (p.processNameOf(bad) !== "") return false;
    }
    return true;
  });
  check(`${n}.processNameOf: 返回字符串，不返回 null/undefined`, () => {
    const r = p.processNameOf(process.pid);
    return isStr(r);
  });

  // ── ⑩ normalizePath：比较键的共性 ──
  check(`${n}.normalizePath: 反斜杠转正斜杠`, () => p.normalizePath("a\\b\\c") === "a/b/c");
  check(`${n}.normalizePath: 去重复分隔符`, () => p.normalizePath("a\\\\b//c") === "a/b/c");
  check(`${n}.normalizePath: 空输入 → "" 不抛`, () =>
    p.normalizePath("") === "" && p.normalizePath(null) === "" && p.normalizePath(undefined) === "");
  check(`${n}.normalizePath: 幂等`, () => {
    const once = p.normalizePath("C:\\\\A\\\\B\\\\");
    return p.normalizePath(once) === once;
  });
  check(`${n}.normalizePath: 去尾部斜杠（根除外）`, () =>
    p.normalizePath("/usr/local/") === "/usr/local" && p.normalizePath("/") === "/");

  // ── ⑨ capabilities：键齐全、值有约束 ──
  check(`${n}.capabilities: 三个键齐全且无遗留占位键`, () => {
    const keys = Object.keys(p.capabilities).sort();
    return JSON.stringify(keys) === JSON.stringify(["pkgManager", "proxyControl", "reveal"]);
  });
  check(`${n}.capabilities: proxyControl 严格是布尔`, () => typeof p.capabilities.proxyControl === "boolean");
  check(`${n}.capabilities: reveal === true`, () => p.capabilities.reveal === true);
  check(`${n}.capabilities.pkgManager: null 或本平台允许的名字`, () => {
    const v = p.capabilities.pkgManager;
    return v === null || (isStr(v) && PKG_ALLOWED[n].includes(v));
  });
  check(`${n}.capabilities.pkgManager: 不会串到别家包管理器`, () => {
    const v = p.capabilities.pkgManager;
    if (v === null) return true;
    return !["winget", "brew", "apt", "dnf", "pacman"].some((x) => x === v && !PKG_ALLOWED[n].includes(x));
  });
  check(`${n}.capabilities: 冻结保护（改键不生效）`, () => {
    const before = p.capabilities.proxyControl;
    try { p.capabilities.proxyControl = !before; } catch { /* 严格模式抛，同样算保护生效 */ }
    return p.capabilities.proxyControl === before;
  });
}

// ══ 二、平台差异断言：逐条硬编码期望 ════════════════════════════════════════

// ── ② exe：Windows 加 .exe，posix 原样 ──
check("差异·exe: win32 加 .exe", () => P.win32.exe("a") === "a.exe");
check("差异·exe: darwin 原样不加后缀", () => P.darwin.exe("a") === "a");
check("差异·exe: linux 原样不加后缀", () => P.linux.exe("a") === "a");

// ── ⑧ nullDevice：win 是 NUL，posix 是 /dev/null ──
check("差异·nullDevice: win32 → NUL", () => P.win32.nullDevice() === "NUL");
check("差异·nullDevice: darwin → /dev/null", () => P.darwin.nullDevice() === "/dev/null");
check("差异·nullDevice: linux → /dev/null", () => P.linux.nullDevice() === "/dev/null");
check("差异·exe: win32 带路径也不改名，只加后缀", () => P.win32.exe("C:\\tools\\aria2c") === "C:\\tools\\aria2c.exe");
check("差异·exe: darwin 带路径原样返回", () => P.darwin.exe("/opt/homebrew/bin/aria2c") === "/opt/homebrew/bin/aria2c");
check("差异·exe: linux 带路径原样返回", () => P.linux.exe("/usr/bin/aria2c") === "/usr/bin/aria2c");
check("差异·exe: posix 侧对空输入也不加东西", () => P.darwin.exe("") === "" && P.linux.exe("") === "");

// ── ③ spawnOpts：win32 无 detached，posix 有 detached 且无 windowsHide ──
check("差异·spawnOpts: win32 有 windowsHide、无 detached", () => {
  const o = P.win32.spawnOpts();
  return o.windowsHide === true && !("detached" in o);
});
check("差异·spawnOpts: darwin 有 detached、无 windowsHide", () => {
  const o = P.darwin.spawnOpts();
  return o.detached === true && !("windowsHide" in o);
});
check("差异·spawnOpts: linux 有 detached、无 windowsHide", () => {
  const o = P.linux.spawnOpts();
  return o.detached === true && !("windowsHide" in o);
});
check("差异·spawnOpts: posix 侧 extra 可覆盖 detached", () => P.darwin.spawnOpts({ detached: false }).detached === false);
check("差异·spawnOpts: win32 侧 extra 可覆盖 windowsHide", () => P.win32.spawnOpts({ windowsHide: false }).windowsHide === false);

// ── ⑩ normalizePath：win32 小写，posix 保持大小写 ──
check("差异·normalizePath: win32 小写化", () => P.win32.normalizePath("A/B") === "a/b");
check("差异·normalizePath: darwin 保持大小写", () => P.darwin.normalizePath("A/B") === "A/B");
check("差异·normalizePath: linux 保持大小写", () => P.linux.normalizePath("A/B") === "A/B");
check("差异·normalizePath: win32 整条路径小写", () =>
  P.win32.normalizePath("C:\\Users\\John Galt\\A.TXT") === "c:/users/john galt/a.txt");
check("差异·normalizePath: darwin 整条路径保原样", () =>
  P.darwin.normalizePath("C:\\Users\\John Galt\\A.TXT") === "C:/Users/John Galt/A.TXT");
check("差异·normalizePath: linux 整条路径保原样", () =>
  P.linux.normalizePath("/Home/John/File.TXT") === "/Home/John/File.TXT");
check("差异·normalizePath: posix 下大小写不同的两条路径不同键（大小写敏感）", () =>
  P.darwin.normalizePath("/A/b") !== P.darwin.normalizePath("/a/b"));
check("差异·normalizePath: win32 下大小写不同的两条路径同键（大小写不敏感）", () =>
  P.win32.normalizePath("C:/A/b") === P.win32.normalizePath("c:/a/B"));

// ── ⑨ capabilities.proxyControl：只有 Windows 为 true ──
check("差异·capabilities.proxyControl: win32 === true", () => P.win32.capabilities.proxyControl === true);
check("差异·capabilities.proxyControl: darwin === false", () => P.darwin.capabilities.proxyControl === false);
check("差异·capabilities.proxyControl: linux === false", () => P.linux.capabilities.proxyControl === false);
check("差异·capabilities.reveal: 三平台都是 true", () =>
  PLATFORMS.every((n) => P[n].capabilities.reveal === true));
check("差异·capabilities.pkgManager: darwin 不许出现 winget", () => P.darwin.capabilities.pkgManager !== "winget");
check("差异·capabilities.pkgManager: linux 不许出现 winget", () => P.linux.capabilities.pkgManager !== "winget");

// ── ⑧ tempDir 优先级 ──
check("差异·tempDir: win32 优先 TEMP", () => {
  const t = (process.env.TEMP || "").trim();
  return t ? P.win32.tempDir() === t : true;
});
check("差异·tempDir: darwin 优先 TMPDIR", () => {
  const t = (process.env.TMPDIR || "").trim();
  return t ? P.darwin.tempDir() === t : true;
});
check("差异·tempDir: linux 优先 TMPDIR", () => {
  const t = (process.env.TMPDIR || "").trim();
  return t ? P.linux.tempDir() === t : true;
});
check("差异·tempDir: linux TMPDIR 缺失时退到 TMP", () => {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP };
  try {
    process.env.TMPDIR = "";
    process.env.TMP = "/var/tmp/hd-probe";
    const r = P.linux.tempDir();
    return r === "/var/tmp/hd-probe";
  } finally {
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.TMPDIR;
    if (saved.TMP === undefined) delete process.env.TMP; else process.env.TMP = saved.TMP;
  }
});

// ══ 三、Windows 本机专属：正向/负向对照 ══════════════════════════════════════
if (process.platform === "win32") {
  check("win32.which(\"node\") → 真实存在的绝对路径", () => {
    const r = P.win32.which("node");
    return r.length > 0 && fs.existsSync(r);
  });
  check("win32.which(\"where.exe\") 自身可达", () => P.win32.which("where.exe").length > 0);
  check("win32.isRunning(\"node\") → true（本机有 node 在跑）", () => P.win32.isRunning("node") === true);
  check("win32.capabilities.pkgManager 来自真实探测（本机有 winget）", () =>
    P.win32.capabilities.pkgManager === "winget");
  check("win32.readSystemProxy: source 只可能是 registry 或 none", () => {
    const s = P.win32.readSystemProxy().source;
    return s === "registry" || s === "none";
  });
  // ★ 验收 3 的同一件事：本机没有 which / pgrep 时必须优雅返回空而不是崩。
  // 不能断言"一定为空"：windows-latest runner 上 Git for Windows 会把 `which` 放上 PATH，
  // 于是 darwin/linux.which("node") 真能拿到结果（2026-10-19 CI 实测失败）。
  // 契约是「不抛、返回字符串、要么空要么指向真实存在的路径」，不押注机器干净。
  check("darwin.which 在非 darwin 上：不抛，要么空要么真存在", () => {
    const r = P.darwin.which("node");
    return isStr(r) && (r === "" || fs.existsSync(r));
  });
  check("linux.which 在非 linux 上：不抛，要么空要么真存在", () => {
    const r = P.linux.which("node");
    return isStr(r) && (r === "" || fs.existsSync(r));
  });
  check("darwin.isRunning 在非 darwin 上：布尔值，不抛", () => {
    const r = P.darwin.isRunning("node");
    return typeof r === "boolean";
  });
  check("linux.isRunning 在非 linux 上：布尔值，不抛", () => {
    const r = P.linux.isRunning("node");
    return typeof r === "boolean";
  });
  check("darwin.readSystemProxy 在非 darwin 上：不抛且自洽", () => {
    const r = P.darwin.readSystemProxy();
    const okShape = typeof r.enabled === "boolean" && isStr(r.server) && isStr(r.source);
    if (!okShape) return false;
    // scutil 不存在时 source 必须是 none；有 scutil 的机器（很少）则自洽即可
    return r.enabled ? r.server.length > 0 : (r.server === "" && r.source === "none");
  });
  check("darwin/linux.capabilities.pkgManager 在 Windows runner 上要么 null 要么本家", () => {
    const a = P.darwin.capabilities.pkgManager, b = P.linux.capabilities.pkgManager;
    return (a === null || a === "brew")
      && (b === null || ["brew", "apt", "dnf", "pacman"].includes(b));
  });
} else {
  skip += 1;
  console.log("SKIP: Windows 本机专属正向用例");
}

// ══ 四、纯函数参数注入：解析逻辑（真机不可达，只能在 Windows 上这样验）═══════

// ── scutil --proxy 三种形态 ──
const SCUTIL_ON = [
  "<dictionary> {",
  "  HTTPEnable : 1",
  "  HTTPPort : 7890",
  "  HTTPProxy : 127.0.0.1",
  "  HTTPSEnable : 1",
  "  HTTPSPort : 7890",
  "  HTTPSProxy : 127.0.0.1",
  "  ProxyAutoConfigEnable : 0",
  "}",
].join("\n");
const SCUTIL_HTTPS_ONLY = "<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 1\n  HTTPSPort : 8888\n  HTTPSProxy : 10.0.0.5\n}\n";
const SCUTIL_OFF = "<dictionary> {\n  HTTPEnable : 0\n  HTTPPort : 0\n  HTTPProxy : \n  HTTPSEnable : 0\n}\n";

check("scutil: 形态①有代理 → enabled/server/source=scutil", () => {
  const r = darwinImpl.parseScutilProxy(SCUTIL_ON);
  return r.enabled === true && r.server === "127.0.0.1:7890" && r.source === "scutil";
});
check("scutil: 形态①优先 HTTP 而不是 HTTPS", () => {
  const r = darwinImpl.parseScutilProxy(SCUTIL_ON.replace("HTTPSPort : 7890", "HTTPSPort : 9999"));
  return r.server === "127.0.0.1:7890";
});
check("scutil: HTTP 关、HTTPS 开 → 用 HTTPS", () => {
  const r = darwinImpl.parseScutilProxy(SCUTIL_HTTPS_ONLY);
  return r.enabled === true && r.server === "10.0.0.5:8888" && r.source === "scutil";
});
check("scutil: 形态②HTTP 独占时也走 HTTPS 分支", () => {
  const r = darwinImpl.parseScutilProxy("HTTPEnable : 0\nHTTPSEnable : 1\nHTTPSProxy : 1.2.3.4\nHTTPSPort : 1080");
  return r.enabled === true && r.server === "1.2.3.4:1080";
});
check("scutil: 形态②全禁用 → none", () => {
  const r = darwinImpl.parseScutilProxy(SCUTIL_OFF);
  return r.enabled === false && r.server === "" && r.source === "none";
});
check("scutil: 形态③空文本 → none", () => {
  const r = darwinImpl.parseScutilProxy("");
  return r.enabled === false && r.server === "" && r.source === "none";
});
check("scutil: 形态③垃圾文本 → none", () => {
  const r = darwinImpl.parseScutilProxy("not a plist at all\n;;;\n");
  return r.enabled === false && r.server === "" && r.source === "none";
});
check("scutil: 形态③null/undefined → none 不抛", () => {
  for (const bad of [null, undefined]) {
    const r = darwinImpl.parseScutilProxy(bad);
    if (r.enabled !== false || r.server !== "" || r.source !== "none") return false;
  }
  return true;
});
check("scutil: Enable=1 但缺 port → 无效（不猜默认端口）", () => {
  const r = darwinImpl.parseScutilProxy("HTTPEnable : 1\nHTTPProxy : 127.0.0.1");
  return r.enabled === false && r.server === "";
});
check("scutil: Enable=1 但缺 host → 无效", () => {
  const r = darwinImpl.parseScutilProxy("HTTPEnable : 1\nHTTPPort : 7890");
  return r.enabled === false && r.server === "";
});
check("scutil: 端口非数字 → 无效", () => {
  const r = darwinImpl.parseScutilProxy("HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : abc");
  return r.enabled === false && r.server === "";
});
check("scutil: Enable 非 0/1（如 2）不当作开", () => {
  const r = darwinImpl.parseScutilProxy("HTTPEnable : 2\nHTTPProxy : 1.1.1.1\nHTTPPort : 80");
  return r.enabled === false;
});
check("scutil: 容忍 CRLF 与行首缩进", () => {
  const r = darwinImpl.parseScutilProxy("  <dictionary> {\r\n    HTTPEnable : 1\r\n    HTTPProxy : proxy.local\r\n    HTTPPort : 3128\r\n  }\r\n");
  return r.enabled === true && r.server === "proxy.local:3128";
});
check("scutil: 返回对象不含多余键", () => {
  const keys = Object.keys(darwinImpl.parseScutilProxy(SCUTIL_ON)).sort();
  return JSON.stringify(keys) === JSON.stringify(["enabled", "server", "source"]);
});

// ── linux 环境变量代理串归一 ──
check("env 代理串: 剥 http:// 与尾斜杠", () =>
  linuxImpl.normalizeProxyServer("http://127.0.0.1:7890/") === "127.0.0.1:7890");
check("env 代理串: 剥 socks5://", () =>
  linuxImpl.normalizeProxyServer("socks5://127.0.0.1:1080") === "127.0.0.1:1080");
check("env 代理串: 剥 user:pass@", () =>
  linuxImpl.normalizeProxyServer("http://u:p@10.0.0.1:3128") === "10.0.0.1:3128");
check("env 代理串: 纯 host:port 原样", () =>
  linuxImpl.normalizeProxyServer("127.0.0.1:8080") === "127.0.0.1:8080");
check("env 代理串: 砍掉路径与查询串", () =>
  linuxImpl.normalizeProxyServer("http://h:1/proxy?x=1#f") === "h:1");
check("env 代理串: 空/null → \"\" 不抛", () =>
  linuxImpl.normalizeProxyServer("") === "" && linuxImpl.normalizeProxyServer(null) === "");
check("env 代理串: 只给主机不猜默认端口", () =>
  linuxImpl.normalizeProxyServer("http://proxy.local") === "proxy.local");

// ── linux gsettings 输出解析 ──
check("gsettings: 去单引号", () => linuxImpl.parseGsettingsValue("'manual'\n") === "manual");
check("gsettings: 去双引号", () => linuxImpl.parseGsettingsValue("\"manual\"") === "manual");
check("gsettings: 整数值原样", () => linuxImpl.parseGsettingsValue("7890\n") === "7890");
check("gsettings: 空输出 → \"\"", () => linuxImpl.parseGsettingsValue("") === "");
check("gsettings: @as [] 视为空", () => linuxImpl.parseGsettingsValue("@as []") === "");
check("gsettings: 未闭合引号不抛且不吞字符", () => linuxImpl.parseGsettingsValue("'manual") === "'manual");
check("gsettings: null/undefined → \"\" 不抛", () =>
  linuxImpl.parseGsettingsValue(null) === "" && linuxImpl.parseGsettingsValue(undefined) === "");

// ── readSystemProxy 走 env 分支（本机若设了 http_proxy，linux 实现必须认出来）──
check("linux.readSystemProxy: env 里有 http_proxy 时 source=enabled 且与被归一", () => {
  const v = (process.env.http_proxy || process.env.HTTP_PROXY || "").trim();
  if (!v) return true;                  // 本机没设，走 gsettings/none 分支，不适用
  const r = P.linux.readSystemProxy();
  return r.enabled === true && r.source === "env"
    && r.server === linuxImpl.normalizeProxyServer(v);
});

// ══ 五、结构纪律：spawnOpts 与 killTree 必须相邻（方案 §3.3 原则一）═════════
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ["darwin.mjs", "linux.mjs", "win32.mjs"]) {
  check(`${f}: spawnOpts 与 killTree 之间没有别的函数`, () => {
    const src = fs.readFileSync(path.join(here, "..", "engine", "platform", f), "utf8");
    const a = src.indexOf("export function spawnOpts");
    const b = src.indexOf("export function killTree");
    if (a < 0 || b < 0 || b < a) return false;
    const between = src.slice(a + "export function spawnOpts".length, b);
    return !between.includes("export function") && !between.includes("export const");
  });
  check(`${f}: killTree 紧跟 spawnOpts（中间只隔注释/空行，行差 ≤ 20）`, () => {
    const lines = fs.readFileSync(path.join(here, "..", "engine", "platform", f), "utf8").split(/\r?\n/);
    const i = lines.findIndex((l) => l.startsWith("export function spawnOpts"));
    const j = lines.findIndex((l) => l.startsWith("export function killTree"));
    return i >= 0 && j > i && j - i <= 20;
  });
}

// ── 两个骨架已不再是骨架：不许残留「尚未实现」 ──
for (const f of ["darwin.mjs", "linux.mjs"]) {
  check(`${f}: 不残留「尚未实现」字样`, () => {
    const src = fs.readFileSync(path.join(here, "..", "engine", "platform", f), "utf8");
    return !src.includes("尚未实现");
  });
}

console.log(`\nunit-platform: ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ""}`);
process.exit(fail ? 1 : 0);
