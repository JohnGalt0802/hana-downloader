// slow-server.mjs - 慢速下载源：6MB 限速发送，用于构造"下载在 agent 收束后才完成"的象限2场景
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 0); // 0 = 系统分配，起好后打印真实端口
const FILESIZE = 6 * 1024 * 1024; // 6MB
const CHUNK = 16 * 1024;          // 16KB per chunk
const INTERVAL_MS = 200;          // 每 200ms 发一个 chunk → 16KB/0.2s ≈ 80KB/s → 6MB ≈ 75s

function makeBuffer(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 65536) {
    buf.write("SLOW_TEST_" + (i % 10) + "_", i, Math.min(13, size - i), "utf8");
  }
  return buf;
}

const body = makeBuffer(FILESIZE);

const server = http.createServer((req, res) => {
  console.log("[serve-slow] " + req.url);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(FILESIZE),
    "Accept-Ranges": "none",
  });
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= FILESIZE) {
      clearInterval(timer);
      console.log("[serve-slow] done sending " + FILESIZE);
      res.end();
      return;
    }
    const end = Math.min(sent + CHUNK, FILESIZE);
    res.write(body.subarray(sent, end));
    sent = end;
  }, INTERVAL_MS);
  req.on("close", () => clearInterval(timer));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[serve-slow] listening 127.0.0.1:" + server.address().port + " size=" + FILESIZE + " rate≈" + Math.round(CHUNK * 1000 / INTERVAL_MS) + "B/s");
});
