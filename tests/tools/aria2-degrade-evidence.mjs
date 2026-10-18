// 降级实证：aria2 开关打开但 bin 指向不存在的文件 → 必须落回 node-http 且下载照常成功
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { getTaskManager } from "../../engine/dlcore.js";
import { summarizeTask } from "../../engine/summary.js";

// 端口一律向系统要（listen(0) 后取真端口），并行跑不互抢
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const SIZE = 300000;
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-length": String(SIZE), "accept-ranges": "bytes" });
  res.end(BODY);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const SRC_PORT = srv.address().port;

const BASE = path.join(os.tmpdir(), "hd-a2-degrade");
fs.rmSync(BASE, { recursive: true, force: true });
const DATA = path.join(BASE, "data"), OUT = path.join(BASE, "out");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const wait = async (mgr, id) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const s = mgr.snapshot(id);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  return mgr.snapshot(id);
};

// ① bin 配错（文件不存在）→ 降级 node-http
fs.writeFileSync(path.join(DATA, "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, bin: path.join(BASE, "no-such-aria2c.exe"), port: await freePort() },
}, null, 2));
let mgr = getTaskManager(DATA);
let t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/a.bin`, fileName: "bad-bin.bin", saveDir: OUT });
let s = await wait(mgr, t.taskId);
console.log("[1] bin 配错  state=", s.state, "backend=", s.backend, "note=", s.backendNote);
console.log("    SHA 一致=", crypto.createHash("sha256").update(fs.readFileSync(s.filePath)).digest("hex") === SHA);

// ② 配置里没有 aria2 段 → node-http 且无提示
fs.writeFileSync(path.join(DATA, "engine-config.json"), JSON.stringify({ stallTimeoutMs: 30000 }, null, 2));
t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/b.bin`, fileName: "no-cfg.bin", saveDir: OUT });
s = await wait(mgr, t.taskId);
console.log("[2] 无 aria2 段  state=", s.state, "backend=", s.backend, "note=", s.backendNote);
console.log("    summarizeTask.backend =", summarizeTask(s).backend, "| backendNote 键存在 =", "backendNote" in summarizeTask(s));

// ③ enabled:false → node-http
fs.writeFileSync(path.join(DATA, "engine-config.json"), JSON.stringify({ aria2: { enabled: false } }, null, 2));
t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/c.bin`, fileName: "off.bin", saveDir: OUT });
s = await wait(mgr, t.taskId);
console.log("[3] enabled:false  state=", s.state, "backend=", s.backend, "note=", s.backendNote);

srv.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exitCode = 0;
