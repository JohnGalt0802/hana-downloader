// 手工实证：aria2 backend 真实链路 + SHA 对拍（不属于测试套件，仅取证用）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { getTaskManager } from "../../engine/dlcore.js";
import { resolveAria2Bin } from "../../engine/backends/aria2.js";

// 端口一律向系统要（listen(0) 后取真端口），并行跑不互抢
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const SIZE = 1200000;
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
const st = { cut: true, hits: 0 };

const srv = http.createServer((req, res) => {
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
  if (st.cut) {
    st.hits += 1;
    res.write(BODY.subarray(start, Math.min(start + 30000, end + 1)), () => setTimeout(() => res.destroy(), 20));
    return;
  }
  res.end(BODY.subarray(start, end + 1));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const SRC_PORT = srv.address().port;

const BASE = path.join(os.tmpdir(), "hd-a2-manual");
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(path.join(BASE, "data"), { recursive: true });
fs.mkdirSync(path.join(BASE, "out"), { recursive: true });
fs.writeFileSync(path.join(BASE, "data", "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, bin: resolveAria2Bin(""), port: await freePort() },
}, null, 2));

const mgr = getTaskManager(path.join(BASE, "data"));
const wait = async (id) => {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const s = mgr.snapshot(id);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return mgr.snapshot(id);
};

console.log("源文件 SHA-256 =", SHA, "size =", SIZE);

// 1) 正常下载
st.cut = false;
const t1 = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/plain.bin`, fileName: "plain.bin", saveDir: path.join(BASE, "out") });
const s1 = await wait(t1.taskId);
const sha1 = crypto.createHash("sha256").update(fs.readFileSync(s1.filePath)).digest("hex");
console.log("[1] 正常下载  state=", s1.state, "backend=", s1.backend, "received/total=", s1.received + "/" + s1.total);
console.log("    产物 SHA-256 =", sha1, "一致=", sha1 === SHA);

// 2) 摘要错误
const t2 = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/bad.bin`, fileName: "bad.bin", saveDir: path.join(BASE, "out"), expectedSha256: "0".repeat(64) });
const s2 = await wait(t2.taskId);
console.log("[2] 摘要错误  state=", s2.state, "error=", s2.error);
console.log("    正式文件存在=", fs.existsSync(s2.filePath));

// 3) 中断 → 重试续传
st.cut = true;
const t3 = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/resume.bin`, fileName: "resume.bin", saveDir: path.join(BASE, "out") });
const f3 = await wait(t3.taskId);
const part = f3.filePath + ".part";
console.log("[3] 首轮掐断  state=", f3.state, "error=", f3.error);
console.log("    .part 大小=", fs.existsSync(part) ? fs.statSync(part).size : -1, "掐断次数=", st.hits);
st.cut = false;
mgr.retry(t3.taskId);
const s3 = await wait(t3.taskId);
const buf3 = fs.existsSync(s3.filePath) ? fs.readFileSync(s3.filePath) : null;
console.log("[3] 续传完成  state=", s3.state, "received/total=", s3.received + "/" + s3.total);
console.log("    产物 SHA-256 =", buf3 ? crypto.createHash("sha256").update(buf3).digest("hex") : "无文件", "一致=", buf3 ? crypto.createHash("sha256").update(buf3).digest("hex") === SHA : false);

// 4) 关闭开关后仍走 node-http
fs.writeFileSync(path.join(BASE, "data", "engine-config.json"), JSON.stringify({ aria2: { enabled: false } }, null, 2));
const t4 = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/nodehttp.bin`, fileName: "nodehttp.bin", saveDir: path.join(BASE, "out") });
const s4 = await wait(t4.taskId);
const sha4 = fs.existsSync(s4.filePath) ? crypto.createHash("sha256").update(fs.readFileSync(s4.filePath)).digest("hex") : null;
console.log("[4] 关闭 aria2  state=", s4.state, "backend=", s4.backend, "SHA 一致=", sha4 === SHA);

// 5) 清理：只关自己起的实例
const { aria2Backend } = await import("../../engine/backends/aria2.js");
console.log("[5] 实例信息 =", JSON.stringify(aria2Backend.instanceInfo()));
await aria2Backend.shutdown();
console.log("[5] 关闭后 =", JSON.stringify(aria2Backend.instanceInfo()));

srv.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exitCode = 0;

