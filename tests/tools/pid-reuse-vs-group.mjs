// pid-reuse-vs-group.mjs — 关键前提验证：进程组还活着时，那个 pid 还能被系统复用吗？
//
// 这条决定「组长已死、组员还活着」时能不能安全地 kill(-pid)：
//   · 若 pid 会被复用 → kill(-pid) 可能打到别人的进程组，不能杀。
//   · 若 group 存在期间 pgid 被内核占住、不可复用 → kill(-pid) 仍然只指向我们那个组，可以杀。
// Linux 的 struct pid 有引用计数：进程组存在期间（作为 pgid 被引用），对应 pid 不会被回收复用。
// 这里不引用内核文档，直接造现场测。
//
// 用法：node tests/tools/pid-reuse-vs-group.mjs   （仅 linux）

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { platform } from "../../engine/platform/index.mjs";

if (platform.name !== "linux") {
  console.log(`本探针只在 linux 上有意义（当前 ${platform.name}）`);
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pidreuse-"));
const hb = path.join(tmp, "hb.txt");
const script = path.join(tmp, "leader.sh");
// 组长起一个后台成员写心跳，然后自己退出 —— 组员留下，进程组仍存在。
fs.writeFileSync(script, `#!/bin/bash
( while true; do echo x >> ${JSON.stringify(hb)}; sleep 0.05; done ) &
disown
sleep 0.2
exit 0
`, { mode: 0o755 });

const leader = spawn("bash", [script], platform.spawnOpts({ stdio: "ignore" }));
const oldPid = leader.pid;
await new Promise((r) => setTimeout(r, 1000));

check("组长已退出", platform.pidAlive(oldPid) === false, `pid=${oldPid}`);

let groupAlive = false;
try { process.kill(-oldPid, 0); groupAlive = true; } catch { groupAlive = false; }
check("进程组仍存在（kill(-pid,0) 成功）", groupAlive === true, `-${oldPid}`);

// 狂起进程，看有没有谁拿到 oldPid
console.log("\n── 起 300 个短命进程，看 oldPid 是否被复用 ──");
const seen = new Set();
let hit = false;
for (let round = 0; round < 30; round++) {
  const kids = [];
  for (let i = 0; i < 10; i++) {
    const k = spawn("/bin/true", [], { stdio: "ignore" });
    kids.push(k);
  }
  for (const k of kids) {
    if (k.pid) seen.add(k.pid);
    if (k.pid === oldPid) hit = true;
    await new Promise((r) => k.on("exit", r));
  }
}
console.log(`   本轮船到 ${seen.size} 个不同 pid，最大 ${Math.max(...seen)}，oldPid=${oldPid}`);

let groupStillAlive = false;
try { process.kill(-oldPid, 0); groupStillAlive = true; } catch { groupStillAlive = false; }

check("300 次分配里 oldPid 未被复用", hit === false, hit ? "★ 被复用了：kill(-pid) 有误杀风险" : "");
check("组在此期间始终活着", groupStillAlive === true);

// 心跳还在涨 = 组员确实还在跑
const sizeOf = () => { try { return fs.statSync(hb).size; } catch { return 0; } };
const s1 = sizeOf();
await new Promise((r) => setTimeout(r, 400));
check("组员仍在运行（心跳增长）", sizeOf() > s1, `${s1} -> ${sizeOf()}`);

// 结论
console.log("");
if (!hit && groupStillAlive) {
  console.log("★ 结论：进程组存活期间 pgid 未被复用。因此「组长已死 + 组仍活着」时");
  console.log("  kill(-pid) 依然只指向我们当初建的那个组，可以安全地整组清掉。");
} else if (hit) {
  console.log("★ 结论相反：pgid 被复用了。kill(-pid) 在组长已死的分支上不能直接用。");
} else {
  console.log("介于两者之间，需要人工判断。");
}

try { process.kill(-oldPid, "SIGKILL"); } catch { /* 已空 */ }
await new Promise((r) => setTimeout(r, 300));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n=== checks: ${pass} passed, ${fail} failed ===`);
process.exit(0);
