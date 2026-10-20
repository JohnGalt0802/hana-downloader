// tests/unit-processtree.mjs — 进程树：起进程与杀进程树成对（2026-10-20 新增）
//
// 为什么单独一个套件：这是整个跨平台重构里**唯一会静默损坏用户数据**的一对
// （方案 §3.3 原则一 / §7.2）。旧代码的两处缺陷：
//   · dlcore.js:550 起命令型子进程没给 detached，而 716 行的 kill(-pid) 依赖它 ——
//     取消命令型任务时只有组长被杀，孙进程（git 拉起的 ssh、uv 拉起的 python）活下来。
//   · posix 上加了 detached 之后，引擎被 SIGKILL 时子进程不再跟着死 —— 会变孤儿。
// 两者是同一枚硬币的两面，所以断言必须成对写：**能杀掉** + **不会留孤儿**。
//
// 本套件不依赖网络、不依赖宿主，只起自己的 node 子进程。
// 端口与临时目录都走系统分配 / mkdtempSync（AGENTS.md §2.2，可并行跑）。
//
// 用法（仓库根目录）：node tests/unit-processtree.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-proctree-"));
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

// 一个会「生孙子」的脚本：父进程 sleep，子进程写心跳文件。
// 用它验证「杀进程树」真能杀掉孙进程，而不只是组长。
const HEARTBEAT = path.join(BASE, "hb.txt");
const PARENT = path.join(BASE, "parent.mjs");
const CHILD = path.join(BASE, "child.mjs");

fs.writeFileSync(CHILD, `
import fs from "node:fs";
const hb = process.argv[2];
setInterval(() => { try { fs.appendFileSync(hb, "x"); } catch {} }, 120);
`, "utf-8");

fs.writeFileSync(PARENT, `
import { spawn } from "node:child_process";
const [childPath, hb] = process.argv.slice(2);
const c = spawn(process.execPath, [childPath, hb], { stdio: "ignore" });
process.on("exit", () => { try { c.kill(); } catch {} });
setInterval(() => {}, 1000);
`, "utf-8");

const hbSize = () => { try { return fs.statSync(HEARTBEAT).size; } catch { return 0; } };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

// ══ 一、spawnOpts 与 killTree 的平台语义 ═══════════════════════════════════
console.log("── spawnOpts / killTree 语义 ──");

check("win32.spawnOpts 带 windowsHide，不带 detached", () => {
  const o = createPlatform("win32").spawnOpts();
  return o.windowsHide === true && o.detached === undefined;
});
check("darwin.spawnOpts 带 detached:true", () => createPlatform("darwin").spawnOpts().detached === true);
check("linux.spawnOpts 带 detached:true", () => createPlatform("linux").spawnOpts().detached === true);
check("posix.spawnOpts 允许调用方覆盖 detached（显式传入优先）", () =>
  createPlatform("linux").spawnOpts({ detached: false }).detached === false);
check("spawnOpts 不污染调用方对象", () => {
  const extra = { cwd: BASE };
  createPlatform("linux").spawnOpts(extra);
  return extra.detached === undefined && extra.windowsHide === undefined;
});

// ══ 二、真实起进程：能杀掉整棵树 ═══════════════════════════════════════════
console.log("\n── 杀进程树（真起进程，含孙子）──");

// 用本机真实平台起进程（而不是模拟）：这里验的是「实际行为」，不是「配置长什么样」。
// 两个平台都要跑：win32 靠 taskkill /T，posix 靠 kill(-pid)。机制不同，但**「孙进程也必须死」**
// 是同一个契约——这正是旧代码在两端各错一次的地方。
{
  const p = spawn(process.execPath, [PARENT, CHILD, HEARTBEAT], platform.spawnOpts({ stdio: "ignore" }));
  await sleep(900);
  const grewBefore = hbSize();
  await sleep(500);
  check("心跳确实在增长（证明孙子进程活着）", () => hbSize() > grewBefore);

  const killedOk = platform.killTree(p.pid);
  check("killTree 返回 true", () => killedOk === true);
  await sleep(900);
  const sizeAfterKill = hbSize();
  await sleep(900);
  check("**杀树后心跳停止**（孙进程真的死了，不是只有组长）", () => hbSize() === sizeAfterKill);
  check("组长已退出", () => !pidAlive(p.pid));
}

// ══ 三、detached 的代价：引擎被硬杀时子进程会变孤儿，必须能收掉 ═══════════
console.log("\n── detached 的孤儿风险与收尾 ──");

check("平台层给了 pidAlive 与 processNameOf 两个收尾所需的原语", () => {
  const p = createPlatform(platform.name);
  return typeof p.pidAlive === "function" && typeof p.processNameOf === "function";
});
check("pidAlive(当前进程) === true", () => platform.pidAlive(process.pid) === true);
check("pidAlive(不存在的 pid) === false", () => platform.pidAlive(2147483647) === false);
check("pidAlive 非法入参不抛且为 false", () => {
  for (const bad of [0, -1, NaN, null, undefined, "abc", {}]) {
    if (platform.pidAlive(bad) !== false) return false;
  }
  return true;
});
check("processNameOf(当前进程) 能拿到名字", () => {
  const n = platform.processNameOf(process.pid);
  // node 在 win 上是 node.exe → "node"；posix 上 comm 可能是 "node" 或 "nodejs"
  return typeof n === "string" && n.length > 0 && /node/i.test(n);
});
check("processNameOf(不存在的 pid) === \"\"", () => platform.processNameOf(2147483647) === "");

// 真实验证「收孤儿」的两个前提：① pid 活着能被探到 ② 名字能被核上
if (platform.name !== "win32") {
  const orphan = spawn(process.execPath, [CHILD, path.join(BASE, "hb2.txt")],
    platform.spawnOpts({ stdio: "ignore" }));
  await sleep(600);
  check("子进程活着时 pidAlive 报 true", () => platform.pidAlive(orphan.pid) === true);
  check("子进程的镜像名能被核上（收孤儿的安全阀）", () => /node/i.test(platform.processNameOf(orphan.pid)));
  try { platform.killTree(orphan.pid); } catch { /* 已退 */ }
  await sleep(500);
  check("清掉后 pidAlive 报 false", () => platform.pidAlive(orphan.pid) === false);
}

// ══ 四、引擎侧契约：命令型子进程必须用 spawnOpts，且 pid 落盘 ═════════════
console.log("\n── 引擎源码契约（静态断言，防回归）──");

const dlcoreSrc = fs.readFileSync(path.join(process.cwd(), "engine", "dlcore.js"), "utf-8");
check("dlcore 命令型 spawn 走 platform.spawnOpts（不再手写 windowsHide）", () => {
  // 允许注释里出现旧写法，只拒绝真实的选项对象写法
  const bad = /spawn\(cmdBin,\s*fullArgs,\s*\{\s*[\s\S]{0,200}?windowsHide:/;
  return !bad.test(dlcoreSrc);
});
check("dlcore 取消走 platform.killTree（不再内联 taskkill / process.kill(-pid)）", () => {
  return !/spawnSync\(\s*"taskkill"/.test(dlcoreSrc) && !/process\.kill\(-t\.child\.pid/.test(dlcoreSrc);
});
check("dlcore 落盘 childPid（孤儿收尾的唯一依据）", () => /childPid:/.test(dlcoreSrc));
check("dlcore 有 _reapOrphanCommand（收孤儿命令）", () => /_reapOrphanCommand\s*\(/.test(dlcoreSrc));
check("dlcore 不再出现 process.platform", () => !/process\.platform/.test(dlcoreSrc));

const serverSrc = fs.readFileSync(path.join(process.cwd(), "engine", "server.js"), "utf-8");
check("server 的 reveal 走 platform.reveal（不再直接 spawn explorer.exe）", () =>
  /platform\.reveal\(/.test(serverSrc) && !/spawn\("explorer\.exe"/.test(serverSrc));
check("server 不再出现 process.platform", () => !/process\.platform/.test(serverSrc));

const aria2Src = fs.readFileSync(path.join(process.cwd(), "engine", "backends", "aria2.js"), "utf-8");
check("aria2 不再出现 process.platform", () => !/process\.platform/.test(aria2Src));
check("aria2 探测走 platform.which", () => /platform\.which\("aria2c"\)/.test(aria2Src));
check("aria2 保留了 opts.candidates 注入（测试用的隔离手段）", () => /opts\.candidates/.test(aria2Src));

const pcSrc = fs.readFileSync(path.join(process.cwd(), "engine", "proxy-control.js"), "utf-8");
check("proxy-control 的进程探测走 platform.isRunning", () => /platform\.isRunning\(/.test(pcSrc));
check("proxy-control 的系统代理走 platform.readSystemProxy", () => /platform\.readSystemProxy\(/.test(pcSrc));

// 全局：除 platform/ 目录外，engine/ 下不许出现 process.platform
const offenders = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "platform") continue; // 唯一豁免
      walk(p);
    } else if (/\.(m?js)$/.test(e.name)) {
      const src = fs.readFileSync(p, "utf-8");
      // 注释行不算：只检查非注释行
      const hit = src.split(/\r?\n/).some((line) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
        return /process\.platform/.test(line);
      });
      if (hit) offenders.push(path.relative(process.cwd(), p));
    }
  }
}
walk(path.join(process.cwd(), "engine"));
check("engine/ 下除 platform/ 外 process.platform 归零（方案 §8 全局验收 1）", () => {
  if (offenders.length) console.log("   违规文件:", offenders.join(", "));
  return offenders.length === 0;
});

console.log(`\n=== processtree: ${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ""} ===`);
process.exit(fail ? 1 : 0);
