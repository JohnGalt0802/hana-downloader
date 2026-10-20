// orphan-posix-mechanism.mjs — 「探活组长 vs 杀进程组」错配的真机取证 + 修复验证
//
// 历史（审查 A，docs/跨平台适配层-实施记录-20261020.md §9.1）：
//   _reapOrphanCommand:  pidAlive(pid)            ← 探的是「组长」
//                        killTree(pid) → kill(-pid)   ← 杀的是「进程组」
// 组长先死、组员还活着时 pidAlive 返回 false，函数直接 return ——
// 而 kill(-pid) 本来还能把整组清掉。**探活和杀的对象不是同一个东西。**
//
// 这个脚本分两段：
//   一、取证：造出「组长已死、组员在跑」的现场，证明 pidAlive=false 而 treeAlive=true。
//   二、验证修复：同样现场下，_reapOrphanCommand 必须返回 true 且组员心跳真的停。
//
// 用法：node tests/tools/orphan-posix-mechanism.mjs   （仅 posix 可跑）

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { platform } from "../../engine/platform/index.mjs";

if (platform.name === "win32") {
  console.log("win32 没有进程组概念（killTree 走 taskkill /T），本探针跳过");
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 造现场：组长是 node，起一个 node 组员写心跳，然后组长自己退出。
 *
 * 为什么用 node 而不是 bash：_reapOrphanCommand 会按 cmdType 核镜像名，
 * 传 pnpm-install 时期望集合里有 node。用 node 才能让“核名”这一关通过，
 * 从而真正测到探活口径那一步（否则会停在核名失败上，测不到想测的东西）。
 */
const workerPath = path.join(tmp, "worker.mjs");
const leaderPath = path.join(tmp, "leader.mjs");
fs.writeFileSync(workerPath, `
import fs from "node:fs";
const hb = process.argv[2];
setInterval(() => { try { fs.appendFileSync(hb, "x"); } catch {} }, 80);
`, "utf-8");
fs.writeFileSync(leaderPath, `
import { spawn } from "node:child_process";
const [worker, hb] = process.argv.slice(2);
const c = spawn(process.execPath, [worker, hb], { stdio: "ignore" });
c.unref();
setTimeout(() => process.exit(0), 200);
`, "utf-8");

/** 起一个“组长会自己退出”的现场，返回组长 pid 与心跳文件路径。 */
function spawnOrphanScene(tag) {
  const hb = path.join(tmp, `hb-${tag}.txt`);
  const p = spawn(process.execPath, [leaderPath, workerPath, hb], platform.spawnOpts({ stdio: "ignore" }));
  return { pid: p.pid, hb };
}

const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// ══ 一、取证：组长死、组活 ══════════════════════════════════════════════════
console.log("── 一、错配取证：组长已死，进程组还活着 ──");

const s1 = spawnOrphanScene("probe");
const pid1 = s1.pid, hb1 = s1.hb;
await sleep(1200); // 等组长退出

check("组长已退出（pidAlive 为 false）", platform.pidAlive(pid1) === false, `pid=${pid1}`);

const a1 = sizeOf(hb1);
await sleep(500);
check("组长死后组员还活着（心跳仍在增长）", sizeOf(hb1) > a1, `${a1} -> ${sizeOf(hb1)}`);

check("★ 但进程树仍可探活（treeAlive 为 true）", platform.treeAlive(pid1) === true, `-${pid1}`);

const names1 = platform.treeNames(pid1);
check("treeNames 能问到组员（组长已死也问得到）", names1.length > 0, JSON.stringify(names1));
check("组员名是 node", names1.includes("node"), JSON.stringify(names1));

console.log("");
console.log("★ 取证成立：pidAlive=false、treeAlive=true —— 旧写法用前者探、用后者杀，");
console.log("  在「组长已死」的现场必然空转。这就是错配，不是推断。");
console.log("");

// 清掉这个现场（探针自己的）
try { process.kill(-pid1, "SIGKILL"); } catch { /* 已空 */ }
await sleep(300);

// ══ 二、验证修复：走真实的 _reapOrphanCommand ═══════════════════════════════
console.log("── 二、修复验证：_reapOrphanCommand 必须收掉这个孤儿 ──");

const { getTaskManager, _resetTaskManager } = await import("../../engine/dlcore.js");
_resetTaskManager?.();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-data-"));
const mgr = getTaskManager(dataDir);

const s2 = spawnOrphanScene("reap");
const pid2 = s2.pid, hb2 = s2.hb;
await sleep(1200);

check("（复现前提）组长已退出", platform.pidAlive(pid2) === false, `pid=${pid2}`);
const beforeReap = sizeOf(hb2);
await sleep(400);
check("（复现前提）组员仍在写", sizeOf(hb2) > beforeReap, `${beforeReap} -> ${sizeOf(hb2)}`);

let reaped = null, threw = null;
try { reaped = mgr._reapOrphanCommand(pid2, "pnpm-install"); } catch (e) { threw = e; }
check("_reapOrphanCommand 不抛", threw === null, threw ? String(threw.message) : "");
check("★ 返回 true（认出并试图收掉）", reaped === true, String(reaped));

await sleep(900);
const afterReap = sizeOf(hb2);
await sleep(500);
check("★ 心跳真的停了（组员被杀掉）", sizeOf(hb2) === afterReap, `${afterReap} -> ${sizeOf(hb2)}`);
check("进程树已消失", platform.treeAlive(pid2) === false, `-${pid2}`);

// 安全阀回归：pid 指向一个不属于我们的进程时，不能杀
const innocent = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], platform.spawnOpts({ stdio: "ignore" }));
await sleep(300);
const innocentPid = innocent.pid;
// 用 winget-install 的期望集合（winget）去核一个 node 进程 → 名字对不上，必须拒绝
let guardResult = null;
try { guardResult = mgr._reapOrphanCommand(innocentPid, "winget-install"); } catch { guardResult = "threw"; }
check("安全阀：名字对不上就不杀", guardResult === false, String(guardResult));
await sleep(300);
check("无辜进程还活着", platform.pidAlive(innocentPid) === true, `pid=${innocentPid}`);
try { platform.killTree(innocentPid); } catch { /* 已退 */ }

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== orphan-mechanism: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
