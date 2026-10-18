// tests/unit-aria2-persist.mjs — aria2 任务进度节流落盘
//
// 为什么要有它：aria2 backend 的进度原先只在内存里。引擎被硬杀后重启，
// restore 读到的 tasks.json 里 received 还是 0（或很早的值），用户看到下了两小时的
// 大文件从 0 重来，而文件其实还在盘上。node-http 后端早就有 1.5s 的 _persist() 节流，
// aria2 没有——这套测试盯的就是这个缺口。
//
// 断言三件事：
//   1. 运行中 ≥2 秒后，**磁盘上**的 tasks.json 里 received 已经 > 0（读文件，不看内存）
//   2. 落盘频率受控：4 秒窗口内磁盘上的 received 变化次数很少（不是每轮轮询都写）
//   3. 进度只来自 RPC 的 completedLength：源码里不存在拿 .part 文件大小当进度的写法
//
// 隔离：端口 listen(0) 取系统分配，临时目录 mkdtempSync，可并行跑。
// 没装 aria2 则整体 skip（不算失败），与 unit-aria2.mjs 同口径。
//
// 用法（仓库根目录）：node tests/unit-aria2-persist.mjs
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { aria2Backend, resolveAria2Bin, shutdownInstance } from "../engine/backends/aria2.js";
import { capabilitiesOf } from "../engine/backends/contract.js";
import { getTaskManager } from "../engine/dlcore.js";

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
process.on("exit", () => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

// ── C1. 源码级：进度不得来自 .part 大小 ──
// 允许 statSync(partPath).size 只用于「交付前的字节核对」和「续传前判断残留」，
// 绝不允许赋给 task.received / task.total 或喂给落盘。
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "engine", "backends", "aria2.js"), "utf-8");
  const lines = src.split(/\r?\n/);
  const bad = lines.filter((l) => /\.size\b/.test(l) && /task\.(received|total)\s*=/.test(l));
  check("源码: 没有把 .size 赋给 task.received/total", bad, (x) => x.length === 0);
  const statToReceived = lines.filter((l) => /statSync\([^)]*\)\.size/.test(l) && /received/.test(l) && /task\.received\s*=/.test(l));
  check("源码: statSync(...).size 不参与 received 赋值", statToReceived, (x) => x.length === 0);
  check("源码: 落盘走 ctx.persist()", src, (x) => x.includes("ctx.persist()"));
  check("源码: 有节流常量", src, (x) => /PERSIST_INTERVAL_MS\s*=\s*\d+/.test(x));
}

const ARIA2_BIN = process.env.HD_TEST_NO_ARIA2 ? "" : resolveAria2Bin("");
if (!ARIA2_BIN) {
  console.log("\n跳过 aria2 进度落盘测试（未检测到 aria2c）— 源码级断言已通过");
  console.log(`\n=== aria2-persist: ${pass} passed, ${fail} failed（真实链路已跳过）===`);
  process.exitCode = fail ? 1 : 0;
} else {
  await runReal();
  console.log(`\n=== aria2-persist: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
}

async function runReal() {
  // 慢速源：让下载稳定持续 8 秒以上，足够观察 ≥2 秒的落盘窗口
  const SIZE = 6_000_000;
  const BODY = crypto.randomBytes(SIZE);

  const srv = http.createServer((req, res) => {
    const range = req.headers.range;
    let start = 0, end = SIZE - 1;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (!m) { res.writeHead(416, { "content-range": `bytes */${SIZE}` }); res.end(); return; }
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
      if (start >= SIZE) { res.writeHead(416, { "content-range": `bytes */${SIZE}` }); res.end(); return; }
    }
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
    };
    if (range) headers["content-range"] = `bytes ${start}-${end}/${SIZE}`;
    res.writeHead(range ? 206 : 200, headers);

    let off = start;
    const tick = () => {
      if (off > end) return res.end();
      const n = Math.min(40000, end - off + 1);
      res.write(BODY.subarray(off, off + n));
      off += n;
      setTimeout(tick, 80);
    };
    tick();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const SRC_PORT = srv.address().port;

  // 本进程独占的 aria2 端口段（portCandidates 从基端口往后连试 8 个）
  const A2_BASE_PORT = await (async () => {
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
    return 6828;
  })();

  const BASE = tmpDir("hd-aria2-persist-");
  const DATA_DIR = path.join(BASE, "data");
  const SAVE_DIR = path.join(BASE, "out");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "engine-config.json"), JSON.stringify({
    aria2: { enabled: true, bin: ARIA2_BIN, port: A2_BASE_PORT },
  }, null, 2));

  aria2Backend.setOptions({ bin: ARIA2_BIN, port: A2_BASE_PORT });
  const cap = await capabilitiesOf(aria2Backend, { dataDir: DATA_DIR });
  if (!cap.available) {
    console.log(`跳过 aria2 进度落盘真实链路（${cap.reason || "不可用"}）`);
    srv.close();
    fs.rmSync(BASE, { recursive: true, force: true });
    return;
  }

  const TASKS_JSON = path.join(DATA_DIR, "tasks.json");
  // 只读磁盘：拿 tasks.json 里这条任务的 received（读不到给 null）
  const readDisk = (taskId) => {
    try {
      const meta = JSON.parse(fs.readFileSync(TASKS_JSON, "utf-8"));
      const t = (meta.tasks || []).find((x) => x.taskId === taskId);
      return t ? { received: t.received, state: t.state, backend: t.backend } : null;
    } catch { return null; }
  };

  const mgr = getTaskManager(DATA_DIR);
  const t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/big.bin`, fileName: "persist.bin", saveDir: SAVE_DIR });

  // 每 100ms 采样一次磁盘上的 received，持续 4 秒
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    samples.push({ at: Date.now() - t0, disk: readDisk(t.taskId) });
    await sleep(100);
  }
  const memAtEnd = mgr.snapshot(t.taskId);

  // ── 断言 1：≥2 秒时磁盘上已有进度（不是 0）──
  const after2s = samples.filter((s) => s.at >= 2000).map((s) => s.disk?.received ?? -1);
  check("落盘: 2 秒后 tasks.json 里 received > 0", after2s, (x) => x.length > 0 && x.every((v) => v > 0));
  check("落盘: 2 秒后磁盘进度不倒退（不回到 0）", after2s, (x) => x.every((v, i) => i === 0 || v >= x[i - 1]));
  check("落盘: 磁盘记录里 backend 是 aria2", samples.at(-1)?.disk?.backend, (x) => x === "aria2");
  check("落盘: 磁盘记录状态仍是 running（没提前写终态）", samples.at(-1)?.disk?.state, (x) => x === "running");
  // 磁盘值必须是真进度：与内存快照同量级（内存一直在涨，磁盘允许落后一个节流窗口）
  check("落盘: 磁盘 received 与内存同量级（未落后到 0）", {
    disk: samples.at(-1)?.disk?.received ?? -1, mem: memAtEnd?.received ?? -1,
  }, (x) => x.disk > 0 && x.mem > 0 && x.disk <= x.mem && x.disk >= x.mem * 0.3);

  // ── 断言 2：落盘频率受控 ──
  // 数磁盘上 received 的变化次数：4 秒 / 1.5s 节流 ≈ 最多 3 次（留 1 次余量给终态前的写）
  const changes = [];
  let prev = null;
  for (const s of samples) {
    const v = s.disk?.received;
    if (typeof v !== "number") continue;
    if (prev === null) { prev = v; continue; }
    if (v !== prev) { changes.push(s.at); prev = v; }
  }
  check("限流: 4 秒内磁盘进度变化次数 ≤ 4", changes.length, (x) => x <= 4);
  check("限流: 至少落盘过一次（不是完全不写）", changes.length, (x) => x >= 1);
  check("限流: 两次落盘间隔不小于 1 秒", changes, (x) => x.every((at, i) => i === 0 || at - x[i - 1] >= 1000));

  // ── 收尾：取消这个任务，关掉自己 spawn 的实例 ──
  mgr.cancel(t.taskId, "agent");
  const tEnd = Date.now();
  while (Date.now() - tEnd < 30000) {
    const s = mgr.snapshot(t.taskId);
    if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) break;
    await sleep(100);
  }
  const finalDisk = readDisk(t.taskId);
  check("收尾: 终态已落盘", finalDisk?.state, (x) => ["canceled", "interrupted", "failed", "done"].includes(x));

  await shutdownInstance();
  srv.close();
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
