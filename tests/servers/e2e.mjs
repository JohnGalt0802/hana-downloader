// hd-e2e-server.mjs — 本地下载测试源（2MB 一次性）
// 端口向系统要（listen(0)），起好后把真实端口打出来；也可用参数指定端口。
import http from "node:http";
const size = 2 * 1024 * 1024;
const data = Buffer.alloc(size, 0x41);
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
  res.end(data);
});
const portArg = Number(process.argv[2] ?? process.env.PORT ?? 0);
srv.listen(portArg, "127.0.0.1", () => {
  console.log("E2E_SERVER_READY");
  console.log(`127.0.0.1:${srv.address().port}`);
});
