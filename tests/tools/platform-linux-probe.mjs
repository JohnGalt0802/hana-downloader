// 平台层真机探针（Linux / WSL）— 逐条打真实往返，不给推断
// 用法：node /root/dlapp/tests/tools/platform-linux-probe.mjs
import { platform } from "../../engine/platform/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`ok   ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? "  " + detail : ""}`); }
};

console.log("platform.name =", platform.name);
ok("name 是 linux", platform.name === "linux");

// ① which
const nodePath = platform.which("node");
ok("which node 命中绝对路径", nodePath.startsWith("/") && fs.existsSync(nodePath), nodePath);
const gitPath = platform.which("git");
ok("which git", gitPath.startsWith("/") && fs.existsSync(gitPath), gitPath);
const nonePath = platform.which("definitely-not-a-cmd-xyz");
ok("which 不存在 → 空串且不抛", nonePath === "", JSON.stringify(nonePath));
// 候选名数组：第一个不存在的应跳过、命中第二个
const multi = platform.which(["definitely-not-a-cmd-xyz", "bash"]);
ok("which 数组候选跳过不存在的", multi.startsWith("/") && fs.existsSync(multi), multi);

// ② exe
ok("exe 不加后缀", platform.exe("git") === "git");

// ③ spawnOpts：detached 必须为 true
const opts = platform.spawnOpts({ stdio: "ignore" });
ok("spawnOpts.detached === true", opts.detached === true);
ok("spawnOpts 透传 extra", opts.stdio === "ignore");

// ④ killTree + pgid（真起三层进程）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
const hb = path.join(tmp, "hb.txt");
const script = path.join(tmp, "tree.sh");
fs.writeFileSync(script, `#!/bin/bash\nwhile true; do echo x >> ${JSON.stringify(hb)}; sleep 0.1; done\n`, { mode: 0o755 });
// 直接起 bash 脚本，脚本自己一直写心跳
const p = spawn("bash", [script], platform.spawnOpts({ stdio: "ignore" }));
await new Promise(r => setTimeout(r, 900));
const sizeOf = () => { try { return fs.statSync(hb).size; } catch { return 0; } };
const grew = sizeOf();
await new Promise(r => setTimeout(r, 500));
ok("子进程在跑（心跳增长）", sizeOf() > grew);
const pgid = Number((await import("node:child_process")).execSync(`ps -o pgid= -p ${p.pid}`).toString().trim());
ok("posix: pgid === pid（detached 成立）", pgid === p.pid, `pgid=${pgid} pid=${p.pid}`);
ok("pidAlive 认得活进程", platform.pidAlive(p.pid) === true);
const name = platform.processNameOf(p.pid);
ok("processNameOf 返回 bash", name === "bash", name);
ok("killTree 返回 true", platform.killTree(p.pid) === true);
await new Promise(r => setTimeout(r, 1200));
const after = sizeOf();
await new Promise(r => setTimeout(r, 400));
ok("杀树后心跳停止（进程组真的死了）", sizeOf() === after, `${after} -> ${sizeOf()}`);
ok("pidAlive 认死进程为 false", platform.pidAlive(p.pid) === false);

// ⑤ isRunning
ok("isRunning('bash') 为 true", platform.isRunning("bash") === true);
ok("isRunning 不存在进程为 false", platform.isRunning("definitely-not-running-xyz") === false);

// ⑥ reveal（不弹窗、但不带崩进程；失败要返回 {ok:false,error}）
const rvMissing = platform.reveal("/nonexistent/path/xyz", "open");
ok("reveal 不存在的路径 → ok:false 且有 error", rvMissing.ok === false && !!rvMissing.error, rvMissing.error);
const probeFile = path.join(tmp, "f.txt");
fs.writeFileSync(probeFile, "x");
// 有 xdg-open 但无图形会话时应返回 ok:false（进程起得来但立刻失败）或 ok:true；
// 关键断言是**引擎进程还活着**，即调用没抛
let rvThrow = null, rv = null;
try { rv = platform.reveal(probeFile, "select"); } catch (e) { rvThrow = e; }
ok("reveal 不抛异常（不带走引擎）", rvThrow === null, rv ? JSON.stringify(rv) : "");

// ⑦ readSystemProxy
const px = platform.readSystemProxy();
ok("readSystemProxy 返回三字段", typeof px.enabled === "boolean" && typeof px.server === "string" && typeof px.source === "string", JSON.stringify(px));
ok("无代理时为 source:none 或 env/gsettings", ["none", "env", "gsettings"].includes(px.source), px.source);
// 环境变量通路
process.env.http_proxy = "http://127.0.0.1:7890/";
const px2 = platform.readSystemProxy();
ok("env 通路命中 http_proxy", px2.enabled === true && px2.server === "127.0.0.1:7890", JSON.stringify(px2));
delete process.env.http_proxy;

// ⑧ 目录
ok("homeDir 非空绝对路径", platform.homeDir().startsWith("/"), platform.homeDir());
ok("tempDir 非空", !!platform.tempDir(), platform.tempDir());
ok("nullDevice === /dev/null", platform.nullDevice() === "/dev/null");

// ⑨ normalizePath 不抹大小写
ok("normalizePath 保留大小写", platform.normalizePath("/A/B/") === "/A/B");
ok("normalizePath 不是同一个键", platform.normalizePath("/A") !== platform.normalizePath("/a"));

// ⑩ capabilities 真实探测
const cap = platform.capabilities;
ok("capabilities 三键齐", "pkgManager" in cap && "proxyControl" in cap && "reveal" in cap, JSON.stringify(cap));
ok("pkgManager 为 apt（真实探测）", cap.pkgManager === "apt", String(cap.pkgManager));
ok("proxyControl 在 linux 为 false", cap.proxyControl === false);
ok("reveal 为 true", cap.reveal === true);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== platform-linux-probe: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
