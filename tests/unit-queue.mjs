// tests/unit-queue.mjs — 并发队列、重试与默认限速的离线测试（2026-09-20 新增）
//
// 覆盖管理器设置面板新暴露、以及引擎侧新实现的三件事：
//   1. maxConcurrent：同时运行数上限，超出的排成 pending + queued，终态后自动放行
//   2. retry：终态任务重跑（清掉上一轮的 error / 停滞痕迹），在途任务拒绝重试
//   3. speedLimit 默认值：任务不传时套用设置里的默认限速
// 全程本地回环，不走代理、不碰外网。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getTaskManager } from "../engine/dlcore.js";

// 每进程唯一目录：两套测试并行跑时不会踩同一个 .part
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-queue-test-"));
const DATA_DIR = path.join(BASE, "data");
const SAVE_DIR = path.join(BASE, "out");
fs.mkdirSync(SAVE_DIR, { recursive: true });
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const BIG = 512 * 1024;   // 512KB，按 150ms/64KB 发 → 约 1.2 秒
const SMALL = 64 * 1024;  // 64KB，一次性发完
const CHUNK = 64 * 1024;
const INTERVAL = 150;
const failOnce = {};      // url → 已收到次数（只用来做"第一次掐断"）

function sendSlow(res, size) {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
  let sent = 0;
  const timer = setInterval(() => {
    if (sent >= size) { clearInterval(timer); res.end(); return; }
    const n = Math.min(CHUNK, size - sent);
    res.write(Buffer.alloc(n, 0x41));
    sent += n;
  }, INTERVAL);
  res.on("close", () => clearInterval(timer));
}

const srv = http.createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "HEAD") {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BIG) });
    return res.end();
  }
  if (url.startsWith("/fail-once")) {
    failOnce[url] = (failOnce[url] || 0) + 1;
    if (failOnce[url] === 1) { res.socket.destroy(); return; } // 第一次掐断 → 任务失败
    return sendSlow(res, BIG);
  }
  if (url.startsWith("/small")) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(SMALL) });
    return res.end(Buffer.alloc(SMALL, 0x42));
  }
  return sendSlow(res, BIG);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));

const mgr = getTaskManager(DATA_DIR);
const base = `http://127.0.0.1:${srv.address().port}`;

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitState(taskId, states, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = mgr.snapshot(taskId);
    if (s && states.includes(s.state)) return s;
    await sleep(50);
  }
  return mgr.snapshot(taskId);
}

// ── 场景 1：并发上限 1，三个任务串行 ──
{
  mgr.applyConfig({ maxConcurrent: 1, speedLimit: 0 });
  const t1 = mgr.create({ url: `${base}/slow-a.bin`, fileName: "q1.bin", saveDir: SAVE_DIR });
  const t2 = mgr.create({ url: `${base}/slow-b.bin`, fileName: "q2.bin", saveDir: SAVE_DIR });
  const t3 = mgr.create({ url: `${base}/slow-c.bin`, fileName: "q3.bin", saveDir: SAVE_DIR });
  await sleep(300);
  const s1 = mgr.snapshot(t1.taskId), s2 = mgr.snapshot(t2.taskId), s3 = mgr.snapshot(t3.taskId);
  check("并发1: 第一个在跑", s1, (x) => x.state === "running" && x.queued === false);
  check("并发1: 第二个排队", s2, (x) => x.state === "pending" && x.queued === true);
  check("并发1: 第三个排队", s3, (x) => x.state === "pending" && x.queued === true);
  check("并发1: 同时只有一个 running", [s1, s2, s3], (x) => x.filter((t) => t.state === "running").length === 1);

  const d1 = await waitState(t1.taskId, ["done", "failed", "interrupted"]);
  check("并发1: 第一个完成", d1, (x) => x.state === "done");

  // 第一个腾出槽位后，第二个应当自动开跑（不必等人工干预）
  const r2 = await waitState(t2.taskId, ["running"], 8000);
  check("并发1: 第二个自动接上", r2, (x) => x.state === "running" || x.state === "done");

  const d2 = await waitState(t2.taskId, ["done", "failed", "interrupted"]);
  const d3 = await waitState(t3.taskId, ["done", "failed", "interrupted"]);
  check("并发1: 三个都完成", [d2.state, d3.state], (x) => x[0] === "done" && x[1] === "done");
  check("并发1: 三个文件都落盘", null, () => ["q1.bin", "q2.bin", "q3.bin"].every((n) => fs.existsSync(path.join(SAVE_DIR, n))));
}

// ── 场景 2：失败 → 重试 → 成功，且上一轮的痕迹被清掉 ──
{
  mgr.applyConfig({ maxConcurrent: 3, speedLimit: 0 });
  const t = mgr.create({ url: `${base}/fail-once.bin`, fileName: "retry.bin", saveDir: SAVE_DIR });
  const bad = await waitState(t.taskId, ["failed", "interrupted", "done"]);
  check("重试前: 第一次失败", bad, (x) => x.state === "failed" || x.state === "interrupted");
  check("重试前: 带错误信息", bad, (x) => !!x.error);

  const rr = mgr.retry(t.taskId);
  check("retry: 受理", rr, (x) => x.ok === true);
  const back = await waitState(t.taskId, ["done"], 90000);
  check("retry后: 完成", back, (x) => x.state === "done");
  check("retry后: 字节数对齐", back, (x) => x.total === BIG && x.received === BIG);
  check("retry后: 上一轮的 error 已清", back, (x) => x.error === null);
  check("retry后: 文件落盘", back, (x) => fs.existsSync(x.filePath) && fs.statSync(x.filePath).size === BIG);
}

// ── 场景 3：在途任务拒绝重试；排队任务可取消 ──
{
  mgr.applyConfig({ maxConcurrent: 1, speedLimit: 0 });
  const t1 = mgr.create({ url: `${base}/busy-a.bin`, fileName: "busy1.bin", saveDir: SAVE_DIR });
  const t2 = mgr.create({ url: `${base}/busy-b.bin`, fileName: "busy2.bin", saveDir: SAVE_DIR });
  await sleep(300);
  check("在途: 第二个处于排队", mgr.snapshot(t2.taskId), (x) => x.state === "pending" && x.queued === true);
  const rrRunning = mgr.retry(t1.taskId);
  check("在途: 拒绝重试", rrRunning, (x) => x.ok === false && String(x.error).includes("进行中"));

  const cr = mgr.cancel(t2.taskId, "user");
  await sleep(200);
  check("排队任务: 可取消", mgr.snapshot(t2.taskId), (x) => x.state === "canceled" && x.queued === false);
  check("排队任务: 取消返回 ok", cr, (x) => x.ok === true);
  // 取消排队任务不占用槽位，第一个仍在跑
  check("排队任务: 不影响在跑的", mgr.snapshot(t1.taskId), (x) => x.state === "running" || x.state === "done");
  mgr.cancel(t1.taskId, "agent");
  await waitState(t1.taskId, ["canceled", "done", "failed", "interrupted"], 10000);
}

// ── 场景 4：默认限速（任务自己不传时套用设置值）──
{
  mgr.applyConfig({ maxConcurrent: 0, speedLimit: 256 * 1024 });
  const t = mgr.create({ url: `${base}/small.bin`, fileName: "limited.bin", saveDir: SAVE_DIR });
  const s = mgr.snapshot(t.taskId);
  check("默认限速: 写进任务", s, (x) => x.speedLimit === 256 * 1024);
  const t0 = Date.now();
  const done = await waitState(t.taskId, ["done", "failed", "interrupted"]);
  const cost = Date.now() - t0;
  check("默认限速: 完成", done, (x) => x.state === "done");
  check("默认限速: 确实被拖慢（64KB @256KB/s ≥200ms）", cost, (x) => x >= 200);

  const explicit = mgr.create({ url: `${base}/small.bin`, fileName: "nolimit.bin", saveDir: SAVE_DIR, speedLimit: 0 });
  await waitState(explicit.taskId, ["done", "failed", "interrupted"]);
  mgr.applyConfig({ maxConcurrent: 0, speedLimit: 0 });
}

// ── 场景 5：并发上限放宽后，排队任务立刻放行 ──
{
  mgr.applyConfig({ maxConcurrent: 1, speedLimit: 0 });
  const t1 = mgr.create({ url: `${base}/wide-a.bin`, fileName: "w1.bin", saveDir: SAVE_DIR, speedLimit: 128 * 1024 });
  const t2 = mgr.create({ url: `${base}/wide-b.bin`, fileName: "w2.bin", saveDir: SAVE_DIR, speedLimit: 128 * 1024 });
  await sleep(300);
  check("放宽前: 第二个排队", mgr.snapshot(t2.taskId), (x) => x.state === "pending" && x.queued === true);
  mgr.applyConfig({ maxConcurrent: 0, speedLimit: 0 }); // 放宽上限
  await sleep(300);
  check("放宽后: 第二个立刻开跑", mgr.snapshot(t2.taskId), (x) => x.state === "running" || x.state === "done");
  mgr.cancel(t1.taskId, "agent");
  mgr.cancel(t2.taskId, "agent");
  await sleep(200);
}

// ── 场景 6：命令型任务「启动失败」（spawn 异步 emit ENOENT）──
// 为什么压在这里：spawn 返回 child 不等于进程起来了——bin 不在 PATH 时是**异步** emit
// 'error'，_runCommand 里那圈 try/catch 只挡同步异常。历史上这条路径靠 'close' 的退出码
// 收尾，文案写成「命令退出码 -4058」，看不出是「根本没起来」还是「跑失败了」。
// 这里钉三件事：① 结算成 failed 而不是挂 running ② 文案说「无法启动」
// ③ 终态只发一次（'error' 与 'close' 都会来，旧写法会结算两次）。
// ④ 本进程不崩：下面每条断言能执行到，本身就是证据。
{
  mgr.applyConfig({ maxConcurrent: 0, speedLimit: 0 });   // 不限并发，避免排队干扰
  const realPath = process.env.PATH;
  const emptyPath = path.join(BASE, "empty-path");
  fs.mkdirSync(emptyPath, { recursive: true });
  const finals = [];
  mgr.onFinal((t) => finals.push(t.taskId));

  let t = null, s = null;
  try {
    // 把 PATH 指到一个空目录：git 不可解析 → spawn 异步 emit ENOENT
    //（注意不能提前恢复 PATH：_runCommand 里 import 之后才 spawn，恢复早了就会真的去 clone）
    process.env.PATH = emptyPath;
    t = mgr.create({
      url: null, fileName: "repo", kind: "command", unit: "objects",
      cmd: { type: "git-clone", args: ["probe-never-cloned"] },
      filePath: path.join(BASE, "never-cloned"),
    });
    s = await waitState(t.taskId, ["failed", "done", "canceled", "interrupted"], 15000);
  } finally {
    process.env.PATH = realPath;
  }

  check("启动失败: 结算为 failed（不挂 running）", s, (x) => x?.state === "failed");
  check("启动失败: 文案含「无法启动」", s, (x) => typeof x?.error === "string" && x.error.includes("无法启动"));
  check("启动失败: 文案带原始 ENOENT 信息", s, (x) => /ENOENT/.test(String(x?.error || "")));
  check("启动失败: speed 归零", s, (x) => x?.speed === 0);
  check("启动失败: 有 finishedAt / elapsed", s, (x) => typeof x.finishedAt === "number" && x.finishedAt > 0 && typeof x.elapsed === "number");

  // 'close' 随后就到（win32 是 -4058），等一拍再数：终态必须仍然只有一次
  await sleep(600);
  check("**启动失败: 终态只发一次**（error 与 close 不会各结算一遍）",
    finals.filter((id) => id === t.taskId).length, (n) => n === 1);
  check("启动失败: 状态未被随后的 close 改写", mgr.snapshot(t.taskId), (x) => x.state === "failed" && x.error.includes("无法启动"));

  // 重试：闸门必须复位，否则第二轮所有结算都被闸门吃掉 → 永远挂在 running。
  // 重试时同样把 PATH 抽空：不真去跑 git，联网/磁盘都不碰，只验闸门。
  let rr = null, s2 = null;
  try {
    process.env.PATH = emptyPath;   // 在 retry() 之前抽空：spawn 在 import 之后才发生，不能赌时序
    rr = mgr.retry(t.taskId);
    check("重试: 闸门已复位（_settled=false）", mgr.tasks.get(t.taskId)?._settled, (x) => x === false);
    s2 = await waitState(t.taskId, ["failed", "done", "canceled", "interrupted"], 20000);
  } finally {
    process.env.PATH = realPath;
  }
  check("启动失败: 可重试", rr, (x) => x?.ok === true);
  check("重试: 能再次落终态（闸门没被上一轮卡死）", s2, (x) => ["failed", "done", "canceled"].includes(x?.state));
  check("重试: 第二轮也是「无法启动」（证明真的重新 spawn 了）", s2,
    (x) => typeof x?.error === "string" && x.error.includes("无法启动"));
}

console.log(`\n=== queue: ${pass} passed, ${fail} failed ===`);
srv.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
