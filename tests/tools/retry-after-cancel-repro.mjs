// tests/tools/retry-after-cancel-repro.mjs — 「取消后重试永久失败」的复现脚本
//
// 复现的真实路径：
//   1. 高速本地源（64MB，一次 end 推完）
//   2. 发起下载，极短时间（~350ms）内取消 → ws.destroy() 不 flush，写缓冲被丢弃
//   3. 取消瞬间 task.received（内存）远大于 .part（磁盘），甚至 .part 根本不存在
//   4. retry() → startOffset = received → createResumeStream 长度校验失败：
//      「续传失败：半成品文件不可用（ENOENT）」/「半成品文件长度 N 小于续传起点 M」
//   5. 再 retry 一次同样失败 —— retry 原本不清 received，永远拿同一个坏起点，
//      只有重启引擎（走 restore 的 statSync 口径）能自救
//
// 用法（仓库根目录）：node tests/tools/retry-after-cancel-repro.mjs
// 退出码：0 = 连试两次都能正常完成且 SHA 与源一致（修复生效）；1 = 仍然失败（缺陷仍在）。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getTaskManager } from "../../engine/dlcore.js";

const BASE = path.join(os.tmpdir(), "hd-retry-repro");
const DATA_DIR = path.join(BASE, "data");
const OUT_DIR = path.join(BASE, "out");
const SRC_PORT = 18983; // 本复现脚本专用，勿与套件端口重口（18995~18998 已分别被 stall/probe/queue/aria2 占用）
const TOTAL = 64 * 1024 * 1024; // 64MB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const BODY = crypto.randomBytes(TOTAL);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");

// 高速但带节奏：64MB 分 8 块、每 40ms 一块（≈200MB/s 等效，末尾仍快）。
// 不分块的话回环 64MB 常在 250ms 内跑完，根本等不到“用户点取消”的窗口。
const CHUNK = 8 * 1024 * 1024;
function pushBody(res, from) {
  let off = from;
  const tick = () => {
    if (off >= TOTAL) { res.end(); return; }
    const end = Math.min(off + CHUNK, TOTAL);
    res.write(BODY.subarray(off, end));
    off = end;
    setTimeout(tick, 40);
  };
  tick();
}

const src = http.createServer((req, res) => {
  const range = req.headers.range;
  const m = range ? /bytes=(\d+)-/.exec(range) : null;
  const start = m ? Number(m[1]) : 0;
  if (start >= TOTAL) {
    res.writeHead(416, { "content-range": `bytes */${TOTAL}`, "content-length": "0" });
    res.end();
    return;
  }
  if (start > 0) {
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(TOTAL - start),
      "content-range": `bytes ${start}-${TOTAL - 1}/${TOTAL}`,
      "accept-ranges": "bytes",
      etag: '"v1"',
    });
    pushBody(res, start);
    return;
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(TOTAL),
    "accept-ranges": "bytes",
    etag: '"v1"',
  });
  pushBody(res, 0);
});
await new Promise((r) => src.listen(SRC_PORT, "127.0.0.1", r));

const mgr = getTaskManager(DATA_DIR);

async function waitState(taskId, states, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = mgr.snapshot(taskId);
    if (s && states.includes(s.state)) return s;
    await sleep(10);
  }
  return mgr.snapshot(taskId);
}

const t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/big.bin`, fileName: "big.bin", saveDir: OUT_DIR });
const taskId = t.taskId;

// 像用户那样：看着它「在跑」（received>0）就点取消。高速源此时数据几乎全在写流缓冲里。
for (let i = 0; i < 2000; i++) {
  const s = mgr.snapshot(taskId);
  if (s && (s.received >= 8 * 1024 * 1024 || s.state !== "running")) break;
  await sleep(2);
}
const canceled = mgr.cancel(taskId, "user");
const snap1 = await waitState(taskId, ["canceled"], 5000);

const partPath = snap1.filePath + ".part";
const partSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : -1;
console.log("取消瞬间：");
console.log(`  received(内存): ${snap1.received}`);
console.log(`  .part 磁盘:     ${partSize}`);
console.log(`  >>> 内存 > 磁盘，差值 ${snap1.received - Math.max(partSize, 0)} 字节`);
console.log(`  cancel() → ${JSON.stringify(canceled)}  state=${snap1.state}`);

let allOk = true;
for (let round = 1; round <= 2; round++) {
  const r = mgr.retry(taskId);
  console.log(`\nretry #${round}: ${JSON.stringify(r)}`);
  const snap = await waitState(taskId, ["done", "failed", "interrupted", "canceled"], 120000);
  const shaOk = snap.state === "done" && fs.existsSync(snap.filePath)
    && crypto.createHash("sha256").update(fs.readFileSync(snap.filePath)).digest("hex") === SHA;
  console.log(`  state: ${snap.state}`);
  console.log(`  error: ${snap.error}`);
  console.log(`  received/total: ${snap.received}/${snap.total}`);
  console.log(`  文件 SHA 与源一致: ${shaOk}`);
  if (!shaOk) { allOk = false; break; }
  if (round === 1) {
    // 造出「再点一次重试也会失败」的现状：文件删掉、received 复原成坏值、状态回 failed
    fs.rmSync(snap.filePath, { force: true });
    const s = mgr.tasks.get(taskId);
    s.state = "failed";
    s.received = TOTAL; // 内存值与磁盘不符（取消后遗留的坏起点）
    s.error = "构造的失败态（模拟取消遗留的坏 received）";
  }
}

console.log("");
console.log(allOk ? "✅ 连续两次重试都成功，文件 SHA 与源一致（修复生效）" : "❌ 重试失败（缺陷仍在）");

src.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
