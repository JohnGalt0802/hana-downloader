// tests/unit-orphan-reap.mjs — 孤儿收尾：探活口径必须与杀的对象一致（2026-10-21 新增）
//
// 为什么单独一个套件：2026-10-20 的独立审查 A 指出，_reapOrphanCommand 里
//     pidAlive(pid)            ← 探的是「组长」
//     killTree(pid) → kill(-pid)  ← 杀的是「进程组」
// 两者不是同一个对象。组长先死、组员还活着时 pidAlive 报 false 直接 return，
// 而 kill(-pid) 本来能把整组清掉 —— 这层收尾在最需要它的时候恰好空转。
//
// 2026-10-21 在 WSL/Linux 真机上复现并修掉（改用 treeAlive / treeNames）。
// 本套件把那个现场固化下来，防止以后再退回「用组长口径探、用组口径杀」。
//
// 平台差异（写清，别让后人以为 posix 那套在 Windows 上也成立）：
//   · posix：组长死、组员活是常态（detached + 组长被 SIGKILL）。kill(-pid) 仍有东西可杀，
//     且验证过：进程组存活期间 pgid 不会被复用（tests/tools/pid-reuse-vs-group.mjs）。
//   · win32：没有进程组。killTree 走 taskkill /T 的进程树关系，父进程一死树关系就断了，
//     此时 taskkill /T 本来也没东西可杀 —— 所以 treeAlive 退化为 pidAlive 是**正确**的，
//     不是像 posix 那样的结构错。这里对两端分别断言，不假装它们同构。
//
// 用法（仓库根目录）：node tests/unit-orphan-reap.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { platform, createPlatform } from "../engine/platform/index.mjs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name + (detail ? "  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-orphan-"));
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

// ══ 一、接口形状：三平台都必须有 treeAlive / treeNames ════════════════════
console.log("── 接口契约 ──");
for (const n of ["win32", "darwin", "linux"]) {
  let p = null, threw = null;
  try { p = createPlatform(n); } catch (e) { threw = e; }
  check(`${n}: createPlatform 成功（缺接口会在这一步抛）`, threw === null, threw ? String(threw.message) : "");
  if (!p) continue;
  check(`${n}: treeAlive 是函数`, typeof p.treeAlive === "function");
  check(`${n}: treeNames 是函数`, typeof p.treeNames === "function");
  check(`${n}: treeAlive(非法) → false 且不抛`, (() => {
    try {
      for (const bad of [0, -1, NaN, null, undefined, "abc", {}]) {
        if (p.treeAlive(bad) !== false) return false;
      }
      return true;
    } catch { return false; }
  })());
  check(`${n}: treeNames(非法) → [] 且不抛`, (() => {
    try {
      for (const bad of [0, -1, NaN, null, undefined, "abc", {}]) {
        const r = p.treeNames(bad);
        if (!Array.isArray(r) || r.length !== 0) return false;
      }
      return true;
    } catch { return false; }
  })());
  check(`${n}: treeNames 返回数组且元素都是非空字符串`, (() => {
    const r = p.treeNames(process.pid);
    return Array.isArray(r) && r.every((x) => typeof x === "string" && x.length > 0);
  })());
  // 「能问到自己的进程名」只有在本机真实平台上才有意义：
  // 注入的 darwin/linux 实现靠 spawnSync("ps") 探测，在 Windows 上根本没有 ps 这个程序，
  // 拿它去断言等于在押注宿主环境（踩坑记录 #55 的教训）。这里拆开写。
  if (n === platform.name) {
    check(`${n}: treeNames(当前进程) 非空（本机真实探测）`, (() => {
      const r = p.treeNames(process.pid);
      return r.length > 0;
    })(), JSON.stringify(p.treeNames(process.pid)));
  }
}

// ══ 二、posix：真起一个「组长会自己退出」的现场 ═══════════════════════════
if (platform.name !== "win32") {
  console.log("\n── posix: 组长已死、组员还活着 ──");

  const worker = path.join(BASE, "worker.mjs");
  const leader = path.join(BASE, "leader.mjs");
  const hb = path.join(BASE, "hb.txt");

  fs.writeFileSync(worker, `
import fs from "node:fs";
const hb = process.argv[2];
setInterval(() => { try { fs.appendFileSync(hb, "x"); } catch {} }, 80);
`, "utf-8");
  fs.writeFileSync(leader, `
import { spawn } from "node:child_process";
const [worker, hb] = process.argv.slice(2);
const c = spawn(process.execPath, [worker, hb], { stdio: "ignore" });
c.unref();
setTimeout(() => process.exit(0), 200);
`, "utf-8");

  const p = spawn(process.execPath, [leader, worker, hb], platform.spawnOpts({ stdio: "ignore" }));
  const pid = p.pid;
  await sleep(1200); // 等组长退出

  check("组长已退出（pidAlive=false）", platform.pidAlive(pid) === false, `pid=${pid}`);

  // 心跳：证明组员真的还在跑
  const sizeOf = () => { try { return fs.statSync(hb).size; } catch { return 0; } };
  const a = sizeOf();
  await sleep(500);
  check("组员仍在跑（心跳增长）", sizeOf() > a, `${a} -> ${sizeOf()}`);

  // ★ 核心断言：同一时刻，pidAlive 说死、treeAlive 说活
  check("★ 同一 pid：pidAlive=false 但 treeAlive=true（错配的现场）",
    platform.pidAlive(pid) === false && platform.treeAlive(pid) === true);
  check("treeNames 在组长死后仍能问到组员", platform.treeNames(pid).includes("node"),
    JSON.stringify(platform.treeNames(pid)));

  // 走真实的收尾函数
  const { getTaskManager, _resetTaskManager } = await import("../engine/dlcore.js");
  _resetTaskManager?.();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-orphan-data-"));
  const mgr = getTaskManager(dataDir);

  check("★ _reapOrphanCommand 收掉了这个孤儿（返回 true）",
    mgr._reapOrphanCommand(pid, "pnpm-install") === true);
  await sleep(900);
  const b = sizeOf();
  await sleep(500);
  check("★ 收掉后心跳停止（组员真的被杀）", sizeOf() === b, `${b} -> ${sizeOf()}`);
  check("收掉后进程树消失", platform.treeAlive(pid) === false, `-${pid}`);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

  // ── 安全阀：名字对不上绝不杀 ──
  console.log("\n── posix: 安全阀（核名）──");
  const innocent = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(400);
  // 拿 winget-install 的期望集合去核一个 node 进程 → 对不上，必须拒绝
  check("名字对不上就不杀", mgr._reapOrphanCommand(innocent.pid, "winget-install") === false);
  await sleep(300);
  check("无辜进程还活着", platform.pidAlive(innocent.pid) === true, `pid=${innocent.pid}`);
  try { platform.killTree(innocent.pid); } catch { /* 已退 */ }
}

// ══ 三、win32：treeAlive 退化为 pidAlive 是设计，不是缺陷 ═════════════════
if (platform.name === "win32") {
  console.log("\n── win32: 树口径退化为单进程 ──");
  const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(600);
  check("活进程：treeAlive 与 pidAlive 一致（true）",
    platform.treeAlive(p.pid) === true && platform.pidAlive(p.pid) === true);
  check("treeNames 返回该进程名（node）", platform.treeNames(p.pid).some((n) => /node/i.test(n)),
    JSON.stringify(platform.treeNames(p.pid)));
  try { platform.killTree(p.pid); } catch { /* 已退 */ }
  await sleep(600);
  check("死后两者都是 false", platform.treeAlive(p.pid) === false && platform.pidAlive(p.pid) === false);
}

// ══ 四、静态契约：dlcore 不许再用「组长口径探、组口径杀」 ═════════════════
console.log("\n── 源码契约（防回归）──");
const src = fs.readFileSync(path.join(process.cwd(), "engine", "dlcore.js"), "utf-8");
// 只看 _reapOrphanCommand 函数体
const fnStart = src.indexOf("_reapOrphanCommand(pid, cmdType) {");
const fnEnd = fnStart >= 0 ? src.indexOf("\n  restore() {", fnStart) : -1;
const body = fnStart >= 0 && fnEnd > fnStart ? src.slice(fnStart, fnEnd) : "";
check("找得到 _reapOrphanCommand 函数体", body.length > 100, `len=${body.length}`);
check("★ 函数体内不再调用 pidAlive（组长口径已废弃）", !/platform\.pidAlive\(/.test(body));
check("★ 函数体内不再调用 processNameOf（改用 treeNames 看整棵树）", !/platform\.processNameOf\(/.test(body));
check("函数体内调用 treeAlive 探活", /platform\.treeAlive\(/.test(body));
check("函数体内调用 treeNames 核名", /platform\.treeNames\(/.test(body));
check("探活与杀用的是同一个 pid 变量（n）",
  /platform\.treeAlive\(n\)/.test(body) && /platform\.killTree\(n\)/.test(body));

console.log(`\n=== orphan-reap: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
