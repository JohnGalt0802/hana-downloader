// tests/unit-atomic-final.mjs — 终态记录的原子写（2026-10-19 新增）
//
// 为什么要有它：老哥复查发现 finished/<taskId>.json 用 writeFileSync 直接写目标路径。
// 进程在 write 中途被杀 → 文件永久停在半截 JSON → app 侧 settleWhenDone 每 2 秒
// JSON.parse 一次、抛错被 catch 吞掉 → 一直读到 30 分钟满 → 报「下载超时未结束」。
// 代价是「把一次成功伪装成超时」，正好把 2026-10-18 修掉的假超时重新引回来。
//
// 这个套件钉住四件事：
//   1. 目标路径**永远不会**出现半截内容：写入过程中并发轮询，只允许「不存在」或「完整可解析」
//      （并用同一探针打一遍旧的直接写，证明探针真的能抓到半截——否则这个测试没有鉴别力）
//   2. 正常路径下终态内容与改动前一致（仍是 summarizeTask 的产物，字段与值都不变）
//   3. 失败路径不留 .tmp 垃圾，且旧终态不被破坏
//   4. 起真引擎跑一遍：finished/ 与 stalled/ 两条落盘都走原子路径，落盘后目录里没有 .tmp
//
// 端口用 listen(0)、临时目录用 mkdtempSync（可并行跑）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getTaskManager, _resetTaskManager } from "../engine/dlcore.js";
import { writeJsonAtomic } from "../engine/atomic-write.js";
import { summarizeTask } from "../engine/summary.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const ATOMIC_MOD = path.join(appRoot, "engine", "atomic-write.js");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-atomic-test-"));
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listTmp = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")); } catch { return []; } };

// ══ 场景 1：写入途中并发读，目标路径只能是「不存在」或「完整 JSON」 ══
// 探针：1ms 轮询目标路径，凡是能读到的内容都必须能 JSON.parse 且 blob 长度对得上。
// mode=atomic 走生产代码 writeJsonAtomic；mode=plain 复刻改动前的直接写（对照组）。
async function probe(mode, dir) {
  const target = path.join(dir, "probe.json");
  const SIZE = 4 * 1024 * 1024;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    ${mode === "atomic" ? `import { writeJsonAtomic } from ${JSON.stringify(new URL("file://" + ATOMIC_MOD).href)};` : ""}
    const target = ${JSON.stringify(target)};
    const payload = JSON.stringify({ taskId: "probe", blob: "x".repeat(${SIZE}) });
    for (let i = 0; i < 8; i++) {
      ${mode === "atomic" ? "writeJsonAtomic(target, payload);" : 'fs.writeFileSync(target, payload, "utf8");'}
    }
  `], { stdio: ["ignore", "inherit", "inherit"] });

  let reads = 0, halves = 0, completed = 0;
  while (child.exitCode === null) {
    if (fs.existsSync(target)) {
      let txt = null;
      try { txt = fs.readFileSync(target, "utf8"); } catch { txt = null; }
      if (txt !== null) {
        reads++;
        try {
          const j = JSON.parse(txt);
          if (j.blob.length === SIZE) completed++;
          else halves++;              // 解析得动但内容截断（极少见，也算半截）
        } catch { halves++; }         // 半截 JSON：改动前就是这里把等待方坑死的
      }
    }
    await sleep(1);
  }
  return { reads, halves, completed, code: child.exitCode };
}

{
  const dirA = path.join(BASE, "probe-atomic");
  const dirP = path.join(BASE, "probe-plain");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirP, { recursive: true });

  const a = await probe("atomic", dirA);
  const p = await probe("plain", dirP);

  check("对照组（改动前的直接写）确实能被探针抓到半截", p, (x) => x.halves > 0 && x.code === 0);
  check("原子写：子进程完整跑完（rename 未被并发读卡住）", a.code, (x) => x === 0);
  check("原子写：写入过程中从未读到半截", a, (x) => x.halves === 0);
  check("原子写：写入过程中读到过完整内容（探针真的在工作）", a, (x) => x.completed > 0);
  check("原子写：结束后目标路径是完整 JSON", JSON.parse(fs.readFileSync(path.join(dirA, "probe.json"), "utf8")).blob.length,
    (x) => x === 4 * 1024 * 1024);
  check("原子写：目录里没有 .tmp 残留", listTmp(dirA), (x) => x.length === 0);
}

// ══ 场景 2：进程在写入途中被 SIGKILL，目标路径不允许出现半截 ══
{
  const dir = path.join(BASE, "kill-probe");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "killed.json");
  const SIZE = 6 * 1024 * 1024;
  let halves = 0, present = 0, absent = 0;
  for (let i = 0; i < 12; i++) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeJsonAtomic } from ${JSON.stringify(new URL("file://" + ATOMIC_MOD).href)};
      writeJsonAtomic(${JSON.stringify(target)}, JSON.stringify({ taskId: "kill", blob: "y".repeat(${SIZE}) }));
    `], { stdio: ["ignore", "inherit", "inherit"] });
    await sleep(2 + (i % 8));
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    await new Promise((r) => child.on("close", r));
    if (!fs.existsSync(target)) { absent++; continue; }
    present++;
    try {
      const j = JSON.parse(fs.readFileSync(target, "utf8"));
      if (j.blob.length !== SIZE) halves++;
    } catch { halves++; }
  }
  check("SIGKILL 途中：目标路径从未出现半截", halves, (x) => x === 0);
  check("SIGKILL 途中：只可能是「不存在」或「完整」", [absent + present, halves],
    (x) => x[0] > 0 && x[1] === 0);
}

// ══ 场景 3：失败路径——不留 .tmp，旧终态不被破坏 ══
{
  const dir = path.join(BASE, "fail-probe");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "keep.json");
  const oldText = JSON.stringify({ taskId: "keep", state: "done", n: 1 });
  fs.writeFileSync(target, oldText, "utf8");

  // 造一个 rename 必失败的目标：把目标路径变成一个非空目录
  const blocked = path.join(dir, "blocked.json");
  fs.mkdirSync(path.join(blocked, "x"), { recursive: true });
  let threw = false;
  try { writeJsonAtomic(blocked, JSON.stringify({ a: 1 })); } catch { threw = true; }
  check("失败路径：确实抛出（调用方按原逻辑 try/catch）", threw, (x) => x === true);
  check("失败路径：没有 .tmp 垃圾", listTmp(dir), (x) => x.length === 0);

  // 正常覆盖：旧内容被完整替换
  writeJsonAtomic(target, JSON.stringify({ taskId: "keep", state: "failed", n: 2 }));
  check("覆盖写：目标变成新内容", JSON.parse(fs.readFileSync(target, "utf8")),
    (x) => x.state === "failed" && x.n === 2);
  check("覆盖写：没有 .tmp 垃圾", listTmp(dir), (x) => x.length === 0);
}

// ══ 场景 4：正常路径——终态内容与改动前一致（仍是 summarizeTask 的产物） ══
{
  const DATA_DIR = path.join(BASE, "normal", "data");
  const SAVE_DIR = path.join(BASE, "normal", "out");
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const BODY = crypto.randomBytes(200 * 1024);
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BODY.length) });
    if (req.method === "HEAD") return res.end();
    res.end(BODY);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));

  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
  const mgr = getTaskManager(DATA_DIR);
  const finals = [];
  mgr.onFinal((t) => { finals.push(t); });   // 只记录，不落盘

  const t = mgr.create({ url: `http://127.0.0.1:${srv.address().port}/n.bin`, fileName: "n.bin", saveDir: SAVE_DIR });
  let snap = null;
  for (let i = 0; i < 300 && !snap; i++) {
    await sleep(100);
    const s = mgr.snapshot(t.taskId);
    if (s && s.state === "done") snap = s;
  }
  check("正常路径：下载完成", snap?.state, (x) => x === "done");

  // 按 server.js onFinal 的写法落一份（同样的数据源与路径）
  const finalTask = finals.find((x) => x.taskId === t.taskId);
  check("onFinal 收到终态", !!finalTask, (x) => x === true);
  const expectText = JSON.stringify(summarizeTask(finalTask));
  writeJsonAtomic(path.join(DATA_DIR, "finished", `${t.taskId}.json`), expectText);

  const p = path.join(DATA_DIR, "finished", `${t.taskId}.json`);
  const actualText = fs.readFileSync(p, "utf8");
  check("正常路径：终态文件内容与 summarizeTask 逐字节一致", actualText, (x) => x === expectText);
  const parsed = JSON.parse(actualText);
  check("正常路径：关键字段齐全且值正确", parsed,
    (x) => x.taskId === t.taskId && x.state === "done" && x.received === BODY.length
      && x.total === BODY.length && x.percent === 100 && x.filePath === snap.filePath);
  check("正常路径：finished/ 里没有 .tmp", listTmp(path.join(DATA_DIR, "finished")), (x) => x.length === 0);

  // 恢复补写（_publishInterrupted）也走原子路径：restore 后不留 .tmp
  fs.writeFileSync(path.join(DATA_DIR, "tasks.json"), JSON.stringify({
    version: 3, updatedAt: 1, tasks: [{
      taskId: "int-1", url: "http://127.0.0.1:1/x.bin", fileName: "x.bin",
      filePath: path.join(BASE, "normal", "out", "x.bin"), saveDir: SAVE_DIR,
      state: "running", total: 100, received: 10, speedLimit: 0, startedAt: 1,
      finishedAt: null, elapsed: 0, error: null, kind: "url", cmd: null, unit: "bytes",
    }],
  }), "utf-8");
  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
  getTaskManager(DATA_DIR).restore();
  const ip = path.join(DATA_DIR, "finished", "int-1.json");
  check("恢复补写：落盘且可解析", fs.existsSync(ip) ? JSON.parse(fs.readFileSync(ip, "utf8")).state : null,
    (x) => x === "interrupted");
  check("恢复补写：finished/ 里没有 .tmp", listTmp(path.join(DATA_DIR, "finished")), (x) => x.length === 0);

  srv.close();
  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
}

// ══ 场景 5：起真引擎——finished/ 与 stalled/ 两条落盘都走原子路径 ══
{
  const DATA_DIR = path.join(BASE, "engine", "data");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const port = await new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });

  // 快源（正常完成 → finished/）与静默源（卡滞 → stalled/）
  const fastBody = crypto.randomBytes(64 * 1024);
  const fast = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(fastBody.length) });
    if (req.method === "HEAD") return res.end();
    res.end(fastBody);
  });
  await new Promise((r) => fast.listen(0, "127.0.0.1", r));
  const slow = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" });
    res.write(Buffer.alloc(100));
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));

  const engine = spawn(process.execPath, [path.join(appRoot, "engine", "server.js"), DATA_DIR], {
    env: { ...process.env, HD_ENGINE_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = false, errBuf = "";
  engine.stdout.on("data", (c) => { if (String(c).includes("HD_ENGINE_READY")) ready = true; });
  engine.stderr.on("data", (c) => { errBuf += String(c); });
  for (let i = 0; i < 100 && !ready; i++) await sleep(100);
  check("引擎起得来", ready, (x) => x === true);
  if (!ready) console.log("engine stderr:", errBuf.slice(0, 300) || "(空)");

  const api = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  try {
    // ① 正常完成 → finished/
    const r = await api("/download", {
      url: `http://127.0.0.1:${fast.address().port}/f.bin`, fileName: "f.bin",
      saveDir: path.join(BASE, "engine", "out"),
    });
    const fp = path.join(DATA_DIR, "finished", `${r.taskId}.json`);
    let fs1 = null;
    for (let i = 0; i < 100 && !fs1; i++) {
      await sleep(100);
      try { if (fs.existsSync(fp)) fs1 = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { /* 半截的话下一轮 */ }
    }
    check("引擎 finished/：落盘且可解析", fs1, (x) => x?.state === "done" && x?.taskId === r.taskId);
    check("引擎 finished/：没有 .tmp", listTmp(path.join(DATA_DIR, "finished")), (x) => x.length === 0);

    // ② 卡滞 → stalled/
    const s = await api("/download", {
      url: `http://127.0.0.1:${slow.address().port}/s.bin`, fileName: "s.bin",
      saveDir: path.join(BASE, "engine", "out"), stallTimeoutMs: 800,
    });
    const sp = path.join(DATA_DIR, "stalled", `${s.taskId}.json`);
    let ss = null;
    for (let i = 0; i < 100 && !ss; i++) {
      await sleep(100);
      try { if (fs.existsSync(sp)) ss = JSON.parse(fs.readFileSync(sp, "utf8")); } catch { /* 半截的话下一轮 */ }
    }
    check("引擎 stalled/：落盘且可解析", ss, (x) => x?.taskId === s.taskId && x?.state === "running");
    check("引擎 stalled/：没有 .tmp", listTmp(path.join(DATA_DIR, "stalled")), (x) => x.length === 0);
    await api("/cancel", { taskId: s.taskId, source: "agent" }).catch(() => {});
  } catch (e) {
    fail++; console.log("FAIL: 引擎用例异常 =>", String(e?.message || e));
  }

  try { engine.kill(); } catch { /* 已退出 */ }
  fast.close(); slow.close();
  await sleep(300);
}

console.log(`\n=== atomic-final: ${pass} passed, ${fail} failed ===`);
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
