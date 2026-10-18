// tests/unit-backend-switch.mjs — 换后端不得拿旧 .part 续写（2026-10-19）
//
// 为什么要有它：这是静默数据损坏。用户用 aria2 下载，中途取消或引擎重启；
// 之后 aria2 开关关掉（或不可用降级），点重试 → 任务重新选路走 node-http。
// aria2 的 .part 是「多段稀疏写」，st_size 只是最远分片写到的偏移（file-allocation=none
// 时一上来就是全长），而 node-http 把它当「从 0 开始的连续前缀」——于是把洞当成已下载的
// 字节，交付一个带洞的文件，状态还报 done、界面绿勾。
// 实测（D:\HanakoWorks\_temp\aria2-switch-exp\exp.mjs）：9.8% 取消后重试，.part 已是 78.8% 长，
// 交付文件的零区与 .part 的洞逐字节重合，洞占比 75.84%，SHA 不符，state=done。
//
// 洞检测行不通（真实内容的零字节与空洞无法区分）。唯一可靠依据是「这个 .part 是谁写的」，
// 所以任务上记 partOwner，换后端就丢弃半成品、从头下。这个套件钉住四件事：
//   1. .part 归属 aria2（稀疏带洞）+ 走 node-http 重试 → 最终文件 SHA 与源一致（不是 done+坏文件）
//   2. 丢弃是「从头下」：received 归零、服务端收到的是无 Range 的全量请求
//   3. 归属一致时续传行为不变：Range 起点仍等于 .part 长度，前段不被重下
//   4. 归属缺失的老任务：有 .part.aria2 判为 aria2（丢弃），没有则判为 node-http（照旧续传）
//
// 隔离：端口 listen(0) 取系统分配，临时目录 mkdtempSync，可并行跑。不需要 aria2c 本体
// （第 1/2/4 条是「配置关闭 aria2 → 选路到 node-http」，走的是真实选路代码）。
//
// 用法（仓库根目录）：node tests/unit-backend-switch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

import { getTaskManager, _resetTaskManager } from "../engine/dlcore.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-switch-test-"));
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 源：随机字节（非零，洞才看得出来）、支持 Range、记录每次请求 ──
const SIZE = 2 * 1024 * 1024;
const BODY = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
const ETAG = '"sw1"';
const reqs = []; // { range, full }

const srv = http.createServer((req, res) => {
  const range = req.headers.range;
  let start = 0, end = SIZE - 1, status = 200;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(range).trim());
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), SIZE - 1);
      if (start >= SIZE) {
        res.writeHead(416, { "content-range": `bytes */${SIZE}`, "content-length": "0" });
        res.end();
        return;
      }
      status = 206;
    }
  }
  reqs.push({ range: range || null, full: !range });
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    etag: ETAG,
  };
  if (status === 206) headers["content-range"] = `bytes ${start}-${end}/${SIZE}`;
  res.writeHead(status, headers);
  res.end(BODY.subarray(start, end + 1));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${srv.address().port}/src.bin`;

const shaOf = (fp) => (fs.existsSync(fp) ? crypto.createHash("sha256").update(fs.readFileSync(fp)).digest("hex") : null);

function freshManager(name) {
  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
  const dataDir = path.join(BASE, name, "data");
  const saveDir = path.join(BASE, name, "out");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(saveDir, { recursive: true });
  return { mgr: getTaskManager(dataDir), dataDir, saveDir };
}

async function waitFinal(mgr, taskId, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const s = mgr.snapshot(taskId);
    if (s && s.state !== "running" && s.state !== "pending") return s;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待终态超时 state=${s?.state}`);
    await sleep(50);
  }
}

// 造一份「aria2 写的稀疏 .part」：文件长度是 aria2 已写到的位置（不等于进度），
// 真实内容只有前 prefix 字节，其余是洞（全零）。这正是 file-allocation=none + 多段写
// 留下的样子：st_size 是「最远分片写到的偏移」，既不是进度也不是全长。
function makeSparsePart(partPath, prefix, len) {
  const buf = Buffer.alloc(len, 0);
  BODY.copy(buf, 0, 0, Math.min(prefix, len));
  fs.writeFileSync(partPath, buf);
  return { size: len, realBytes: prefix, holeBytes: len - prefix };
}

function seedTask(dataDir, over) {
  const meta = { version: 3, updatedAt: 1, tasks: [over] };
  fs.writeFileSync(path.join(dataDir, "tasks.json"), JSON.stringify(meta), "utf-8");
}

const taskRec = (over) => ({
  taskId: "t1", url: URL_, fileName: "src.bin", filePath: null, saveDir: null,
  state: "interrupted", total: SIZE, received: 0, speedLimit: 0,
  startedAt: 1, finishedAt: 2, elapsed: 0, error: "已取消", canceledBy: null,
  kind: "url", cmd: null, unit: "bytes", note: null, stalledAt: null,
  sessionId: null, sessionPath: null, etag: ETAG, lastModified: null,
  partPath: null, acceptRanges: true, expectedSha256: null, resumable: true,
  backend: null, backendNote: null, partOwner: null,
  ...over,
});

// ── 场景 1+2：.part 归属 aria2（稀疏带洞）→ 重试走 node-http → 从头下、内容正确 ──
{
  const { mgr, dataDir, saveDir } = freshManager("s1");
  const fp = path.join(saveDir, "src.bin");
  const pp = fp + ".part";
  // 78.8% 长度、真实内容只有 9.8%（与实测现场同量级：
  // 3,276,800 / 26,443,776，洞占 75.84%）
  const sparse = makeSparsePart(pp, Math.floor(SIZE * 0.098), Math.floor(SIZE * 0.788));
  seedTask(dataDir, taskRec({
    filePath: fp, saveDir, partPath: pp,
    received: Math.floor(SIZE * 0.098),
    backend: "aria2", partOwner: "aria2",
  }));
  mgr.restore();
  check("切后端: restore 后仍是 interrupted", mgr.snapshot("t1")?.state, (x) => x === "interrupted");

  reqs.length = 0;
  const r = mgr.retry("t1");
  check("切后端: retry 被受理", r, (x) => x?.ok === true);
  const snap = await waitFinal(mgr, "t1");

  check("切后端: 最终 done", snap?.state, (x) => x === "done");
  // 核心断言：交付的是正确内容，不是「done + 坏文件」
  check("切后端: 最终文件 SHA-256 与源一致（不是带洞交付）", shaOf(snap?.filePath || ""), (x) => x === SHA);
  check("切后端: 最终文件大小正确", snap?.filePath && fs.existsSync(snap.filePath)
    ? fs.statSync(snap.filePath).size : -1, (x) => x === SIZE);
  // 证明是「从头下」而不是「接着稀疏文件往后写」
  check("切后端: 走了无 Range 的全量请求", reqs.some((x) => x.full), (x) => x === true);
  check("切后端: 没有从 78.8% 处发 Range（旧缺陷现场）", reqs.map((x) => x.range),
    (x) => !x.some((rg) => rg && /^bytes=(\d+)-/.test(rg) && Number(/^bytes=(\d+)-/.exec(rg)[1]) >= sparse.size * 0.7));
  check("切后端: 有可见说明（后端已切换，重新下载）", snap?.backendNote,
    (x) => typeof x === "string" && x.includes("后端已切换"));
  check("切后端: 无 .part 残留", snap?.filePath + ".part", (x) => !fs.existsSync(x));
}

// ── 场景 3：归属一致（node-http 的连续前缀）→ 续传行为不变 ──
{
  const { mgr, dataDir, saveDir } = freshManager("s3");
  const fp = path.join(saveDir, "src.bin");
  const pp = fp + ".part";
  const PREFIX = Math.floor(SIZE * 0.4);
  fs.writeFileSync(pp, BODY.subarray(0, PREFIX)); // 连续前缀，不是稀疏
  seedTask(dataDir, taskRec({
    filePath: fp, saveDir, partPath: pp, received: PREFIX,
    backend: "node-http", partOwner: "node-http",
  }));
  mgr.restore();

  reqs.length = 0;
  mgr.retry("t1");
  const snap = await waitFinal(mgr, "t1");

  check("同归属续传: 最终 done", snap?.state, (x) => x === "done");
  check("同归属续传: 文件 SHA 与源一致", shaOf(snap?.filePath || ""), (x) => x === SHA);
  check("同归属续传: 只发了一次请求（没从头重下）", reqs.length, (x) => x === 1);
  check("同归属续传: Range 起点等于 .part 已有长度", reqs[0]?.range, (x) => x === `bytes=${PREFIX}-`);
  check("同归属续传: 前段未被清零", snap?.filePath && fs.existsSync(snap.filePath)
    ? fs.readFileSync(snap.filePath).subarray(0, PREFIX).equals(BODY.subarray(0, PREFIX)) : null,
    (x) => x === true);
}

// ── 场景 4a：老任务无 partOwner，但有 .part.aria2 → 判为 aria2，换到 node-http 时丢弃 ──
{
  const { mgr, dataDir, saveDir } = freshManager("s4a");
  const fp = path.join(saveDir, "src.bin");
  const pp = fp + ".part";
  makeSparsePart(pp, Math.floor(SIZE * 0.1), Math.floor(SIZE * 0.7));
  fs.writeFileSync(pp + ".aria2", Buffer.alloc(64, 0x11)); // aria2 控制文件（稀疏写的铁证）
  seedTask(dataDir, taskRec({
    filePath: fp, saveDir, partPath: pp, received: Math.floor(SIZE * 0.1),
    backend: null, partOwner: null,
  }));
  mgr.restore();

  reqs.length = 0;
  mgr.retry("t1");
  const snap = await waitFinal(mgr, "t1");
  check("老任务(有.aria2): done", snap?.state, (x) => x === "done");
  check("老任务(有.aria2): 文件 SHA 与源一致", shaOf(snap?.filePath || ""), (x) => x === SHA);
  check("老任务(有.aria2): 从头下（无 Range 请求）", reqs.some((x) => x.full), (x) => x === true);
  check("老任务(有.aria2): 控制文件被清掉", pp + ".aria2", (x) => !fs.existsSync(x));
}

// ── 场景 4b：老任务无 partOwner、无 .part.aria2 → 判为 node-http，照旧续传 ──
{
  const { mgr, dataDir, saveDir } = freshManager("s4b");
  const fp = path.join(saveDir, "src.bin");
  const pp = fp + ".part";
  const PREFIX = Math.floor(SIZE * 0.3);
  fs.writeFileSync(pp, BODY.subarray(0, PREFIX));
  seedTask(dataDir, taskRec({
    filePath: fp, saveDir, partPath: pp, received: PREFIX,
    backend: null, partOwner: null,
  }));
  mgr.restore();

  reqs.length = 0;
  mgr.retry("t1");
  const snap = await waitFinal(mgr, "t1");
  check("老任务(无.aria2): done", snap?.state, (x) => x === "done");
  check("老任务(无.aria2): 文件 SHA 与源一致", shaOf(snap?.filePath || ""), (x) => x === SHA);
  check("老任务(无.aria2): 仍从 .part 长度续传（不丢老任务的续传能力）",
    reqs[0]?.range, (x) => x === `bytes=${PREFIX}-`);
}

// ── 场景 5：新任务的归属随实际 backend 落定，并持久化（重启后仍知道 .part 是谁写的）──
{
  const { mgr, dataDir, saveDir } = freshManager("s5");
  const t = mgr.create({ url: URL_, fileName: "fresh.bin", saveDir });
  const snap = await waitFinal(mgr, t.taskId);
  check("新任务: done", snap?.state, (x) => x === "done");
  check("新任务: 归属落定为 node-http", snap?.backend, (x) => x === "node-http");
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, "tasks.json"), "utf-8"));
  const rec = (meta.tasks || []).find((x) => x.taskId === t.taskId);
  check("新任务: partOwner 已随任务持久化", rec?.partOwner, (x) => x === "node-http");
}

srv.close();
console.log(`\n=== backend-switch: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
