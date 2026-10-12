// tests/e2e-aria2-endpoint.mjs — aria2 后端端到端（真 daemon + 本地 HTTP 源）
//
// 验证一条完整链路：引擎创建 aria2 任务 → 专属 daemon 下载 → 轮询映射 → 校验 → 改名交付。
// 用本地 HTTP 服务器作源（支持 Range），不依赖外网。
//
// 需要本机 aria2c 可执行文件；找不到则整体跳过（不判失败）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { getTaskManager, _resetTaskManager } from "../engine/dlcore.js";
import { aria2 } from "../engine/aria2-backend.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 源：32MB 支持 Range 的文件（超过 min-split-size，可分段）
const SIZE = 32 * 1024 * 1024;
const CHUNK = Buffer.alloc(1 << 20, 7);
const server = http.createServer((req, res) => {
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : SIZE - 1;
    res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${SIZE}`, "Content-Length": String(end - start + 1) });
    let sent = 0; const total = end - start + 1;
    const tick = () => { if (sent >= total) return res.end(); const n = Math.min(CHUNK.length, total - sent); res.write(CHUNK.subarray(0, n)); sent += n; setImmediate(tick); };
    tick();
  } else {
    res.writeHead(200, { "Content-Length": String(SIZE) });
    let sent = 0;
    const tick = () => { if (sent >= SIZE) return res.end(); res.write(CHUNK); sent += CHUNK.length; setImmediate(tick); };
    tick();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL = `http://127.0.0.1:${server.address().port}/big.bin`;

// 期望哈希：整文件是 CHUNK 的重复
const fullHash = (() => { const h = createHash("sha256"); let left = SIZE; while (left > 0) { const n = Math.min(CHUNK.length, left); h.update(CHUNK.subarray(0, n)); left -= n; } return h.digest("hex"); })();

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-aria2-e2e-"));
const saveDir = path.join(dataDir, "out");
fs.mkdirSync(saveDir, { recursive: true });
// aria2c 来源：环境变量 HD_ARIA2_BIN（本机跑测试时注入）；未提供则由 resolveBin 走 PATH。
// 测试代码不写死任何机器私有路径。
const A2BIN = String(process.env.HD_ARIA2_BIN || "").trim();
fs.writeFileSync(path.join(dataDir, "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, port: 6899, minSplitSize: 1 << 20, split: 8, maxConnectionPerServer: 8, ...(A2BIN ? { bin: A2BIN } : {}) },
}), "utf-8");

let daemonStarted = false;
try {
  console.log("── 端到端：aria2 后端完整链路 ──");
  _resetTaskManager();
  const mgr = getTaskManager(dataDir);
  mgr.applyConfig({ maxConcurrent: 3 });

  const up = await aria2.ensureDaemon(dataDir, { log: (s) => console.log("       [daemon]", s) });
  if (!up.ok) {
    console.log(`  SKIP  aria2 不可用（${up.error}）——跳过端到端`);
    process.exit(0);
  }
  daemonStarted = true;
  check("专属 daemon 就绪", up.ok, true);

  const t = mgr.create({ url: URL, saveDir, fileName: "big.bin", expectedSha256: fullHash });
  check("任务后端为 aria2", t.backend, "aria2");

  // gid 在提交阶段异步分配：等一小会儿再查
  await sleep(1500);
  check("gid 已预分配并持久化", typeof t.gid === "string" && t.gid.length > 0, true);

  // 轮询到终态
  let snap = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    snap = mgr.snapshot(t.taskId);
    if (snap && ["done", "failed", "interrupted", "canceled"].includes(snap.state)) break;
  }
  check("终态为 done（校验通过 + 改名成功）", snap?.state, "done");
  check("total 已上报", snap?.total, SIZE);
  check("received 收满", snap?.received, SIZE);
  check("percent = 100", snap?.percent, 100);

  const finalPath = snap?.filePath;
  check("最终文件存在", !!(finalPath && fs.existsSync(finalPath)), true);
  if (finalPath && fs.existsSync(finalPath)) {
    const h = createHash("sha256");
    const fd = fs.openSync(finalPath, "r");
    const b = Buffer.alloc(1 << 20);
    let n; while ((n = fs.readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n));
    fs.closeSync(fd);
    check("交付文件内容哈希与期望一致", h.digest("hex"), fullHash);
  }
  check("未残留 .part", fs.existsSync((finalPath || "") + ".part"), false);

  // ── 取消语义：未确认不报成功 ──
  // 用限速源确认任务真的处于 running（本地快源会瞬间完成，测不到取消路径）。
  console.log("\n── 取消语义（慢源）──");
  const slow = http.createServer((req, res) => {
    res.setHeader("Accept-Ranges", "bytes");
    res.writeHead(200, { "Content-Length": String(SIZE) });
    let sent = 0;
    const tick = () => {
      if (sent >= SIZE) return res.end();
      res.write(CHUNK); sent += CHUNK.length;
      setTimeout(tick, 200); // 限速：每 1MB 停 200ms
    };
    tick();
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  const slowUrl = `http://127.0.0.1:${slow.address().port}/slow.bin`;
  const t2 = mgr.create({ url: slowUrl, saveDir, fileName: "slow.bin" });
  await sleep(1200);
  const mid = mgr.snapshot(t2.taskId);
  check("慢源任务处于 running 才谈得上取消", mid?.state, "running");
  const c = mgr.cancel(t2.taskId, "test");
  check("aria2 任务 cancel 受理（置意图，不假报成功）", c.ok, true);
  let end2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    end2 = mgr.snapshot(t2.taskId);
    if (end2 && ["canceled", "interrupted", "done", "failed"].includes(end2.state)) break;
  }
  check("取消后落入 canceled 或 interrupted（不空挂）", ["canceled", "interrupted"].includes(end2?.state), true);
  try { slow.close(); } catch { /* 忽略 */ }
} catch (e) {
  fail++;
  console.log(`  FAIL 端到端异常: ${e?.message || e}`);
} finally {
  if (daemonStarted) { try { await aria2.shutdownDaemon(dataDir); } catch { /* 忽略 */ } }
  try { server.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n=== aria2-e2e: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
