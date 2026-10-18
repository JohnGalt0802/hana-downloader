// fast-server.mjs - quick-完成 download source: return a small file fully then end
import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 0); // 0 = 系统分配，起好后打印真实端口
const FILESIZE = 6 * 1024 * 1024; // 6MB, small but not trivial

function makeBuffer(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 65536) {
    buf.write("FAST_TEST_" + (i % 10) + "_", i, Math.min(10, size - i), "utf8");
  }
  return buf;
}

const body = makeBuffer(FILESIZE);

const server = http.createServer((req, res) => {
  console.log("[serve-fast] " + req.url);
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(FILESIZE),
    "Accept-Ranges": "none",
  });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[serve-fast] listening 127.0.0.1:" + server.address().port + " size=" + FILESIZE);
});

setInterval(() => {}, 1 << 30);
