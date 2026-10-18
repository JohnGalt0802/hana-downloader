// 引擎级实证：起真引擎（engine/server.js），开 aria2，走 HTTP 面下载 → SHA 对拍 + /settings 读 aria2 段
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { resolveAria2Bin } from "../../engine/backends/aria2.js";

// 端口一律向系统要（listen(0) 后取真端口），并行跑不互抢
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const SIZE = 900000;
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const src = http.createServer((req, res) => {
  const range = req.headers.range;
  let start = 0, end = SIZE - 1;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
  }
  const h = { "content-length": String(end - start + 1), "accept-ranges": "bytes" };
  if (range) h["content-range"] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(range ? 206 : 200, h);
  res.end(BODY.subarray(start, end + 1));
});
await new Promise((r) => src.listen(0, "127.0.0.1", r));
const SRC_PORT = src.address().port;

const BASE = path.join(os.tmpdir(), "hd-aria2-engine");
fs.rmSync(BASE, { recursive: true, force: true });
const DATA_DIR = path.join(BASE, "data");
const SAVE_DIR = path.join(BASE, "out");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SAVE_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, bin: resolveAria2Bin(""), port: await freePort() },
}, null, 2));

const PORT = await freePort();
const engine = spawn(process.execPath, [path.resolve("engine/server.js"), DATA_DIR], {
  env: { ...process.env, HD_ENGINE_PORT: String(PORT) },
  stdio: "ignore",
});
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  await sleep(100);
  try { const r = await fetch(`http://127.0.0.1:${PORT}/ping`); ready = (await r.json())?.ok === true; } catch { /* 等 */ }
}
console.log("engine ready =", ready);
if (!ready) { src.close(); process.exit(1); }

const api = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
};

const settings = await api("/settings");
console.log("/settings aria2 =", JSON.stringify(settings.settings?.aria2));

const made = await api("/download", {
  url: `http://127.0.0.1:${SRC_PORT}/engine.bin`, fileName: "engine.bin", saveDir: SAVE_DIR,
});
console.log("/download =", JSON.stringify(made));

let snap = null;
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  snap = (await api(`/wait?taskId=${made.taskId}`)).snap;
  if (snap && ["done", "failed", "canceled", "interrupted"].includes(snap.state)) break;
  await sleep(200);
}
console.log("/wait state =", snap?.state, "backend =", snap?.backend, "received/total =", snap?.received + "/" + snap?.total);
const fp = snap?.filePath;
const got = fp && fs.existsSync(fp) ? crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex") : null;
console.log("源 SHA-256      =", SHA);
console.log("产物 SHA-256    =", got);
console.log("SHA 一致        =", got === SHA);

// /list 里也要带 backend
const listed = await api("/list");
const row = (listed.tasks || []).find((x) => x.taskId === made.taskId);
console.log("/list backend   =", row?.backend, "| 字段齐备 =", ["backend", "backendNote"].every((k) => k in (row || {})));

engine.kill();
await sleep(800);
src.close();
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 刷盘中 */ }
process.exitCode = 0;
