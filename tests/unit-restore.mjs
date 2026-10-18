// tests/unit-restore.mjs — 重启恢复的终态补写契约（2026-10-18 新增）
//
// 为什么要有它：2026-10-18 实测事故——用户下 1GB+ 大文件时引擎被重启，任务在管理器里
// 变成 interrupted，但 app 侧 settleWhenDone 读的 finished/<taskId>.json 永远不会出现
//（引擎被 kill 时来不及走 onFinal），于是空等 900×2s=30 分钟后报「下载超时未结束」。
// 那是假错误：真原因是「被应用重启打断」。
//
// 修法：restore() 把 running/pending 恢复成 interrupted 时，补写一条同形终态。
// 这个套件钉住四件事：
//   1. running / pending 恢复后**确实**落了 finished/<taskId>.json
//   2. 记录是 summarizeTask 的形状、state=interrupted、error 说明是应用重启（消费方能直接用）
//   3. 幂等：重复 restore 不产生重复记录
//   4. 孤儿回收：超过 1 小时的 finished/*.json 在 restore 时被删，新的不动
//
// 纯离线：不起引擎、不碰网络、不碰生产数据目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTaskManager, _resetTaskManager } from "../engine/dlcore.js";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-restore-test-"));
const DATA_DIR = path.join(BASE, "data");
const FINISHED = path.join(DATA_DIR, "finished");
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

function freshManager() {
  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
  return getTaskManager(DATA_DIR);
}

function readFinished(taskId) {
  const p = path.join(FINISHED, `${taskId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeMeta(tasks) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "tasks.json"),
    JSON.stringify({ version: 3, updatedAt: 1, tasks }), "utf-8");
}

const baseTask = (over) => ({
  taskId: "t", url: "http://127.0.0.1:1/x.bin", fileName: "x.bin",
  filePath: path.join(BASE, "out", "x.bin"), saveDir: path.join(BASE, "out"),
  state: "running", total: 1000, received: 400, speedLimit: 0,
  startedAt: 1, finishedAt: null, elapsed: 0, error: null, canceledBy: null,
  kind: "url", cmd: null, unit: "bytes", note: null, stalledAt: null,
  sessionId: null, sessionPath: null, etag: null, lastModified: null,
  partPath: null, acceptRanges: false, expectedSha256: null, resumable: true,
  ...over,
});

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 场景 1：running → interrupted，且补写终态 ──
{
  writeMeta([baseTask({ taskId: "run-1", state: "running", received: 400 })]);
  const mgr = freshManager();
  mgr.restore();

  check("running: 内存状态 interrupted", mgr.snapshot("run-1")?.state, (x) => x === "interrupted");
  const snap = readFinished("run-1");
  check("running: **补写了 finished 记录**（否则宿主空等 30 分钟）", snap, (x) => x !== null);
  check("running: 记录 state=interrupted", snap?.state, (x) => x === "interrupted");
  check("running: error 说明是应用重启", snap?.error, (x) => typeof x === "string" && x.includes("应用重启"));
  // 形状：summary.js 的 summarizeTask 产物（settleWhenDone 直接按这些键取值）
  check("running: 是 summarizeTask 形状（关键键齐全）", snap,
    (x) => ["taskId", "state", "fileName", "filePath", "total", "received", "percent",
      "error", "kind", "unit", "elapsed", "finishedAt", "stalled"].every((k) => k in x));
  check("running: taskId 与内存一致", snap?.taskId, (x) => x === "run-1");
  check("running: received 保留恢复点", snap?.received, (x) => x === 400);
  check("running: 内存记录与落盘记录同源", snap?.startedAt, (x) => x === 1);
}

// ── 场景 2：pending（排队中被重启）也要补写 ──
{
  writeMeta([baseTask({ taskId: "pend-1", state: "pending", received: 0, total: 1000 })]);
  const mgr = freshManager();
  mgr.restore();
  check("pending: 内存状态 interrupted", mgr.snapshot("pend-1")?.state, (x) => x === "interrupted");
  check("pending: 补写了 finished 记录", readFinished("pend-1"), (x) => x !== null && x.state === "interrupted");
}

// ── 场景 3：幂等——重复 restore 不产生重复（仍是同一份文件，内容不叠加）──
{
  writeMeta([baseTask({ taskId: "idem-1", state: "running" })]);
  freshManager().restore();
  const first = readFinished("idem-1");
  const files1 = fs.readdirSync(FINISHED).filter((f) => f === "idem-1.json");
  freshManager().restore();
  const second = readFinished("idem-1");
  const files2 = fs.readdirSync(FINISHED).filter((f) => f === "idem-1.json");
  check("幂等: 两次 restore 都只有一份记录", [files1.length, files2.length], (x) => x[0] === 1 && x[1] === 1);
  check("幂等: 记录仍可解析且状态不变", second, (x) => x?.taskId === "idem-1" && x?.state === "interrupted");
  check("幂等: 覆盖写而非追加", [first?.finishedAt, second?.finishedAt],
    (x) => typeof x[0] === "number" && typeof x[1] === "number");
}

// ── 场景 4：历史终态任务不被补写（done/canceled 不重复落一条假的 interrupted）──
{
  writeMeta([
    baseTask({ taskId: "done-1", state: "done", received: 1000, finishedAt: 5 }),
    baseTask({ taskId: "canceled-1", state: "canceled", error: "已取消", finishedAt: 6 }),
  ]);
  const mgr = freshManager();
  mgr.restore();
  check("done: 状态保持 done", mgr.snapshot("done-1")?.state, (x) => x === "done");
  check("done: **没有**被补写 finished", readFinished("done-1"), (x) => x === null);
  check("canceled: **没有**被补写 finished", readFinished("canceled-1"), (x) => x === null);
}

// ── 场景 5：孤儿终态回收——超过 1 小时的删，新的留 ──
{
  fs.mkdirSync(FINISHED, { recursive: true });
  const oldP = path.join(FINISHED, "orphan-old.json");
  const newP = path.join(FINISHED, "orphan-new.json");
  fs.writeFileSync(oldP, JSON.stringify({ taskId: "orphan-old" }), "utf8");
  fs.writeFileSync(newP, JSON.stringify({ taskId: "orphan-new" }), "utf8");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(oldP, twoHoursAgo, twoHoursAgo);

  writeMeta([]); // 没有任务要恢复，只验回收
  freshManager().restore();
  check("回收: 超过 1 小时的孤儿被删（没人等了）", fs.existsSync(oldP), (x) => x === false);
  check("回收: 1 小时内的不动（可能还有等待方）", fs.existsSync(newP), (x) => x === true);
}

// ── 场景 6：恢复任务的补写能被「读走即删」消费掉（与 settleWhenDone 的契约一致）──
{
  writeMeta([baseTask({ taskId: "consume-1", state: "running" })]);
  const mgr = freshManager();
  mgr.restore();
  const p = path.join(FINISHED, "consume-1.json");
  check("消费前: 存在", fs.existsSync(p), (x) => x === true);
  // settleWhenDone 的读法：existsSync → readFileSync → JSON.parse → unlinkSync
  const snap = JSON.parse(fs.readFileSync(p, "utf8"));
  check("消费: JSON.parse 不抛且有 state", snap, (x) => !!x.state);
  fs.unlinkSync(p);
  check("消费后: 删除成功（finished/ 不堆积）", fs.existsSync(p), (x) => x === false);
  check("消费后: 内存里的任务仍在（管理器还能看到）", mgr.snapshot("consume-1")?.state, (x) => x === "interrupted");
}

console.log(`\n=== restore: ${pass} passed, ${fail} failed ===`);
_resetTaskManager();
delete globalThis.__dlTaskMgr;
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
