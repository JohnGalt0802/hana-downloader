// test-probe.mjs — download-probe.js 离线单测（2026-09-18）
// 场景：本地 HTTP 源（含重定向）+ 伪造的 winget 下载目录与任务对象。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startWingetProbe } from "../engine/download-probe.js";

// 每进程唯一目录：两套测试并行跑时不会踩同一个伪造下载目录
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-probe-test-"));
const fakeTEMP = path.join(BASE, "fake-temp");
const dlDir = path.join(fakeTEMP, "WinGet", "test.pkg.1.0");
fs.mkdirSync(dlDir, { recursive: true });
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });
process.env.TEMP = fakeTEMP;
process.env.TMP = fakeTEMP;

const SIZE = 2 * 1024 * 1024;
const srv = http.createServer((req, res) => {
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/big.bin" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-length": String(SIZE), "content-type": "application/octet-stream" });
  if (req.method === "HEAD") { res.end(); return; }
  res.end(Buffer.alloc(SIZE));
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const PORT = srv.address().port;

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", name); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 场景 1：完整流程（HEAD 重定向 → 文件增长 → 速度 → 终态自停）
{
  const task = {
    cmd: { type: "winget-install", pkgId: "test.pkg" },
    state: "running",
    installUrl: `http://127.0.0.1:${PORT}/redirect`,
    total: null, received: 0, speed: 0, unit: "steps", _lastProgressAt: 0,
  };
  const stop = startWingetProbe(task, path.join(BASE, "data"));
  await sleep(900);
  check("HEAD: total = 2MB（跟随重定向）", task.total === SIZE);
  check("HEAD: unit 改为 bytes", task.unit === "bytes");

  const file = path.join(dlDir, "feedc0de");
  fs.writeFileSync(file, Buffer.alloc(100 * 1024));
  await sleep(2200);
  check("received: 100KB", task.received === 100 * 1024);

  fs.appendFileSync(file, Buffer.alloc(500 * 1024));
  await sleep(2200);
  check("received: 600KB", task.received === 600 * 1024);
  check("speed > 0", task.speed > 0);
  check("_lastProgressAt 已喂停滞监视器", task._lastProgressAt > 0);

  task.state = "done";
  await sleep(2000);
  const before = task.received;
  fs.appendFileSync(file, Buffer.alloc(200 * 1024));
  await sleep(2000);
  check("终态后自停（不再更新）", task.received === before);
  stop();
}

// 场景 2：目录不存在时安静（HEAD 仍可取）
{
  const task = {
    cmd: { type: "winget-install", pkgId: "no.such.pkg" },
    state: "running",
    installUrl: `http://127.0.0.1:${PORT}/big.bin`,
    total: null, received: 0, speed: 0, unit: "steps", _lastProgressAt: 0,
  };
  const stop = startWingetProbe(task, path.join(BASE, "data"));
  await sleep(1800);
  check("无目录：total 仍取到", task.total === SIZE);
  check("无目录：received 保持 0", task.received === 0);
  stop();
}

// 场景 3：非 winget 任务直接 noop
{
  const task = { cmd: { type: "pip-install", pkg: "six" }, state: "running", received: 0, total: null };
  const stop = startWingetProbe(task, "");
  await sleep(300);
  check("非 winget：无副作用", task.received === 0 && task.total == null);
  stop();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
srv.close();
process.exit(fail ? 1 : 0);
