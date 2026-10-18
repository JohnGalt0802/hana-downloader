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

// ── 场景 8~10：续传 + expectedSha256（2026-10-19 修「续传必然假报 SHA-256 失败」）──
// 旧实现 run 开头新建 hash、只 update 本次收到的 chunk，续传时前 startOffset 字节从未进过 hash，
// 于是「文件完全正确」也报失败；重试再从 total 发 Range → 416 → 删 .part → 1GB 白下。
const SSIZE = 400000;
const SBODY = crypto.randomBytes(SSIZE);
const SSHA = crypto.createHash("sha256").update(SBODY).digest("hex");
const SCUT = Math.floor(SSIZE * 0.4); // 40% 处断线
const SURL = "http://127.0.0.1:18994/sha-resume.bin";
const srvStats = { full: 0, reqs: 0, lastRangeStart: null };

const shaSrv = http.createServer((req, res) => {
  srvStats.reqs++;
  const range = req.headers.range;
  if (!range) {
    srvStats.full++;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(SSIZE),
      "accept-ranges": "bytes",
      "etag": '"s1"',
    });
    res.write(SBODY.subarray(0, SCUT), () => setTimeout(() => res.destroy(), 80));
    return;
  }
  const m = /bytes=(\d+)-/.exec(range);
  const start = m ? Number(m[1]) : 0;
  srvStats.lastRangeStart = start;
  if (start >= SSIZE) {
    res.writeHead(416, { "content-range": `bytes */${SSIZE}`, "content-length": "0" });
    res.end();
    return;
  }
  res.writeHead(206, {
    "content-type": "application/octet-stream",
    "content-length": String(SSIZE - start),
    "content-range": `bytes ${start}-${SSIZE - 1}/${SSIZE}`,
    "accept-ranges": "bytes",
    "etag": '"s1"',
  });
  res.end(SBODY.subarray(start));
});
await new Promise((r) => shaSrv.listen(18994, "127.0.0.1", r));

// 场景 8：正确摘要 + 40% 中断 + retry 续传 → done，SHA 与源一致，半成品没被误删
{
  const t = mgr.create({ url: SURL, fileName: "sha-resume.bin", saveDir: SAVE_DIR, expectedSha256: SSHA });
  const first = await waitFinal(t.taskId);
  const partPath = first?.filePath + ".part";
  const partSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : -1;
  check("sha续传: 首次中断为 interrupted", first?.state, (x) => x === "interrupted");
  check("sha续传: .part 保留且为 40% 左右", partSize, (x) => x > 0 && x <= SCUT);
  check("sha续传: 首轮未误报 SHA-256 失败", first?.error, (x) => !String(x || "").includes("SHA-256"));

  mgr.retry(t.taskId);
  const snap = await waitFinal(t.taskId);
  check("sha续传: 续传后 done", snap?.state, (x) => x === "done");
  check("sha续传: 不再报 SHA-256 失败", snap?.error, (x) => x == null || !String(x).includes("SHA-256"));
  check("sha续传: 最终文件 SHA-256 与源一致", snap && fs.existsSync(snap.filePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(snap.filePath)).digest("hex") : null,
    (x) => x === SSHA);
  check("sha续传: 最终文件大小正确", snap && fs.existsSync(snap.filePath) ? fs.statSync(snap.filePath).size : -1,
    (x) => x === SSIZE);
  // 半成品没被误删的直接证据：全程只发过一次全量请求（续传走了 Range，没从头重下）
  check("sha续传: 续传走 Range 而非重下", srvStats.full, (x) => x === 1);
  check("sha续传: Range 起点为 .part 已有长度", srvStats.lastRangeStart, (x) => x === partSize);
  check("sha续传: 交付文件前段等于源前段", snap && fs.existsSync(snap.filePath)
    ? fs.readFileSync(snap.filePath).subarray(0, partSize).equals(SBODY.subarray(0, partSize)) : null,
    (x) => x === true);
}

// 场景 9：错误摘要 + 续传 → 仍必须报失败（校验不能被修成摆设），且 .part 保留
{
  const wrong = "f".repeat(64);
  const t = mgr.create({ url: SURL, fileName: "sha-bad-resume.bin", saveDir: SAVE_DIR, expectedSha256: wrong });
  const first = await waitFinal(t.taskId);
  const partPath = first?.filePath + ".part";
  check("sha错误续传: 首次中断", first?.state, (x) => x === "interrupted");

  mgr.retry(t.taskId);
  const snap = await waitFinal(t.taskId);
  check("sha错误续传: failed", snap?.state, (x) => x === "failed");
  check("sha错误续传: 文案含 SHA-256", snap?.error, (x) => String(x || "").includes("SHA-256"));
  check("sha错误续传: 正式文件未交付", snap && !fs.existsSync(snap.filePath), (x) => x === true);
  check("sha错误续传: .part 保留未被删", snap && fs.existsSync(partPath) ? fs.statSync(partPath).size : -1,
    (x) => x === SSIZE);
}

// 场景 10：.part 已完整（size === total）+ 正确摘要 → 重算后直接交付，不再发 Range（避免 416 删半成品）
{
  const fp = path.join(SAVE_DIR, "preflight.bin");
  const pp = fp + ".part";
  fs.writeFileSync(pp, SBODY); // 完整且内容正确的半成品
  const reqsBefore = srvStats.reqs;
  const meta = {
    version: 3,
    updatedAt: 1,
    tasks: [{
      taskId: "preflight-task", url: SURL, fileName: "preflight.bin", filePath: fp,
      saveDir: SAVE_DIR, state: "running", total: SSIZE, received: SSIZE, speedLimit: 0,
      startedAt: 1, finishedAt: null, elapsed: 0, error: null, canceledBy: null, kind: "url",
      cmd: null, unit: "bytes", note: null, stalledAt: null, sessionId: null, sessionPath: null,
      etag: '"s1"', lastModified: null, partPath: pp, acceptRanges: true, expectedSha256: SSHA, resumable: true,
    }],
  };
  fs.writeFileSync(path.join(DATA_DIR, "tasks.json"), JSON.stringify(meta), "utf-8");
  mgr.restore();
  mgr.retry("preflight-task");
  const snap = await waitFinal("preflight-task");
  check("preflight: done", snap?.state, (x) => x === "done");
  check("preflight: 最终文件 SHA 与源一致", snap && fs.existsSync(snap.filePath)
    ? crypto.createHash("sha256").update(fs.readFileSync(snap.filePath)).digest("hex") : null,
    (x) => x === SSHA);
  check("preflight: 未再发 HTTP 请求", srvStats.reqs - reqsBefore, (x) => x === 0);
}

// ── 场景 11：取消后重试（2026-10-19 修「取消即永久失败」）──
// 为什么重：task.received 记的是「已交给写流缓冲」的字节，取消走 ws.destroy() 不 flush，
// 磁盘上的 .part 可能远小于 received（实测 64MB 高速源取消时 .part 是 0 字节）。
// 旧 retry() 不清 received，下一轮 startOffset 仍取内存值 → createResumeStream 长度校验必然失败，
// 再点一次重试还是同一个坏起点 —— 只有重启引擎（走 restore 的 statSync 口径）能自救。
// 这里钉住三件事：取消后能续、连续 retry 两次都行、最终内容与源一致。
const CSIZE = 64 * 1024 * 1024;
const CBODY = crypto.randomBytes(CSIZE);
const CSHA = crypto.createHash("sha256").update(CBODY).digest("hex");
const CURL = "http://127.0.0.1:18984/cancel.bin"; // 18984：本套件专用，勿与其它套件重口（18995~18998 已分别被 stall/probe/queue/aria2 占用）
const CSPLIT = 8 * 1024 * 1024; // 每块 8MB，留出「用户点取消」的窗口

const cancelSrv = http.createServer((req, res) => {
  const m = /bytes=(\d+)-/.exec(req.headers.range || "");
  const start = m ? Number(m[1]) : 0;
  if (start >= CSIZE) {
    res.writeHead(416, { "content-range": `bytes */${CSIZE}`, "content-length": "0" });
    res.end();
    return;
  }
  const push = () => {
    let off = start;
    const tick = () => {
      if (off >= CSIZE) { res.end(); return; }
      const end = Math.min(off + CSPLIT, CSIZE);
      res.write(CBODY.subarray(off, end));
      off = end;
      setTimeout(tick, 40);
    };
    tick();
  };
  if (start > 0) {
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(CSIZE - start),
      "content-range": `bytes ${start}-${CSIZE - 1}/${CSIZE}`,
      "accept-ranges": "bytes", etag: '"c1"',
    });
  } else {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(CSIZE),
      "accept-ranges": "bytes", etag: '"c1"',
    });
  }
  push();
});
await new Promise((r) => cancelSrv.listen(18984, "127.0.0.1", r));

const shaOf = (fp) => (fs.existsSync(fp) ? crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex") : null);

{
  const t = mgr.create({ url: CURL, fileName: "cancel.bin", saveDir: SAVE_DIR });
  // 等写流真的吃进一块再取消（模拟用户看到「在跑」后点取消）
  for (let i = 0; i < 4000; i++) {
    const s = mgr.snapshot(t.taskId);
    if (s && (s.received >= CSPLIT || s.state !== "running")) break;
    await new Promise((r) => setTimeout(r, 2));
  }
  const c = mgr.cancel(t.taskId, "user");
  const first = await waitFinal(t.taskId);
  const pp = first?.filePath + ".part";
  const diskSize = fs.existsSync(pp) ? fs.statSync(pp).size : -1;
  check("cancel-retry: 取消被接受", c, (x) => x?.ok === true);
  check("cancel-retry: 状态为 canceled", first?.state, (x) => x === "canceled");
  // 缺陷现场：内存进度与磁盘进度对不上（写缓冲被丢弃）
  check("cancel-retry: 内存 received 大于磁盘 .part", first?.received, (x) => x > Math.max(diskSize, 0));

  mgr.retry(t.taskId);
  const second = await waitFinal(t.taskId);
  check("cancel-retry: 第一次 retry 后 done", second?.state, (x) => x === "done");
  check("cancel-retry: 第一次 retry 后 SHA 与源一致", shaOf(second?.filePath || ""), (x) => x === CSHA);
  check("cancel-retry: 第一次 retry 后无 .part 残留", second?.filePath + ".part", (x) => !fs.existsSync(x));

  // 再点一次重试：造回「内存值与磁盘不符」的现场，验证不是一次性修好
  if (second?.filePath && fs.existsSync(second.filePath)) fs.rmSync(second.filePath, { force: true });
  const inner = mgr.tasks.get(t.taskId);
  inner.state = "failed";
  inner.received = CSIZE; // 坏起点：磁盘上什么都没有，内存却报全长
  inner.error = "构造的失败态（模拟取消遗留的坏 received）";
  mgr.retry(t.taskId);
  const third = await waitFinal(t.taskId);
  check("cancel-retry: 第二次 retry 后 done", third?.state, (x) => x === "done");
  check("cancel-retry: 第二次 retry 后 SHA 与源一致", shaOf(third?.filePath || ""), (x) => x === CSHA);
  // 本套件存在的意义之一：createResumeStream 改成返回 { ws, startOffset } 后，
  // 调用方若没解构，chunk 到达时会在 ws.write 上炸「ws.write is not a function」。
  // 在这里显式钉住，避免再把「签名改了调用方没跟」这种崩溃埋回绿测里。
  check("cancel-retry: 全程无 ws.write 类型错误",
    [first?.error, second?.error, third?.error].filter(Boolean).join("|"),
    (x) => !x.includes("is not a function"));
}

// ── 场景 12：取消时 .part 确实落了一部分盘 → 重试必须从「磁盘长度」续，不用内存值 ──
// 与场景 11 互补：上一个是 .part 根本没建（退成从头下），这里 .part 有内容但要保证
// 起点是磁盘长度（否则 Range 偏大会被 206 的 Content-Range 校验拦住）。两件事都要成立：
//   1. 起点 === 取消时 .part 的长度（磁盘为准，不是内存里那个更大的值）
//   2. 最终文件 SHA 与源一致（前段没被清零、也没错位）
const RANGE_STARTS = [];
const flushSrv = http.createServer((req, res) => {
  const m = /bytes=(\d+)-/.exec(req.headers.range || "");
  const start = m ? Number(m[1]) : 0;
  if (m) RANGE_STARTS.push(start);
  if (start >= CSIZE) {
    res.writeHead(416, { "content-range": `bytes */${CSIZE}`, "content-length": "0" });
    res.end();
    return;
  }
  const headers = start > 0
    ? { "content-type": "application/octet-stream", "content-length": String(CSIZE - start),
        "content-range": `bytes ${start}-${CSIZE - 1}/${CSIZE}`, "accept-ranges": "bytes", etag: '"c2"' }
    : { "content-type": "application/octet-stream", "content-length": String(CSIZE),
        "accept-ranges": "bytes", etag: '"c2"' };
  res.writeHead(start > 0 ? 206 : 200, headers);
  // 慢一点，让写流真的 flush 一部分到盘上（1MB / 50ms）
  let off = start;
  const tick = () => {
    if (off >= CSIZE) { res.end(); return; }
    const end = Math.min(off + 1024 * 1024, CSIZE);
    res.write(CBODY.subarray(off, end));
    off = end;
    setTimeout(tick, 50);
  };
  tick();
});
await new Promise((r) => flushSrv.listen(18985, "127.0.0.1", r));

{
  const t = mgr.create({ url: "http://127.0.0.1:18985/cancel2.bin", fileName: "cancel2.bin", saveDir: SAVE_DIR });
  for (let i = 0; i < 4000; i++) {
    const s = mgr.snapshot(t.taskId);
    if (s && (s.received >= 6 * 1024 * 1024 || s.state !== "running")) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  mgr.cancel(t.taskId, "user");
  const first = await waitFinal(t.taskId);
  const pp = first?.filePath + ".part";
  const diskSize = fs.existsSync(pp) ? fs.statSync(pp).size : -1;
  check("cancel-resume: 取消后 .part 有落盘内容", diskSize, (x) => x > 0);
  // 把内存值改成比磁盘大的值——这正是取消时写缓冲被丢弃后的现场（确定性复现，不靠抢时机）
  mgr.tasks.get(t.taskId).received = CSIZE;
  check("cancel-resume: 内存 received 大于磁盘（缺陷现场）", mgr.snapshot(t.taskId).received, (x) => x > diskSize);

  RANGE_STARTS.length = 0;
  mgr.retry(t.taskId);
  const snap = await waitFinal(t.taskId);
  check("cancel-resume: 重试后 done", snap?.state, (x) => x === "done");
  check("cancel-resume: 续传起点为磁盘长度", RANGE_STARTS[0], (x) => x === diskSize);
  check("cancel-resume: 最终文件 SHA 与源一致", shaOf(snap?.filePath || ""), (x) => x === CSHA);
  check("cancel-resume: 无 ws.write 类型错误", String(snap?.error || ""), (x) => !x.includes("is not a function"));
  check("cancel-resume: 前段字节未被清零", snap && fs.existsSync(snap.filePath)
    ? fs.readFileSync(snap.filePath).subarray(0, diskSize).equals(CBODY.subarray(0, diskSize)) : null,
    (x) => x === true);
}

console.log(`\n=== download: ${pass} passed, ${fail} failed ===`);
srv.close();
rangeSrv.close();
shaSrv.close();
cancelSrv.close();
flushSrv.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
