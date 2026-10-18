// tests/unit-stall.mjs — 卡滞快照的落盘契约（2026-09-20 新增）
//
// 为什么单独测这个：2026-09-20 的第三方七象限测试暴露了一个缺口——
// 任务卡滞时只落了 stalled/<taskId>.json，**没有叫醒 agent**，导致「停下等你决策」这件事
// 根本没发生（Q6 的卡滞通知一直拖到终态才到，Q7 的卡滞没人决策）。
// 修法是把卡滞改成 App 侧轮询 stalled/ → session:send-custom 唤醒 agent。
//
// 那条路的前提是：**卡滞快照里必须带 sessionPath**（否则 App 不知道该投到哪个会话）。
// 这个测试就钉住这个契约，顺带验证启引擎、造卡滞、取消的整条路。
//
// 本测试会真的起一个引擎子进程（HD_ENGINE_PORT 临时端口），不碰生产引擎（4317）。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-stall-test-"));
const DATA_DIR = path.join(BASE, "data");
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const ENGINE_PORT = await new Promise((resolve) => {   // 向系统要空端口，不写死（可并行跑）
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const FAKE_SESSION = "C:\\fake\\sessions\\stall-test.jsonl";

fs.mkdirSync(DATA_DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 静默源：发 200 字节后不再发任何数据 ──
const SRC_PORT = 0;
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" });
  res.write(Buffer.alloc(200));
  // 之后一直沉默，等客户端取消
  res.on("close", () => {});
});
await new Promise((r) => srv.listen(SRC_PORT, "127.0.0.1", r));
const SRC_REAL_PORT = srv.address().port;

// ── 起引擎 ──
const engine = spawn(process.execPath, [path.join(appRoot, "engine", "server.js"), DATA_DIR], {
  env: { ...process.env, HD_ENGINE_PORT: String(ENGINE_PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let ready = false;
let stderrBuf = "";
engine.stdout.on("data", (c) => { if (String(c).includes("HD_ENGINE_READY")) ready = true; });
engine.stderr.on("data", (c) => { stderrBuf += String(c); });
for (let i = 0; i < 100 && !ready; i++) await sleep(100);
if (!ready) console.log("engine stderr:", stderrBuf.slice(0, 400) || "(空)");
check("引擎起得来（HD_ENGINE_PORT 生效）", ready, (x) => x === true);

const api = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${ENGINE_PORT}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};

// ── 造一个 1 秒就判卡滞的任务，sessionPath 是伪造的（只验落盘契约，不验投递）──
let taskId = null;
try {
  const t0 = Date.now();
  const r = await api("/download", {
    url: `http://127.0.0.1:${SRC_REAL_PORT}/stall.bin`,
    fileName: "stall-probe.bin",
    saveDir: path.join(BASE, "out"),
    sessionPath: FAKE_SESSION,
    stallTaskId: "app:hana-downloader:fake-stall-task",
    stallTimeoutMs: 1000,   // 1 秒无数据即判卡滞，测试不必等 30 秒
  });
  taskId = r?.taskId || null;
  check("任务创建成功", r, (x) => x?.ok === true && typeof x.taskId === "string");

  // 等 stalled/<taskId>.json 出现（引擎判定 + 落盘）
  const stalledFile = path.join(DATA_DIR, "stalled", `${taskId}.json`);
  let snap = null;
  for (let i = 0; i < 100 && !snap; i++) {
    await sleep(200);
    try { if (fs.existsSync(stalledFile)) snap = JSON.parse(fs.readFileSync(stalledFile, "utf8")); } catch { /* 半写，下一轮 */ }
  }
  check("卡滞快照落盘", !!snap, (x) => x === true);
  // 「第一时间」：判定间隔曾等于阈值，第一次检查总是差一点，实际要等第二次（实测 30s 阈值→60s）。
  // 这里用 1s 阈值钉住：落盘不该晚于 2.5 秒。
  const judgeMs = Date.now() - t0;
  check("**判定要快**（1s 阈值下 2.5s 内落盘）", judgeMs, (x) => x < 2500);
  check("快照 state 仍是 running（中途快照，不是终态）", snap, (x) => x?.state === "running");
  check("**快照带 sessionPath**（App 靠它决定投到哪个会话）", snap, (x) => x?.sessionPath === FAKE_SESSION);
  check("**快照带 stallTaskId**（App 靠它走 next-step 投递）", snap, (x) => x?.stallTaskId === "app:hana-downloader:fake-stall-task");
  check("快照带 stalledAt（App 靠它去重）", snap, (x) => typeof x?.stalledAt === "number" && x.stalledAt > 0);
  check("快照带 taskId/fileName", snap, (x) => x?.taskId === taskId && x?.fileName === "stall-probe.bin");

  // 取消：卡滞中的任务必须能取消掉
  const c = await api("/cancel", { taskId, source: "user" });
  check("卡滞中的任务可取消", c, (x) => x?.ok === true);
  await sleep(500);
  const list = await api("/list");
  const t = (list?.tasks || []).find((x) => x.taskId === taskId);
  check("取消后终态是 canceled", t, (x) => x?.state === "canceled");
} catch (e) {
  fail++; console.log("FAIL: 用例异常 =>", String(e?.message || e));
}
if (taskId) await api("/cancel", { taskId, source: "agent" }).catch(() => {});

console.log(`\n=== stall: ${pass} passed, ${fail} failed ===`);
try { engine.kill(); } catch { /* 已退出 */ }
srv.close();
await sleep(300);
fs.rmSync(BASE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
