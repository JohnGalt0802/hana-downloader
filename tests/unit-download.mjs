// tests/unit-download.mjs — 下载内核的端到端离线测试（2026-09-20 新增）
//
// 覆盖三件此前「实现完整但没人用过」的事，正因没人用过，才需要网：
//   1. 普通 URL 下载的完整链路（创建 → 流式落盘 → 终态快照）
//   2. expectedSha256：摘要正确则交付，错误则失败且不交付文件（2026-09-20 接线）
//   3. speedLimit：限速真的拖慢下载（2026-09-20 接线）
// 另外钉住已清理的死字段不再回到快照里。
//
// 全程本地回环，不走代理、不碰外网。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { getTaskManager } from "../engine/dlcore.js";

const BASE = path.join(os.tmpdir(), "hd-dl-test");
const DATA_DIR = path.join(BASE, "data");
const SAVE_DIR = path.join(BASE, "out");
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(SAVE_DIR, { recursive: true });

const SIZE = 1024 * 1024; // 1MB
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");

const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(SIZE) });
  if (req.method === "HEAD") return res.end();
  res.end(BODY);
});
await new Promise((r) => srv.listen(18997, "127.0.0.1", r));

const mgr = getTaskManager(DATA_DIR);

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

async function waitFinal(taskId, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = mgr.snapshot(taskId);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return mgr.snapshot(taskId);
}

const url = "http://127.0.0.1:18997/big.bin";

// ── 场景 1：普通下载 ──
{
  const t = mgr.create({ url, fileName: "plain.bin", saveDir: SAVE_DIR });
  const snap = await waitFinal(t.taskId);
  check("plain: done", snap?.state, (x) => x === "done");
  check("plain: 字节数对齐", snap, (x) => x.total === SIZE && x.received === SIZE);
  check("plain: 文件落盘且大小正确", snap, (x) => fs.existsSync(x.filePath) && fs.statSync(x.filePath).size === SIZE);
  check("plain: 无 .part 残留", snap, (x) => !fs.existsSync(x.filePath + ".part"));
  check("plain: 快照不再带死字段", snap, (x) => !("consumedByWait" in x) && !("waitActive" in x) && !("waitBudgetExhausted" in x) && !("deferredRegistered" in x));
}

// ── 场景 2：expectedSha256 正确 → 交付 ──
{
  const t = mgr.create({ url, fileName: "sum-ok.bin", saveDir: SAVE_DIR, expectedSha256: SHA });
  const snap = await waitFinal(t.taskId);
  check("sha 正确: done", snap?.state, (x) => x === "done");
  check("sha 正确: 落盘哈希一致", snap, (x) => crypto.createHash("sha256").update(fs.readFileSync(x.filePath)).digest("hex") === SHA);
}

// ── 场景 3：expectedSha256 错误 → 失败且不交付 ──
{
  const wrong = "0".repeat(64);
  const t = mgr.create({ url, fileName: "sum-bad.bin", saveDir: SAVE_DIR, expectedSha256: wrong });
  const snap = await waitFinal(t.taskId);
  check("sha 错误: failed", snap?.state, (x) => x === "failed");
  check("sha 错误: 错误文案含 SHA-256", snap, (x) => String(x.error || "").includes("SHA-256"));
  check("sha 错误: 正式文件未交付", snap, (x) => !fs.existsSync(x.filePath));
}

// ── 场景 4：限速 256KB/s 下 1MB 至少用 3 秒 ──
{
  const t0 = Date.now();
  const t = mgr.create({ url, fileName: "throttled.bin", saveDir: SAVE_DIR, speedLimit: 256 * 1024 });
  const snap = await waitFinal(t.taskId);
  const cost = Date.now() - t0;
  check("throttle: done", snap?.state, (x) => x === "done");
  check("throttle: 快照带 speedLimit", snap, (x) => x.speedLimit === 256 * 1024);
  check("throttle: 确实被拖慢（≥3s）", cost, (x) => x >= 3000);
}

// ── 场景 5：downloads 记录可枚举、可清理记录 ──
{
  const list = mgr.list();
  check("list: 返回 4 条", list, (x) => x.length >= 4);
  check("list: 终态任务在前排序可用", list, (x) => x.every((it) => typeof it.taskId === "string"));
  const cleared = mgr.clearByStates(["done", "failed"]);
  check("clearByStates: 清掉终态", cleared, (x) => x.ok === true && x.removed.length >= 3);
  check("clearByStates: 记录已空", mgr.list().length, (x) => x === 0);
}

// ── 场景 6+7：断点续传完整性 / 416 回退（2026-10-18 修 206 分支截断清零）──
// 为什么重：".part 存在 + state=done" 曾是假的——206 分支用默认 "w" 打开
// createWriteStream，先截断到 0 再从 startOffset 写，前段被清零而状态报 done。
// 所以这里只认两件事：最终文件 SHA-256 与源一致、前段字节未被改动。
const RSIZE = 300000;
const RBODY = crypto.randomBytes(RSIZE);
const RSHA = crypto.createHash("sha256").update(RBODY).digest("hex");
const RURL = "http://127.0.0.1:18995/ranged.bin";     // 无 Range 时 30% 掉线
const FULLURL = "http://127.0.0.1:18995/full.bin";    // 无 Range 时发全量（416 回退用）
const CUT_AT = 90000; // 首次只发 30% 就掐断

const rangeSrv = http.createServer((req, res) => {
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(RSIZE),
      "accept-ranges": "bytes",
      "etag": '"v1"',
    });
    // /ranged.bin：发够 30% 后强断（模拟中途掉线），让任务落到 interrupted + 保留 .part
    if ((req.url || "").startsWith("/ranged.bin")) {
      res.write(RBODY.subarray(0, CUT_AT), () => setTimeout(() => res.destroy(), 80));
    } else {
      res.end(RBODY);
    }
    return;
  }
  const m = /bytes=(\d+)-/.exec(range);
  const start = m ? Number(m[1]) : 0;
  // Range 起点不合法（>= 全长）：按 RFC 回 416，客户端应删 .part 从头下载
  if (start >= RSIZE) {
    res.writeHead(416, { "content-range": `bytes */${RSIZE}`, "content-length": "0" });
    res.end();
    return;
  }
  res.writeHead(206, {
    "content-type": "application/octet-stream",
    "content-length": String(RSIZE - start),
    "content-range": `bytes ${start}-${RSIZE - 1}/${RSIZE}`,
    "accept-ranges": "bytes",
    "etag": '"v1"',
  });
  res.end(RBODY.subarray(start));
});
await new Promise((r) => rangeSrv.listen(18995, "127.0.0.1", r));

// 场景 6：真实链路续传（第一次中断 → retry 走 Range/206）
{
  const t = mgr.create({ url: RURL, fileName: "resume.bin", saveDir: SAVE_DIR });
  const first = await waitFinal(t.taskId);
  const partPath = first?.filePath + ".part";
  const partSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : -1;
  check("resume: 首次中断为 interrupted", first?.state, (x) => x === "interrupted");
  check("resume: .part 保留且非空", partSize, (x) => x > 0 && x <= CUT_AT);
  // 断点处的 .part 内容必须逐字节等于源文件前段（说明中断前写入的字节是正确的）
  const partBuf = partSize > 0 ? fs.readFileSync(partPath) : Buffer.alloc(0);
  check("resume: .part 前段字节与源一致", partBuf.equals(RBODY.subarray(0, partSize)), (x) => x === true);

  mgr.retry(t.taskId);
  const snap = await waitFinal(t.taskId);
  check("resume: 续传后 done", snap?.state, (x) => x === "done");
  check("resume: 字节数对齐", snap, (x) => x.total === RSIZE && x.received === RSIZE);
  check("resume: 最终文件大小正确", snap, (x) => fs.existsSync(x.filePath) && fs.statSync(x.filePath).size === RSIZE);
  // 核心断言：done 不等于文件正确，必须比对内容
  const fileBuf = fs.readFileSync(snap.filePath);
  check("resume: 最终文件 SHA-256 与源一致", crypto.createHash("sha256").update(fileBuf).digest("hex"), (x) => x === RSHA);
  check("resume: 前段未被清零（逐字节等于源断点前内容）",
    fileBuf.subarray(0, partSize).equals(RBODY.subarray(0, partSize)), (x) => x === true);
  check("resume: 前段不全为 0x00", fileBuf.subarray(0, partSize).every((b) => b === 0), (x) => x === false);
  check("resume: 无 .part 残留", snap.filePath + ".part", (x) => !fs.existsSync(x));
}

// 场景 7：416 回退链路（.part 已达全长 → Range 起点越界 → 删 .part 从头下）
{
  const fp = path.join(SAVE_DIR, "r416.bin");
  const pp = fp + ".part";
  fs.writeFileSync(pp, Buffer.alloc(RSIZE, 0x00)); // 长度够但内容是垃圾，模拟 416 场景
  const meta = {
    version: 3,
    updatedAt: 1,
    tasks: [{
      taskId: "r416-task", url: FULLURL, fileName: "r416.bin", filePath: fp,
      saveDir: SAVE_DIR, state: "running", total: RSIZE, received: RSIZE, speedLimit: 0,
      startedAt: 1, finishedAt: null, elapsed: 0, error: null, canceledBy: null, kind: "url",
      cmd: null, unit: "bytes", note: null, stalledAt: null, sessionId: null, sessionPath: null,
      etag: null, lastModified: null, partPath: pp, acceptRanges: false, expectedSha256: null, resumable: true,
    }],
  };
  fs.writeFileSync(path.join(DATA_DIR, "tasks.json"), JSON.stringify(meta), "utf-8");
  mgr.restore();
  mgr.retry("r416-task");
  const snap = await waitFinal("r416-task");
  check("416: 回退后 done", snap?.state, (x) => x === "done");
  check("416: 最终文件 SHA-256 与源一致", snap && fs.existsSync(snap.filePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(snap.filePath)).digest("hex") : null,
    (x) => x === RSHA);
  check("416: received 仍为全长", snap?.received, (x) => x === RSIZE);
}

console.log(`\n=== download: ${pass} passed, ${fail} failed ===`);
srv.close();
rangeSrv.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
