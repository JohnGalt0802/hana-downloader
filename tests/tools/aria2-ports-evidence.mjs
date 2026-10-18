// 端口全占用时：capabilities 必须 available:false / reason:"端口被占用"，且不抢占、不影响 node-http 下载
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { getTaskManager } from "../../engine/dlcore.js";
import { aria2Backend, portCandidates, resolveAria2Bin } from "../../engine/backends/aria2.js";
import { capabilitiesOf } from "../../engine/backends/contract.js";

const bin = resolveAria2Bin("");
const BASE = path.join(os.tmpdir(), "hd-a2-ports");
fs.rmSync(BASE, { recursive: true, force: true });
const DATA = path.join(BASE, "data"), OUT = path.join(BASE, "out");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

if (!bin) { console.log("跳过（未检测到 aria2c）"); process.exit(0); }

// 本脚本故意验证「端口全被占」——所以这里必须有一批真被占用的端口。
// 端口仍向系统要（listen(0) 拿一个真端口，然后占住它自己及其后 7 个候选），不写死。
const BASE_PORT = await (async () => {
  for (let i = 0; i < 50; i++) {
    const p = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const q = s.address().port; s.close(() => resolve(q)); });
    });
    if (p + 8 > 65535) continue;
    const cands = portCandidates(p);
    const free = [];
    let ok = true;
    for (const c of cands) {
      const s = net.createServer();
      try { await new Promise((res, rej) => { s.once("error", rej); s.listen(c, "127.0.0.1", res); }); }
      catch { ok = false; s.close(); break; }
      free.push(s);
    }
    if (ok) { for (const s of free) s.close(); return p; }
    for (const s of free) s.close();
  }
  throw new Error("找不到一整段空闲的候选端口段");
})();
aria2Backend.setOptions({ bin, port: BASE_PORT });

const held = [];
for (const p of portCandidates(BASE_PORT)) {
  const srv = net.createServer();
  await new Promise((res, rej) => { srv.once("error", rej); srv.listen(p, "127.0.0.1", res); });
  held.push(srv);
}
console.log("占用端口 =", portCandidates(BASE_PORT).join(","));

const cap = await capabilitiesOf(aria2Backend, { dataDir: DATA });
console.log("capabilities =", JSON.stringify({ available: cap.available, reason: cap.reason }));

const SIZE = 200000;
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
const src = http.createServer((req, res) => {
  res.writeHead(200, { "content-length": String(SIZE) });
  res.end(BODY);
});
await new Promise((r) => src.listen(0, "127.0.0.1", r));
const SRC_PORT = src.address().port;

fs.writeFileSync(path.join(DATA, "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, bin, port: BASE_PORT },
}, null, 2));
const mgr = getTaskManager(DATA);
const t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/x.bin`, fileName: "x.bin", saveDir: OUT });
let s = null;
const t0 = Date.now();
while (Date.now() - t0 < 40000) {
  s = mgr.snapshot(t.taskId);
  if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) break;
  await new Promise((r) => setTimeout(r, 80));
}
console.log("下载 state =", s.state, "backend =", s.backend, "note =", s.backendNote);
console.log("SHA 一致 =", crypto.createHash("sha256").update(fs.readFileSync(s.filePath)).digest("hex") === SHA);
console.log("未起 aria2 进程 =", aria2Backend.instanceInfo().port === null);

for (const h of held) h.close();
src.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exitCode = 0;
