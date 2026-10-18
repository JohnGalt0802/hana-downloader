// tests/unit-restore-aria2.mjs — 引擎重启后，还在跑的 aria2 任务不该被误判成失败
//
// 为什么要有它（2026-10-19）：aria2c 是引擎 spawn 的**独立进程**，引擎被硬杀（崩溃 / App reload /
// 宿主重启）时它不会跟着死，还在继续往同一个 `.part` 写。但 restore() 用的是老语义
// 「引擎重启 = 任务被打断」，于是把 aria2 任务标成 interrupted 并补写终态：
// 用户看到「下载失败」，而文件其实还在下、最后会下完，只是没人记录。
// 一个跑了两小时的大文件，因为 App 重启就显示失败，是明确的误报。
//
// 三个场景（都用**真实子进程**当引擎 + **真实 aria2c**，硬杀子进程后 aria2 继续活着）：
//   A. 实例还活着、任务还在下 → 恢复后不是 interrupted/failed，且能跟到 done
//   B. 实例已经没了           → 仍标 interrupted（保持现有语义）
//   C. 实例还活着但任务已下完 → 恢复后能正确收尾（交付文件、算摘要、写终态）
//
// 为什么必须用子进程：同进程里重建 TaskManager 时 aria2 backend 的模块态还在，
// 握不到「上一个引擎进程留下的实例」这条真实路径。子进程被 TerminateProcess 干掉时
// 它的 exit 钩子不会跑，aria2c 才真的会被留成孤儿——这正是要模拟的现场。
//
// 隔离：端口向系统要（listen(0) / 扫空闲段），临时目录 mkdtempSync，可并行跑。
// 没装 aria2 则整体 skip（不算失败）。
//
// 用法（仓库根目录）：node tests/unit-restore-aria2.mjs
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getTaskManager, _resetTaskManager } from "../engine/dlcore.js";
import { resolveAria2Bin } from "../engine/backends/aria2.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOLD_ENGINE = path.join(here, "tools", "aria2-hold-engine.mjs");

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP_DIRS = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
};
const CHILDREN = new Set();
process.on("exit", () => {
  for (const c of CHILDREN) { try { c.kill(); } catch { /* 已退出 */ } }
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

const ARIA2_BIN = process.env.HD_TEST_NO_ARIA2 ? "" : resolveAria2Bin("");
if (!ARIA2_BIN) {
  console.log("\n跳过（未检测到 aria2c）");
  console.log(`\n=== restore-aria2: ${pass} passed, ${fail} failed（已跳过）===`);
  process.exit(0);
}

// ── 本进程独占的 aria2 端口段（portCandidates 从基端口往后连试 8 个）──
const pickBasePort = async () => {
  const isFree = (p) => new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
  });
  for (let base = 20000 + (process.pid % 200) * 8; base < 60000; base += 8) {
    let ok = true;
    for (let i = 0; i < 8 && ok; i++) ok = await isFree(base + i);
    if (ok) return base;
  }
  return 0;
};

// ── 本地 HTTP 源（支持 Range；多连接下载必需）──
function makeSource({ size, chunk, delayMs }) {
  const body = crypto.randomBytes(size);
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const srv = http.createServer((req, res) => {
    const range = req.headers.range;
    let start = 0, end = size - 1;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (!m) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); res.end(); return; }
    }
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    let off = start;
    const tick = () => {
      if (off > end || res.destroyed) return res.end();
      const n = Math.min(chunk, end - off + 1);
      res.write(body.subarray(off, off + n));
      off += n;
      setTimeout(tick, delayMs);
    };
    tick();
  });
  return { srv, body, sha };
}

// ── 直接对 aria2 发 RPC（测试要自己确认「实例还活着 / 任务还在」这一前提）──
async function rpc(port, secret, method, params = []) {
  const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params: secret ? [`token:${secret}`, ...params] : params }),
    signal: AbortSignal.timeout(4000),
  });
  const json = JSON.parse(await res.text());
  if (json?.error) throw Object.assign(new Error(json.error.message), { rpcCode: json.error.code });
  return json?.result;
}

const readRecord = (dataDir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, "aria2-instance.json"), "utf-8")); } catch { return null; }
};
const pidAlive = (pid) => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};

/** 在实例的活动/等待/已完成队列里按 .part 路径找 gid */
async function findGid(port, secret, partPath) {
  const want = path.resolve(partPath).toLowerCase();
  const norm = (p) => path.resolve(p).toLowerCase();
  const queries = [
    ["aria2.tellActive", [["gid", "status", "files"]]],
    ["aria2.tellWaiting", [0, 1000, ["gid", "status", "files"]]],
    ["aria2.tellStopped", [0, 1000, ["gid", "status", "files"]]],
  ];
  for (const [m, p] of queries) {
    let list;
    try { list = await rpc(port, secret, m, p); } catch { continue; }
    for (const it of Array.isArray(list) ? list : []) {
      const files = Array.isArray(it?.files) ? it.files : [];
      if (files.some((f) => f?.path && norm(f.path) === want)) return it.gid || null;
    }
  }
  return null;
}

async function waitGid(port, secret, partPath, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const gid = await findGid(port, secret, partPath);
    if (gid) return gid;
    await sleep(150);
  }
  return null;
}

async function waitStatus(port, secret, gid, want, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const st = await rpc(port, secret, "aria2.tellStatus", [gid, ["gid", "status", "completedLength", "totalLength"]]);
      if (st?.status === want) return st;
    } catch { /* 还在队列切换中 */ }
    await sleep(120);
  }
  return null;
}

/** 关掉一个我们不持有 handle 的实例：优先 RPC shutdown，失败才按确切 pid 收（绝不按名字杀） */
async function stopInstance(rec) {
  if (!rec) return;
  if (rec.port && rec.secret) {
    try { await rpc(rec.port, rec.secret, "aria2.shutdown"); } catch { /* 已走 */ }
  }
  for (let i = 0; i < 60 && pidAlive(rec.pid); i++) await sleep(100);
  if (pidAlive(rec.pid)) { try { process.kill(rec.pid); } catch { /* 忽略 */ } }
}

/** 起一个「引擎」子进程，等它把任务提交给 aria2，然后硬杀（TerminateProcess，不留 exit 钩子） */
async function startEngineAndKill({ dataDir, url, fileName, saveDir, basePort }) {
  const child = spawn(process.execPath, [
    HOLD_ENGINE, dataDir, url, fileName, saveDir, ARIA2_BIN, String(basePort),
  ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  CHILDREN.add(child);
  let out = "";
  let errOut = "";
  child.stdout.on("data", (c) => { out += String(c); });
  child.stderr.on("data", (c) => { errOut += String(c); });
  let taskId = null;
  for (let i = 0; i < 200 && !taskId; i++) {
    await sleep(50);
    const m = /TASK (\S+)/.exec(out);
    if (m) taskId = m[1];
  }
  if (!taskId) throw new Error(`引擎子进程没给出 taskId（stderr: ${errOut.slice(0, 300)}）`);
  // 实例记录在 aria2 真的起来之后才写（capabilities → ensureInstance → writeRecord），
  // 而 TASK 是 create 时立刻打的，所以要等——这里等的是「实例已就绪」这个前提。
  let rec = null;
  for (let i = 0; i < 600 && !rec; i++) {
    await sleep(100);
    rec = readRecord(dataDir);
    if (!rec && child.exitCode !== null) break;
  }
  if (!rec) throw new Error(`引擎子进程没写出实例记录（stderr: ${errOut.slice(0, 300)}）`);
  const partPath = path.join(saveDir, fileName) + ".part";
  const gid = await waitGid(rec.port, rec.secret, partPath);
  if (!gid) throw new Error("aria2 里找不到这条任务的 gid（前提不成立）");
  // 硬杀：TerminateProcess，process.once("exit") 不会跑，aria2c 因此被留成孤儿
  try { child.kill(); } catch { /* 已退出 */ }
  for (let i = 0; i < 60 && child.exitCode === null; i++) await sleep(50);
  CHILDREN.delete(child);
  return { taskId, rec, partPath, gid, childDead: child.exitCode !== null || child.signalCode != null };
}

function freshManager(dataDir) {
  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
  const mgr = getTaskManager(dataDir);
  // 生产里终态文件是 server.js 的 onFinal 落的（finished/<taskId>.json）。
  // 测试直接跑 TaskManager，所以这里补上同一条落盘通道——否则「有没有写终态」无从断言。
  mgr.onFinal((t) => {
    try {
      fs.mkdirSync(path.join(dataDir, "finished"), { recursive: true });
      fs.writeFileSync(path.join(dataDir, "finished", `${t.taskId}.json`),
        JSON.stringify({ taskId: t.taskId, state: t.state, error: t.error || null, received: t.received, total: t.total, finishedAt: t.finishedAt }), "utf-8");
    } catch { /* 忽略 */ }
  });
  return mgr;
}

async function waitFinal(mgr, taskId, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = mgr.snapshot(taskId);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
    await sleep(100);
  }
  return mgr.snapshot(taskId);
}

const readFinished = (dataDir, taskId) => {
  const p = path.join(dataDir, "finished", `${taskId}.json`);
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
};

// 终态落盘发生在 _run 的 finally（snapshot 先变终态，回调随后）——等它一拍，别把时序当成缺陷
const waitFinished = async (dataDir, taskId, timeoutMs = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = readFinished(dataDir, taskId);
    if (f) return f;
    await sleep(100);
  }
  return null;
};

const shaOf = (p) => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return null; }
};

// ════════════════════════════════════════════════════════════════
// 场景 A：实例还活着、任务还在下 → 恢复成运行态，跟到 done
// ════════════════════════════════════════════════════════════════
{
  const BASE = tmpDir("hd-restore-aria2-a-");
  const DATA = path.join(BASE, "data");
  const OUT = path.join(BASE, "out");
  const basePort = await pickBasePort();
  const SRC_SIZE = 16 * 1024 * 1024;
  const src = makeSource({ size: SRC_SIZE, chunk: 32 * 1024, delayMs: 100 });
  await new Promise((r) => src.srv.listen(0, "127.0.0.1", r));
  const SRC_PORT = src.srv.address().port;

  let run = null;
  try {
    run = await startEngineAndKill({
      dataDir: DATA, url: `http://127.0.0.1:${SRC_PORT}/big.bin`,
      fileName: "case-a.bin", saveDir: OUT, basePort,
    });
    const { taskId, rec, partPath, gid } = run;

    // ── 前提：引擎已死，但 aria2 还活着、还在下（否则这个测试没有意义）──
    check("A 前提: 引擎子进程已硬杀", run.childDead, (x) => x === true);
    check("A 前提: aria2 实例进程仍存活", pidAlive(rec.pid), (x) => x === true);
    const ver = await rpc(rec.port, rec.secret, "aria2.getVersion").catch(() => null);
    check("A 前提: 实例 RPC 握手仍通", typeof ver?.version, (x) => x === "string");
    const st0 = await rpc(rec.port, rec.secret, "aria2.tellStatus", [gid, ["status", "completedLength"]]).catch(() => null);
    check("A 前提: 任务在实例里仍是 active", st0?.status, (x) => x === "active");
    check("A 前提: 正式文件尚未交付（引擎没来得及收尾）", fs.existsSync(path.join(OUT, "case-a.bin")), (x) => x === false);

    // ── 模拟引擎重启 ──
    const mgr = freshManager(DATA);
    mgr.restore();
    await mgr.whenRestored();

    const s1 = mgr.snapshot(taskId);
    check("A: 恢复后不是 interrupted", s1?.state, (x) => x !== "interrupted");
    check("A: 恢复后不是 failed", s1?.state, (x) => x !== "failed");
    check("A: 恢复成运行态", s1?.state, (x) => x === "running");
    check("A: 没有补写失败终态", readFinished(DATA, taskId), (x) => x === null);
    check("A: 归属仍是 aria2（.part 正被它写）", s1?.backend, (x) => x === "aria2");
    // 进度只能来自 RPC 的 completedLength：等它跟上一拍，再断言「不是 .part 大小」。
    // （.part 在 aria2 下是多段稀疏，st_size 只是最远分片写到的偏移，可能一上来就接近全长）
    let s2 = s1;
    for (let i = 0; i < 100; i++) {
      s2 = mgr.snapshot(taskId);
      if (s2?.received > 0) break;
      await sleep(100);
    }
    check("A: 恢复后进度来自 RPC（received > 0）", s2?.received, (x) => typeof x === "number" && x > 0);
    check("A: 进度不超过 total（没拿 .part 大小兑现）", s2, (x) => x.total > 0 && x.received <= x.total);

    // ── 继续跟踪到收尾 ──
    const done = await waitFinal(mgr, taskId, 90000);
    check("A: 最终 done", done?.state, (x) => x === "done");
    check("A: 文件 SHA-256 与源一致", shaOf(done?.filePath || ""), (x) => x === src.sha);
    check("A: 无 .part 残留", done?.filePath + ".part", (x) => !fs.existsSync(x));
    check("A: 字节数对齐", done, (x) => x.received === x.total && x.total === SRC_SIZE);
    const fin = await waitFinished(DATA, taskId);
    check("A: 收尾写了 done 终态（不是 interrupted）", fin?.state, (x) => x === "done");
  } catch (e) {
    fail++; console.log("FAIL: A 用例异常 =>", String(e?.message || e));
  } finally {
    if (run) await stopInstance(readRecord(DATA) || run.rec);
    src.srv.close();
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ════════════════════════════════════════════════════════════════
// 场景 B：实例已经没了 → 保持现有语义（interrupted + 补写终态）
// ════════════════════════════════════════════════════════════════
{
  const BASE = tmpDir("hd-restore-aria2-b-");
  const DATA = path.join(BASE, "data");
  const OUT = path.join(BASE, "out");
  const basePort = await pickBasePort();
  const src = makeSource({ size: 8 * 1024 * 1024, chunk: 100 * 1024, delayMs: 30 });
  await new Promise((r) => src.srv.listen(0, "127.0.0.1", r));
  const SRC_PORT = src.srv.address().port;

  let run = null;
  try {
    run = await startEngineAndKill({
      dataDir: DATA, url: `http://127.0.0.1:${SRC_PORT}/big.bin`,
      fileName: "case-b.bin", saveDir: OUT, basePort,
    });
    const { taskId, rec } = run;
    // 把实例也关掉：这就是「引擎崩了，aria2 也没了」的现场
    await stopInstance(rec);
    check("B 前提: aria2 实例已不在", pidAlive(rec.pid), (x) => x === false);
    check("B 前提: 正式文件未交付", fs.existsSync(path.join(OUT, "case-b.bin")), (x) => x === false);

    const mgr = freshManager(DATA);
    mgr.restore();
    await mgr.whenRestored();

    const s = mgr.snapshot(taskId);
    check("B: 仍标 interrupted（现有语义不变）", s?.state, (x) => x === "interrupted");
    const fin = readFinished(DATA, taskId);
    check("B: 仍补写 interrupted 终态", fin?.state, (x) => x === "interrupted");
    check("B: 终态说明是应用重启", fin?.error, (x) => typeof x === "string" && x.includes("应用重启"));
    check("B: 没有误报 done", s?.state, (x) => x !== "done");
  } catch (e) {
    fail++; console.log("FAIL: B 用例异常 =>", String(e?.message || e));
  } finally {
    if (run) await stopInstance(readRecord(DATA) || run.rec);
    src.srv.close();
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// ════════════════════════════════════════════════════════════════
// 场景 C：实例还活着，但任务在引擎死期间已经下完 → 恢复后正确收尾
// ════════════════════════════════════════════════════════════════
{
  const BASE = tmpDir("hd-restore-aria2-c-");
  const DATA = path.join(BASE, "data");
  const OUT = path.join(BASE, "out");
  const basePort = await pickBasePort();
  const SIZE = 3 * 1024 * 1024;
  const src = makeSource({ size: SIZE, chunk: 100 * 1024, delayMs: 40 });
  await new Promise((r) => src.srv.listen(0, "127.0.0.1", r));
  const SRC_PORT = src.srv.address().port;

  let run = null;
  try {
    run = await startEngineAndKill({
      dataDir: DATA, url: `http://127.0.0.1:${SRC_PORT}/small.bin`,
      fileName: "case-c.bin", saveDir: OUT, basePort,
    });
    const { taskId, rec, gid } = run;
    // 等 aria2 自己下完（引擎已死，没人收尾）
    const st = await waitStatus(rec.port, rec.secret, gid, "complete", 40000);
    check("C 前提: 引擎死后 aria2 自己下完了", st?.status, (x) => x === "complete");
    check("C 前提: 引擎没来得及交付（正式文件不存在）", fs.existsSync(path.join(OUT, "case-c.bin")), (x) => x === false);
    check("C 前提: .part 已在盘上", fs.existsSync(path.join(OUT, "case-c.bin.part")), (x) => x === true);

    const mgr = freshManager(DATA);
    mgr.restore();
    await mgr.whenRestored();

    // 收尾是异步跑的（交付 + 算摘要 + 写终态），等它落地
    const done = await waitFinal(mgr, taskId, 60000);
    check("C: 恢复后正确收尾为 done（不卡在半路）", done?.state, (x) => x === "done");
    check("C: 交付的文件 SHA-256 与源一致", shaOf(done?.filePath || ""), (x) => x === src.sha);
    check("C: 文件大小正确", done?.filePath && fs.existsSync(done.filePath) ? fs.statSync(done.filePath).size : -1,
      (x) => x === SIZE);
    check("C: 无 .part 残留", path.join(OUT, "case-c.bin.part"), (x) => !fs.existsSync(x));
    check("C: 摘要与终态都写了（state=done）", (await waitFinished(DATA, taskId))?.state, (x) => x === "done");
  } catch (e) {
    fail++; console.log("FAIL: C 用例异常 =>", String(e?.message || e));
  } finally {
    if (run) await stopInstance(readRecord(DATA) || run.rec);
    src.srv.close();
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

console.log(`\n=== restore-aria2: ${pass} passed, ${fail} failed ===`);
_resetTaskManager();
delete globalThis.__dlTaskMgr;
process.exit(fail ? 1 : 0);
