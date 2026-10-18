// tests/tools/aria2-hold-engine.mjs — 「引擎进程」替身：开 aria2 下载，然后等着被硬杀
//
// 为什么需要它：要验证「引擎重启后，还在跑的 aria2 任务不该被误判成失败」，必须有
// 一个**真实的引擎进程**被硬杀，而它用的 aria2 实例继续活着下载。
// 同进程里重建 TaskManager 不算数——aria2 backend 的模块态还在，握不到真实场景。
//
// 实例为什么由本脚本自己 detached 起、再写记录让 backend 复用：
// 本机的命令沙箱把整棵进程树放在一个 Job Object 里，引擎进程一死，它非 detached 的子进程
// 会被一起收掉——那不是生产现场（生产里引擎被硬杀时 aria2c 会活下来，正是本任务要修的场景）。
// 用 detached 起的实例等价于「引擎上次 spawn 出来的那个还在跑」：记录里 pid/port/secret 齐全，
// backend 走 ensureInstance 的分支②原样复用，不额外起第二个。
//
// 用法：node tests/tools/aria2-hold-engine.mjs <dataDir> <url> <fileName> <saveDir> <aria2Bin> <port>
// 输出：`TASK <taskId>`，之后保持进程存活，直到父进程硬杀。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { getTaskManager } from "../../engine/dlcore.js";
import { aria2Backend } from "../../engine/backends/aria2.js";

const [dataDir, url, fileName, saveDir, bin, portArg] = process.argv.slice(2);
const port = Number(portArg);

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(saveDir, { recursive: true });

const rpc = async (method, params = [], secret = SECRET) => {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "h", method, params: [`token:${secret}`, ...params] }),
    signal: AbortSignal.timeout(3000),
  });
  const json = JSON.parse(await res.text());
  if (json?.error) throw new Error(json.error.message);
  return json?.result;
};

// ── 起一个 detached 的 aria2 实例，并写下 backend 认得的那份记录 ──
const SECRET = randomBytes(24).toString("hex");
const aria2Dir = path.join(dataDir, "aria2-downloads");
fs.mkdirSync(aria2Dir, { recursive: true });
const proc = spawn(bin, [
  "--enable-rpc",
  `--rpc-listen-port=${port}`,
  `--rpc-secret=${SECRET}`,
  "--rpc-listen-all=false",
  "--rpc-allow-origin-all=false",
  `--dir=${aria2Dir}`,
  "--continue=true",
  "--auto-file-renaming=false",
  "--allow-overwrite=true",
  "--file-allocation=none",
  "--max-concurrent-downloads=4",
  "--disable-ipv6=true",
  "--summary-interval=0",
  "--console-log-level=warn",
  "--quiet=true",
  "--no-conf=true",
], { stdio: "ignore", windowsHide: true, detached: true });
proc.unref();

let version = null;
for (let i = 0; i < 100 && !version; i++) {
  await new Promise((r) => setTimeout(r, 120));
  try { version = (await rpc("aria2.getVersion", [], SECRET))?.version || null; } catch { /* 还没起 */ }
}
if (!version) {
  console.error("aria2 起不来");
  process.exit(2);
}
fs.writeFileSync(path.join(dataDir, "aria2-instance.json"), JSON.stringify({
  pid: proc.pid, port, secret: SECRET, bin, version, startedAt: Date.now(), app: "hana-downloader",
}, null, 2), "utf-8");

fs.writeFileSync(
  path.join(dataDir, "engine-config.json"),
  JSON.stringify({ aria2: { enabled: true, bin, port } }, null, 2),
  "utf-8",
);

aria2Backend.setOptions({ bin, port });
const mgr = getTaskManager(dataDir);
const t = mgr.create({ url, fileName, saveDir });
console.log(`TASK ${t.taskId}`);

// 保持存活：父进程硬杀前一直挂着
setInterval(() => {}, 1000);
