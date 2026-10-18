// 并发实证：两个 aria2 任务同时跑（dlcore 管并发，aria2 的 max-concurrent-downloads 要对齐）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { getTaskManager } from "../../engine/dlcore.js";
import { aria2Backend, resolveAria2Bin } from "../../engine/backends/aria2.js";

const bin = resolveAria2Bin("");
if (!bin) { console.log("跳过（未检测到 aria2c）"); process.exit(0); }

const SIZE = 700000;
const mk = () => {
  const b = crypto.randomBytes(SIZE);
  return { body: b, sha: crypto.createHash("sha256").update(b).digest("hex") };
};
const A = mk(), B = mk();
const src = http.createServer((req, res) => {
  const isA = (req.url || "").startsWith("/a");
  const { body } = isA ? A : B;
  res.writeHead(200, { "content-length": String(SIZE) });
  let off = 0;
  const tick = () => {
    if (off >= SIZE) return res.end();
    const n = Math.min(50000, SIZE - off);
    res.write(body.subarray(off, off + n));
    off += n;
    setTimeout(tick, 20);
  };
  tick();
});
await new Promise((r) => src.listen(18969, "127.0.0.1", r));

const BASE = path.join(os.tmpdir(), "hd-a2-conc");
fs.rmSync(BASE, { recursive: true, force: true });
const DATA = path.join(BASE, "data"), OUT = path.join(BASE, "out");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(DATA, "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, bin, port: 6873 }, maxConcurrent: 2,
}, null, 2));

const mgr = getTaskManager(DATA);
mgr.applyConfig({ maxConcurrent: 2 });
const t1 = mgr.create({ url: "http://127.0.0.1:18969/a.bin", fileName: "conc-a.bin", saveDir: OUT });
const t2 = mgr.create({ url: "http://127.0.0.1:18969/b.bin", fileName: "conc-b.bin", saveDir: OUT });

const wait = async (id) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const s = mgr.snapshot(id);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 80));
  }
  return mgr.snapshot(id);
};
const [s1, s2] = [await wait(t1.taskId), await wait(t2.taskId)];
const sha = (p) => (p && fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : null);
console.log("[1]", s1.state, s1.backend, "SHA一致=", sha(s1.filePath) === A.sha);
console.log("[2]", s2.state, s2.backend, "SHA一致=", sha(s2.filePath) === B.sha);

await aria2Backend.shutdown();
src.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exitCode = 0;
