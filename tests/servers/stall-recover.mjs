// tests/servers/stall-recover.mjs（原 _temp/stall-recover-server-v5.mjs，2026-09-20 回仓）
// 自然下载到一半时阻塞 35s，触发 stall 后等脚本 /trigger-resume 恢复：
//   GET /test.bin → 立即发数据（30ms/chunk）→ 发到一半（totalBytes/2）→ 暂停 35s
//   → 收 POST /trigger-resume → 恢复发剩余 → 完成。
//
// 关键：让 stall 在"下载进行到一半"时自然触发，而不是"下载开始 0.5s 后"。
// stallTimeoutMs=500 → stall 在暂停 35s 内 0.5s 后触发。
//
// 用法：node stall-recover-server-v5.mjs <port> <totalMB> [stallFraction]
//   默认：port=0（系统分配，起好后打印真实端口）, totalMB=50, stallFraction=0.5（一半时 stall）
import http from "node:http";

const [, , portArg = "0", mbArg = "50", stallFractionArg = "0.5"] = process.argv;
const port = parseInt(portArg, 10);
const totalBytes = parseInt(mbArg, 10) * 1024 * 1024;
const stallFraction = parseFloat(stallFractionArg);

let resumeResolve = null;
const stallAtBytes = Math.floor(totalBytes * stallFraction);

const server = http.createServer((req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.url === "/trigger-resume" && req.method === "POST") {
    console.log(`[${new Date().toISOString()}] /trigger-resume received`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    if (resumeResolve) resumeResolve();
    return;
  }

  let start = 0;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m) start = parseInt(m[1], 10);
  }

  // Range 续传过来（start 已超过 stallAtBytes）→ 直接发完
  if (start >= stallAtBytes) {
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${start}-${totalBytes - 1}/${totalBytes}`,
      "Content-Length": String(totalBytes - start),
    });
    let sent = start;
    const tick = setInterval(() => {
      if (sent >= totalBytes) { clearInterval(tick); res.end(); return; }
      const chunk = Math.min(16384, totalBytes - sent);
      res.write(Buffer.alloc(chunk, 0x42));
      sent += chunk;
    }, 30);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(totalBytes),
  });

  let sent = 0;
  let stalled = false;
  const tick = setInterval(() => {
    if (stalled) return; // stall 后停发
    if (sent >= stallAtBytes && !stalled) {
      // 到 stallAtBytes → 暂停 35s 等 /trigger-resume
      stalled = true;
      clearInterval(tick);
      console.log(`[${new Date().toISOString()}] sent=${sent}/${totalBytes} (${(stallAtBytes/totalBytes*100).toFixed(1)}%), stall 35s waiting for /trigger-resume`);
      new Promise((r) => { resumeResolve = r; }).then(() => {
        console.log(`[${new Date().toISOString()}] resuming → writing remainder`);
        const tick2 = setInterval(() => {
          if (sent >= totalBytes) { clearInterval(tick2); res.end(); return; }
          const chunk = Math.min(16384, totalBytes - sent);
          if (!res.write(Buffer.alloc(chunk, 0x42))) {}
          sent += chunk;
        }, 30);
      });
      return;
    }
    const chunk = Math.min(16384, totalBytes - sent);
    if (!res.write(Buffer.alloc(chunk, 0x42))) {}
    sent += chunk;
  }, 30);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`stall-recover-server-v5 listening on http://127.0.0.1:${server.address().port}`);
  console.log(`total=${totalBytes} bytes (${(totalBytes/1024/1024).toFixed(2)}MB)`);
  console.log(`natural download → stall at ${(stallFraction*100).toFixed(0)}% (${stallAtBytes} bytes) → wait /trigger-resume`);
});

process.on('SIGINT', () => { console.log('shutting down'); server.close(); process.exit(0); });