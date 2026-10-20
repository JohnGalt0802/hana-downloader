// tests/unit-orphan-reap.mjs — 孤儿收尾：探活、核名、杀，三者必须指向同一个对象（2026-10-21）
//
// 这个套件的历史值得写下来，因为它演示了「一套测试怎么在三天里被推翻两次」：
//
// ① 2026-10-20 独立审查 A 指出：_reapOrphanCommand 用 pidAlive 探「组长」、
//    用 killTree → kill(-pid) 杀「进程组」，两者不是同一个对象。组长已死、组员还活着时
//    探活报 false 直接 return，收孤儿空转。
// ② 2026-10-21 第一次修：加 treeAlive / treeNames，让探与杀都看「树」。
// ③ 2026-10-21 复核推翻第一次修，挖出三个新问题：
//    · 「pid 活着但不是组长」分支：treeAlive 说树是它自己，但 killTree 仍发 kill(-pid)，
//      那个组是**别人的**（或 ESRCH）——拿不到效果却返回 true，谎报收掉了。
//    · 我把 "sh"/"bash" 加进了期望镜像名，理由是「组长可能是 sh 包装」。这个理由不成立
//      （四条链路全是直接 spawn，全仓 shell:true 零处），而且危险：shell 恰恰是桌面上
//      最常见的组长。实测把一个无关 bash 组配 pnpm-install，整组被打掉。
//    · 本套件原来那 6 条「源码契约」断言是自证：断言的是「这段文本里没有某个字符串」。
//      把切片标记改一个字让它失配，两条 ★ 断言照样 PASS；把 linux 的 treeAlive 换回
//      pidAlive（也就是退回缺陷本身），Windows 上跑仍 28 passed —— 对修复的覆盖率是 0。
//
// 所以现在这套断言只押**行为**：真起进程、真数心跳、真看谁死了。
// 源码断言只保留一条，且它必须能在缺陷回来时真的失败。
//
// 用法（仓库根目录）：node tests/unit-orphan-reap.mjs
// 平台：posix 段只在 posix 跑（win32 没有进程组）；接口契约三平台都跑。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { platform, createPlatform } from "../engine/platform/index.mjs";

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; }
  else { fail++; console.log("FAIL:", name + (detail ? "  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-orphan-"));
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// ══ 一、接口形状：三平台都必须有 treeAlive / treeNames / treeKill / processStartOf ══
console.log("── 接口契约 ──");
for (const n of ["win32", "darwin", "linux"]) {
  let p = null, threw = null;
  try { p = createPlatform(n); } catch (e) { threw = e; }
  check(`${n}: createPlatform 成功（缺接口会在这一步抛）`, threw === null, threw ? String(threw.message) : "");
  if (!p) continue;
  for (const fn of ["treeAlive", "treeNames", "treeKill", "processStartOf"]) {
    check(`${n}: ${fn} 是函数`, typeof p[fn] === "function");
  }
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
  check(`${n}: treeKill(非法) → false 且不抛`, (() => {
    try {
      for (const bad of [0, -1, NaN, null, undefined, "abc", {}]) {
        if (p.treeKill(bad) !== false) return false;
      }
      return true;
    } catch { return false; }
  })());
  check(`${n}: processStartOf(非法) → "" 且不抛`, (() => {
    try {
      for (const bad of [0, -1, NaN, null, undefined, "abc", {}]) {
        if (p.processStartOf(bad) !== "") return false;
      }
      return true;
    } catch { return false; }
  })());
  check(`${n}: processStartOf 返回字符串`, typeof p.processStartOf(process.pid) === "string");
}

// processStartOf 的语义只在能读到真实指纹的平台上有意义：
// linux 读 /proc/<pid>/stat（纯文件），win32 有意返回 ""（见 win32.mjs 的注释）。
if (platform.name === "linux") {
  const s = platform.processStartOf(process.pid);
  check("linux: 能读到自己的启动指纹（非空）", s !== "" && /^\d+$/.test(s), JSON.stringify(s));
  // 稳定：同一进程多次读必须一致（否则正常进程会被误判成 pid 复用）
  check("linux: 同一进程的指纹稳定", platform.processStartOf(process.pid) === s);
  // ★ 精度局限（实测写清，不要以为它能区分一切）：
  //   /proc/<pid>/stat 第 22 字段的单位是内核 jiffies（常见 100Hz，即 10ms）。
  //   同一轮 fork 出来的进程会落在同一个 tick 里，指纹**相同**。所以指纹能挡住
  //   「几分钟前那个 pid 被新进程顶替」，但挡不住「10ms 内恰好撞上」。
  //   这里只断言「相隔足够的时间后能区分」，不假装它是逐一唯一的。
  const before = spawn(process.execPath, ["-e", "setTimeout(()=>{},8000)"], { stdio: "ignore" });
  await sleep(120); // 跨过多个 jiffy
  const after = spawn(process.execPath, ["-e", "setTimeout(()=>{},8000)"], { stdio: "ignore" });
  await sleep(300);
  const sb = platform.processStartOf(before.pid);
  const sa = platform.processStartOf(after.pid);
  check("linux: 相隔多 tick 启动的两个进程指纹不同（能区分 pid 复用）",
    sb !== "" && sa !== "" && sb !== sa, `${sb} vs ${sa}`);
  for (const k of [before, after]) { try { k.kill(); } catch { /* 已退 */ } }
}

// ══ 二、posix：组长已死、组员还活着（第一层缺陷的现场）══════════════════════
if (platform.name !== "win32") {
  console.log("\n── posix: 组长已死、组员还活着 ──");

  const worker = path.join(BASE, "worker.mjs");
  const leader = path.join(BASE, "leader.mjs");
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

  const { getTaskManager, _resetTaskManager } = await import("../engine/dlcore.js");
  _resetTaskManager?.();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-orphan-data-"));
  const mgr = getTaskManager(dataDir);

  // —— 场景 A：组长已死，组员还在 ——
  const hbA = path.join(BASE, "hb-a.txt");
  const pA = spawn(process.execPath, [leader, worker, hbA], platform.spawnOpts({ stdio: "ignore" }));
  const pidA = pA.pid;
  await sleep(1200);

  check("A: 组长已退出（pidAlive=false）", platform.pidAlive(pidA) === false, `pid=${pidA}`);
  const a1 = sizeOf(hbA);
  await sleep(500);
  check("A: 组员仍在跑（心跳增长）", sizeOf(hbA) > a1, `${a1} -> ${sizeOf(hbA)}`);
  check("A: ★ 同一 pid：pidAlive=false 但 treeAlive=true（错配的现场）",
    platform.pidAlive(pidA) === false && platform.treeAlive(pidA) === true);
  check("A: treeNames 在组长死后仍能问到组员", platform.treeNames(pidA).includes("node"),
    JSON.stringify(platform.treeNames(pidA)));

  check("A: ★ _reapOrphanCommand 收掉了（返回 true）", mgr._reapOrphanCommand(pidA, "pnpm-install") === true);
  await sleep(900);
  const a2 = sizeOf(hbA);
  await sleep(500);
  check("A: ★ 心跳真的停了", sizeOf(hbA) === a2, `${a2} -> ${sizeOf(hbA)}`);
  check("A: 进程树消失", platform.treeAlive(pidA) === false, `-${pidA}`);

  // —— 场景 B：pid 活着但不是组长 ——
  //
  // ★ 这里必须是**单向断言**（复核指出上一版写成了 either-or，所以把非组长分支
  //   改成「永远返回 false、什么都不杀」后套件仍全绿 —— M4 变异没被抓到）。
  //   设计意图明确：这个分支就该杀掉它自己并返回 true。
  console.log("\n── posix: pid 活着但不是组长 ──");
  const mid = path.join(BASE, "mid.mjs");
  fs.writeFileSync(mid, `
import { spawn } from "node:child_process";
import fs from "node:fs";
// 组长：起一个不带 detached 的子进程（它会继承本组的 pgid），把它的 pid 写到文件
const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(c.pid));
setTimeout(() => {}, 120000);
`, "utf-8");
  const pidFile = path.join(BASE, "child-pid.txt");
  const pB = spawn(process.execPath, [mid, pidFile], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(900);
  const childPid = Number(fs.readFileSync(pidFile, "utf-8").trim() || 0);
  check("B: 拿到了子进程 pid", childPid > 0, String(childPid));
  const pgB = Number(spawnSyncPgid(childPid));

  check("B: 前置条件成立（子进程 pgid ≠ 自己 pid，即它不是组长）",
    pgB > 0 && pgB !== childPid, `pgid=${pgB} pid=${childPid}`);
  check("B: treeAlive(子进程) = true（它还活着）", platform.treeAlive(childPid) === true);
  check("B: 它是 node（名字对得上 pnpm-install 的期望集合）",
    platform.processNameOf(childPid).includes("node"), platform.processNameOf(childPid));

  check("B: ★ 返回 true（按设计收掉）", mgr._reapOrphanCommand(childPid, "pnpm-install") === true);
  await sleep(1000);
  check("B: ★ 目标进程真的死了（不是谎报）", platform.pidAlive(childPid) === false,
    `pid=${childPid} 还活着`);
  check("B: ★ 组长（父）未被误杀（没去杀别人的组）", platform.pidAlive(pB.pid) === true,
    `父 pid=${pB.pid}`);
  try { platform.treeKill(pB.pid); } catch { /* 已退 */ }

  // —— 场景 B2：忽略 SIGTERM 的非组长，5 秒后必须被升级杀掉 ——
  // 这条验 treeKill 里那个升级定时器（复核确认过它能生效，但之前没测）。
  console.log("\n── posix: 非组长忽略 SIGTERM 时升级 SIGKILL ──");
  const stubborn = path.join(BASE, "stubborn.mjs");
  fs.writeFileSync(stubborn, `
process.on("SIGTERM", () => { /* 故意忽略 */ });
setTimeout(() => {}, 120000);
`, "utf-8");
  const midB2 = path.join(BASE, "mid-b2.mjs");
  fs.writeFileSync(midB2, `
import { spawn } from "node:child_process";
import fs from "node:fs";
const c = spawn(process.execPath, [process.argv[2]], { stdio: "ignore" });
fs.writeFileSync(process.argv[3], String(c.pid));
setTimeout(() => {}, 120000);
`, "utf-8");
  const pidFileB2 = path.join(BASE, "stubborn-pid.txt");
  const pB2 = spawn(process.execPath, [midB2, stubborn, pidFileB2], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(900);
  const stubbornPid = Number(fs.readFileSync(pidFileB2, "utf-8").trim() || 0);
  check("B2: 拿到顽固进程 pid", stubbornPid > 0, String(stubbornPid));
  check("B2: 它确实是 node（能过核名）", platform.processNameOf(stubbornPid).includes("node"),
    platform.processNameOf(stubbornPid));
  check("B2: 收尾返回 true", mgr._reapOrphanCommand(stubbornPid, "pnpm-install") === true);
  await sleep(800);
  check("B2: SIGTERM 之后它还活着（证实它忽略了）", platform.pidAlive(stubbornPid) === true,
    `pid=${stubbornPid}`);
  await sleep(5200); // 等过 5 秒升级窗口
  check("B2: ★ 升级 SIGKILL 生效（它死了）", platform.pidAlive(stubbornPid) === false,
    `pid=${stubbornPid} 还活着 —— 升级没发生`);
  try { platform.treeKill(pB2.pid); } catch { /* 已退 */ }

  // —— 场景 C：只有 shell 的组，绝不能被当成孤儿 (复核挖出的误杀)——
  console.log("\n── posix: 安全阀（shell 不得单独构成理由）──");
  const shDir = path.join(BASE, "sh");
  fs.mkdirSync(shDir, { recursive: true });
  // 一个跟下载器毫无关系的 bash 组：组长就是 bash 自己，里面跑 sleep。
  // ★ 必须用**多命令**（`sleep 120; echo done`）：单个命令会被 sh/bash exec 掉，
  //   组里只剩 sleep、看不到 shell —— 复核现场也是这么撞到的。多命令才会留下 bash 作为成员。
  const pC = spawn("bash", ["-c", "sleep 120; echo done"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(700);
  const namesC = platform.treeNames(pC.pid);
  check("C: 这个组的成员名里确实有 shell", namesC.some((n) => /^(bash|sh|dash|zsh)$/.test(n)), JSON.stringify(namesC));
  // 四种 cmdType 都不该认领它
  for (const t of ["pnpm-install", "pip-install", "git-clone", "winget-install"]) {
    check(`C: ★ 无关的 shell 组不被 ${t} 认领`, mgr._reapOrphanCommand(pC.pid, t) === false,
      `treeNames=${JSON.stringify(platform.treeNames(pC.pid))}`);
  }
  await sleep(400);
  check("C: ★ 那个 bash 组还活着（没被误杀）", platform.pidAlive(pC.pid) === true, `pid=${pC.pid}`);
  try { platform.treeKill(pC.pid); } catch { /* 已退 */ }

  // —— 场景 D：指纹对不上时必须放弃（pid 复用的真防线）——
  //
  // ★ 为什么用「活着的 pid」造，而不是用组长已死的现场：
  //   指纹防的是「pid 被复用」——那时 pid 一定被**新进程**占着，pidAlive=true，
  //   processStartOf 读得到，与记录值对不上 → 拒绝。
  //   而「组长已死、组还活着」时 pid 本身没被复用（号被进程组占着），读不到指纹，
  //   代码不拦，继续查组 —— 那是场景 A 已验过的路径。两个场景不可互换。
  console.log("\n── posix: 启动指纹挡住 pid 复用 ──");
  // 造法：起一个**长期活着**的 node 进程（detached → 它是组长，pgid == pid）。
  // 这正好模拟「pid 被一个新进程占着」：pidAlive=true、processStartOf 读得到。
  // 不用 leader 脚本：那个 200ms 就 exit 了，抢不到指纹。
  const pD = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], platform.spawnOpts({ stdio: "ignore" }));
  const pidD = pD.pid;
  await sleep(500);
  const realStart = platform.processStartOf(pidD);
  check("D: 活进程读得到指纹", realStart !== "", JSON.stringify(realStart));
  check("D: 前置条件（树活着、名字对得上）",
    platform.treeAlive(pidD) === true && platform.treeNames(pidD).includes("node"),
    JSON.stringify(platform.treeNames(pidD)));
  // 给一个绝对对不上的指纹（模拟「记录里那个 pid 现在属于别人」）
  check("D: ★ 指纹对不上时拒绝收尾（返回 false）",
    mgr._reapOrphanCommand(pidD, "pnpm-install", "1") === false, `recorded=1 actual=${realStart}`);
  await sleep(600);
  check("D: ★ 拒绝后那个进程确实没被杀", platform.pidAlive(pidD) === true, `pid=${pidD}`);
  // 指纹对得上时照常收
  if (realStart) {
    check("D: 指纹对得上时正常收掉", mgr._reapOrphanCommand(pidD, "pnpm-install", realStart) === true,
      `recorded=${realStart}`);
    await sleep(900);
    check("D: 收掉后进程没了", platform.pidAlive(pidD) === false, `pid=${pidD}`);
  } else {
    try { platform.treeKill(pidD); } catch { /* 已退 */ }
  }

  // —— 场景 E：名字对不上就不杀（原有安全阀，保留）——
  const innocent = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(400);
  check("E: 名字对不上就不杀（node 配 winget 的期望集合）",
    mgr._reapOrphanCommand(innocent.pid, "winget-install") === false);
  await sleep(300);
  check("E: 无辜进程还活着", platform.pidAlive(innocent.pid) === true, `pid=${innocent.pid}`);
  try { platform.treeKill(innocent.pid); } catch { /* 已退 */ }

  // —— 场景 F：指纹的接线（_persist 写 → restore 读）——
  //
  // ★ 为什么必须有这一段（复核指出）：上一版套件只测了「中间层」（直接给 _reapOrphanCommand
  //   传一个指纹），两端接线断了也是 61/0。实测 M6（restore 不再传 childStart）和
  //   M7（_persist 永远写 null）两个变异都没被抓到 —— 指纹其实等于没接上。
  //   这里走真实链路：真起任务 → 真 _persist → 真读 tasks.json → 真 restore()。
  console.log("\n── 指纹接线（_persist 写 → restore 读）──");
  const dataDirF = fs.mkdtempSync(path.join(os.tmpdir(), "hd-orphan-wire-"));
  _resetTaskManager?.();
  const mgrF = getTaskManager(dataDirF);

  // 造一条「正在跑的命令型任务」记录：直接调 _persist 看它写什么
  const fakeChild = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(400);
  const fakeStart = platform.processStartOf(fakeChild.pid);
  check("F: 前置条件（能读到 fakeChild 的指纹）", fakeStart !== "", JSON.stringify(fakeStart));

  // 构造一个最小可落盘的任务（字段与 _persist 读的一致）
  const tid = "f-wire-1";
  mgrF.tasks.set(tid, {
    taskId: tid, url: null, fileName: "wire", filePath: path.join(BASE, "wire"),
    saveDir: BASE, state: "running", total: null, received: 0, speed: 0,
    startedAt: Date.now(), finishedAt: null, elapsed: 0, error: null,
    cancelRequested: false, speedLimit: 0, sessionId: null, sessionPath: null,
    kind: "command", unit: "objects",
    cmd: { type: "pnpm-install", args: [], workdir: BASE, targetDir: path.join(BASE, "wire") },
    cmdType: "pnpm-install", stage: "installing", note: null,
    child: fakeChild, _childStart: fakeStart,
  });
  mgrF._persist();

  let persisted = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dataDirF, "tasks.json"), "utf-8"));
    persisted = (meta.tasks || []).find((x) => x.taskId === tid) || null;
  } catch (e) { persisted = null; }
  check("F: ★ _persist 真的把 childStart 写进 tasks.json",
    persisted != null && persisted.childStart === fakeStart,
    `写进去的是 ${JSON.stringify(persisted && persisted.childStart)}，期望 ${JSON.stringify(fakeStart)}`);
  check("F: childPid 也写对了", persisted != null && persisted.childPid === fakeChild.pid,
    `写入 ${JSON.stringify(persisted && persisted.childPid)}`);

  // 现在把 fakeChild 杀掉（模拟引擎被硬杀），指纹仍留在记录里 —— 
  // 用篡改过的记录跑 restore，验「指纹对不上就放过」。
  try { platform.treeKill(fakeChild.pid); } catch { /* 已退 */ }
  await sleep(500);

  // 写一份被篡改的记录：childPid 指向一个**活着的**无关进程，childStart 故意写错
  const stranger = spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(400);
  const meta2 = JSON.parse(fs.readFileSync(path.join(dataDirF, "tasks.json"), "utf-8"));
  for (const t of meta2.tasks) {
    if (t.taskId === tid) { t.childPid = stranger.pid; t.childStart = "1"; }
  }
  fs.writeFileSync(path.join(dataDirF, "tasks.json"), JSON.stringify(meta2), "utf-8");

  _resetTaskManager?.();
  const mgrR = getTaskManager(dataDirF);
  mgrR.restore();  // 会被指纹拦住
  await sleep(800);
  check("F: ★ 指纹对不上时 restore 放过了那个进程（它活着）", platform.pidAlive(stranger.pid) === true,
    `pid=${stranger.pid} 反而被杀了 —— 指纹接线没起作用`);
  try { platform.treeKill(stranger.pid); } catch { /* 已退 */ }
  try { fs.rmSync(dataDirF, { recursive: true, force: true }); } catch { /* 忽略 */ }

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ══ 三、win32：树口径退化为单进程（设计，不是缺陷）═══════════════════════════
if (platform.name === "win32") {
  console.log("\n── win32: 树口径退化为单进程 ──");
  const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(600);
  check("活进程：treeAlive 与 pidAlive 一致（true）",
    platform.treeAlive(p.pid) === true && platform.pidAlive(p.pid) === true);
  check("treeNames 返回该进程名（node）", platform.treeNames(p.pid).some((n) => /node/i.test(n)),
    JSON.stringify(platform.treeNames(p.pid)));
  try { platform.treeKill(p.pid); } catch { /* 已退 */ }
  await sleep(600);
  check("死后两者都是 false", platform.treeAlive(p.pid) === false && platform.pidAlive(p.pid) === false);
}

// ══ 四、源码契约：只留一条，且它必须在缺陷回来时真的失败 ═════════════════════
// 为什么只留一条：上一版的 6 条源码正则是自证 —— 断言「这段文本里没有某个字符串」，
// 切片失配时 body 为空串，两条 ★ 断言无条件 PASS。复核把 treeAlive 改回 pidAlive
// （退回缺陷本身），Windows 上照样 28 passed。那种断言不是防线，是装饰。
//
// 现在这条唯一的价值是：它能抓住「有人把 treeKill 换回 killTree」这个具体的退化，
// 因为对非组长 pid 来说两者行为不同（场景 B 已经在真机上验过这个差异）。
console.log("\n── 源码契约（唯一一条，行为已在上面验过）──");
const dlPath = path.join(process.cwd(), "engine", "dlcore.js");
const dlSrc = fs.readFileSync(dlPath, "utf-8");
const fnStart = dlSrc.indexOf("_reapOrphanCommand(pid, cmdType");
const fnEnd = fnStart >= 0 ? dlSrc.indexOf("\n  restore()", fnStart) : -1;
const body = fnStart >= 0 && fnEnd > fnStart ? dlSrc.slice(fnStart, fnEnd) : "";
// 先确认切片本身是真的（否则下一句话又变成空串上的无条件通过）
check("源码切片有效（拿到函数体，长度 > 200）", body.length > 200, `len=${body.length}`);
check("★ 收尾走 treeKill（不是 killTree：非组长时两者行为不同）",
  /platform\.treeKill\(/.test(body) && !/platform\.killTree\(/.test(body));
check("★ shell 不在期望镜像名里（认 shell 等于放宽到任何 shell 组）",
  // 只看「期望集合”那几行，不在全篇正文上做否定——
  // 复核指出过：全篇否定会在注释里写了 `"bash"` 时假红。
  !/(?:pnpm|pip)-install"\s*\?\s*\[[^\]]*"(?:sh|bash|dash|zsh)"/.test(body)
  && !/\[\s*"(?:sh|bash|dash|zsh)"/.test(body));

// ★ 升级判据必须**复用** escalationAllowed，不准在 treeKill 里内联一份。
//
// 这条是静态断言，但理由与之前那些“源码正则”不同：
//   · escalationAllowed 的**行为正确性**由上面第五节单独验（三种情形都钉死）；
//   · 这里只验「treeKill 真的在用它」。如果内联一份，两份逻辑会各自漂移 ——
//     而内联那份自然条件下触发不了（要 pid_max 次 fork 才撞号），等于没人看的代码。
//   这是分层：行为测逻辑，静态测复用。M7 变异（把调用换成内联 process.kill(n,0)）
//   就是靠这条抓到的。
const lxPath = path.join(process.cwd(), "engine", "platform", "linux.mjs");
const lxSrc = fs.readFileSync(lxPath, "utf-8");
const tkStart = lxSrc.indexOf("export function treeKill(pid)");
const tkEnd = tkStart >= 0 ? lxSrc.indexOf("\n}", lxSrc.indexOf("return killTree(n);", tkStart)) : -1;
const tkBody = tkStart >= 0 && tkEnd > tkStart ? lxSrc.slice(tkStart, tkEnd) : "";
check("treeKill 源码切片有效", tkBody.length > 200, `len=${tkBody.length}`);
check("★ treeKill 必须调用 escalationAllowed（不准内联一份）",
  /escalationAllowed\(/.test(tkBody));
// darwin 同构，也必须检查 —— 复核指出上一版只读 linux.mjs，
// 把 darwin 的 treeKill 内联掉不会被抓到。
const dwPath = path.join(process.cwd(), "engine", "platform", "darwin.mjs");
const dwSrc = fs.readFileSync(dwPath, "utf-8");
const dtkStart = dwSrc.indexOf("export function treeKill(pid)");
const dtkEnd = dtkStart >= 0 ? dwSrc.indexOf("\n}", dwSrc.indexOf("return killTree(n);", dtkStart)) : -1;
const dtkBody = dtkStart >= 0 && dtkEnd > dtkStart ? dwSrc.slice(dtkStart, dtkEnd) : "";
check("darwin treeKill 源码切片有效", dtkBody.length > 200, `len=${dtkBody.length}`);
check("★ darwin treeKill 也必须调用 escalationAllowed",
  /escalationAllowed\(/.test(dtkBody));
// 不再加「不得出现 process.kill(n, 0)」这种字符串断言：
// 那个函数的注释里就写着这个反例（“不能只看 process.kill(n,0)”），
// 纯文本断言无法区分「注释里的反例」与「真代码」，只会造成假红。
// 上一条「必须复用 escalationAllowed」已经能抓到内联退化（M7 就是靠它抓的），
// 而 escalationAllowed 自身的行为由第五节三种情形钉死 —— 分层就够，不必兼项。

// ══ 五、升级判据：5 秒后该不该发 SIGKILL（M7 变异能被抓到的唯一位置）════════
//
// 为什么必须在单元层测它：自然条件下 pid 复用到同一个号要 pid_max 次 fork
// （本机 4194304），端到端根本造不出来。但复核用 /proc/sys/kernel/ns_last_pid
// 强制抢号时真的打死了一个无关进程 —— 机制是真的，只是难触发。
// 把逻辑抽成 escalationAllowed 就是为了能在这里把三种情形都钉死。
console.log("\n── 升级判据（escalationAllowed）──");
{
  const p = platform;
  if (typeof p.escalationAllowed === "function" && p.name !== "win32") {
    // 造一个真进程拿真指纹
    const live = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], platform.spawnOpts({ stdio: "ignore" }));
    await sleep(400);
    const realStart = p.processStartOf(live.pid);
    check("升级判据: 前置条件（能读到指纹）", realStart !== "", JSON.stringify(realStart));

    check("升级判据: 进程活着且指纹一致 → 允许升级",
      p.escalationAllowed(live.pid, realStart) === true);
    check("★ 升级判据: 指纹对不上（号被抢）→ 绝不升级",
      p.escalationAllowed(live.pid, "1") === false,
      "这条挡的是「5 秒窗口里 pid 被无关进程拿走，定时器把它打死」");
    // 没指纹 → 不升级（唯一规则：没有身份就不动手）
    check("★ 升级判据: 没有记录指纹 → 不升级（不靠名字退路）",
      p.escalationAllowed(live.pid, "") === false,
      "名字不可靠，加指纹的理由就是它；把它当退路等于只说了一半的话");
    check("升级判据: 进程已死 → 不升级",
      p.escalationAllowed(2147483647, realStart) === false);
    check("升级判据: 非法入参 → false 且不抛", (() => {
      try {
        for (const bad of [0, -1, NaN, null, undefined, "abc", {}]) {
          if (p.escalationAllowed(bad, "1") !== false) return false;
        }
        return true;
      } catch { return false; }
    })());
    try { p.treeKill(live.pid); } catch { /* 已退 */ }
  } else {
    // win32：没有升级窗口（taskkill /T /F 一步到位），接口只为形状一致
    check("win32: escalationAllowed 存在且返回布尔",
      typeof p.escalationAllowed === "function" && typeof p.escalationAllowed(process.pid, "") === "boolean");
  }
}

console.log(`\n=== orphan-reap: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

// 小工具：读一个 pid 的 pgid（本套件内部用，不进平台层）
function spawnSyncPgid(pid) {
  try {
    return String(spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout || "").trim();
  } catch { return ""; }
}
