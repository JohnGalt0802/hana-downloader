// tests/tools/restart-interrupt-repro.mjs — 「引擎重启后宿主空等 30 分钟报假超时」的复现脚本
//
// 复现的真实路径：
//   1. 起引擎 → 发起一个慢下载（1GB 级现场用真外网，这里用本地慢速源等价构造）
//   2. 强杀引擎（模拟 App reload / 宿主重启把引擎进程带走）
//   3. 重启引擎：restore() 把该任务在内存里标成 interrupted
//   4. 看 dataDir/finished/<taskId>.json 有没有出现
//      · 修复前：永远不出现 → app 侧 settleWhenDone 空等 900×2s=30 分钟 → 报「下载超时未结束」（假错误）
//      · 修复后：重启后立刻出现一条 state=interrupted 的终态 → 宿主立刻收到「被应用重启打断」（真原因）
//
// 用法（仓库根目录）：node tests/tools/restart-interrupt-repro.mjs
// 退出码：0 = finished 记录出现（修复生效）；1 = 没出现（缺陷仍在）。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..", "..");
const ENGINE = path.join(appRoot, "engine", "server.js");

const BASE = path.join(os.tmpdir(), "hd-restart-repro");
const DATA_DIR = path.join(BASE, "data");
const OUT_DIR = path.join(BASE, "out");
const ENGINE_PORT = 4325;      // 与生产 4317 / 测试 4319 错开
const SRC_PORT = 18989;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ── 慢速源：声称 64MB，每 100ms 发 64KB（≈640KB/s），足够让引擎「正在下载」时被强杀 ──
const TOTAL = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
const src = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(TOTAL) });
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= TOTAL) { clearInterval(timer); res.end(); return; }
    res.write(Buffer.alloc(CHUNK, 0x41));
    sent += CHUNK;
  }, 100);
  req.on("close", () => clearInterval(timer));
});
await new Promise((r) => src.listen(SRC_PORT, "127.0.0.1", r));

async function startEngine(tag) {
  const child = spawn(process.execPath, [ENGINE, DATA_DIR], {
    env: { ...process.env, HD_ENGINE_PORT: String(ENGINE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false;
  child.stdout.on("data", (c) => { if (String(c).includes("HD_ENGINE_READY")) ready = true; });
  child.stderr.on("data", () => {});
  for (let i = 0; i < 120 && !ready; i++) await sleep(100);
  if (!ready) { console.log(`[${tag}] 引擎起不来`); process.exit(2); }
  return child;
}

const api = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};

let engine = await startEngine("第一次启动");
const created = await api("/download", {
  url: `http://127.0.0.1:${SRC_PORT}/big.bin`,
  fileName: "interrupt.bin",
  saveDir: OUT_DIR,
});
const taskId = created?.taskId;
console.log(`任务已创建 | taskId=${taskId} | state=${created?.state}`);

// 等它真的跑起来（received > 0），模拟「1GB 下到一半」
let received = 0;
for (let i = 0; i < 100 && received <= 0; i++) {
  await sleep(100);
  const l = await api("/list").catch(() => null);
  received = (l?.tasks || []).find((t) => t.taskId === taskId)?.received || 0;
}
console.log(`下载进行中 | received=${received} 字节`);

// ── 强杀引擎：模拟 App reload / 宿主重启。不做优雅退出，finished 文件来不及写 ──
engine.kill();
await sleep(600);
const finishedPath = path.join(DATA_DIR, "finished", `${taskId}.json`);
console.log(`强杀后 finished/${taskId}.json 存在？ ${fs.existsSync(finishedPath)}`);

// ── 重启引擎：restore() 才把任务标成 interrupted ──
const t0 = Date.now();
engine = await startEngine("第二次启动（restore）");

// 给 restore 一点时间，然后按 app 侧同样的方式轮询
let snap = null;
for (let i = 0; i < 50 && !snap; i++) {
  await sleep(200);
  try {
    if (fs.existsSync(finishedPath)) snap = JSON.parse(fs.readFileSync(finishedPath, "utf8"));
  } catch { /* 半写，下一轮 */ }
}
const waited = Date.now() - t0;

console.log("");
if (snap) {
  console.log(`✅ 重启后 ${waited}ms 就拿到终态（修复生效）`);
  console.log(`   state   = ${snap.state}`);
  console.log(`   error   = ${snap.error}`);
  console.log(`   received= ${snap.received}`);
  console.log(`   等价于宿主立刻收到：下载失败：interrupt.bin（${snap.error}）`);
} else {
  console.log(`❌ 重启后 ${waited}ms 仍未出现 finished/${taskId}.json（缺陷仍在）`);
  console.log(`   真实后果：settleWhenDone 要空等 900×2s = 30 分钟后报「下载超时未结束」（假错误）`);
  const l = await api("/list").catch(() => null);
  const t = (l?.tasks || []).find((x) => x.taskId === taskId);
  console.log(`   内存里其实已是：state=${t?.state} error=${t?.error}`);
}

try { engine.kill(); } catch { /* 已退出 */ }
src.close();
await sleep(200);
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(snap ? 0 : 1);
