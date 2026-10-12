// tests/unit-aria2-lifecycle.mjs — aria2 生命周期契约（黑塔档位五条的离线验证）
//
//   1. 不让 aria2 与引擎同时调度 —— create() 时后端确定；配置只影响新任务
//   2. 传输身份明确 —— backend / gid / generation 持久化到 tasks.json
//   3. 提交前 aria2 不可用 —— 允许降级，但不得假报成功
//   4. 临时/最终文件分离 —— partPath 契约
//   5. restore() 对 aria2 任务分流 —— 不删文件、不用 .part 长度当进度
//
// 全程本地回环，不碰外网。需要 aria2c 的用例在找不到时自行跳过。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { getTaskManager, _resetTaskManager } from "../engine/dlcore.js";
import { aria2 } from "../engine/aria2-backend.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// aria2c 来源：环境变量 HD_ARIA2_BIN（本机跑测试时注入）；未提供则由 resolveBin 走 PATH。
// 测试代码不写死任何机器私有路径。
const A2BIN = String(process.env.HD_ARIA2_BIN || "").trim();
const binOpt = A2BIN ? { bin: A2BIN } : {};

// 本地源：小文件，避免真下载
const src = http.createServer((req, res) => {
  res.setHeader("Accept-Ranges", "bytes");
  res.writeHead(200, { "Content-Length": "1024" });
  res.end(Buffer.alloc(1024, 3));
});
await new Promise((r) => src.listen(0, "127.0.0.1", r));
const LOCAL = `http://127.0.0.1:${src.address().port}/x.bin`;

const dirs = [];
function freshDir(cfg) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hd-a2-life-"));
  dirs.push(d);
  if (cfg) fs.writeFileSync(path.join(d, "engine-config.json"), JSON.stringify(cfg), "utf-8");
  _resetTaskManager();
  return d;
}
async function cleanupDir(d) {
  try { await aria2.shutdownDaemon(d); } catch { /* 没起过 */ }
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

try {
  console.log("── 1) 后端在 create 时确定，配置只影响新任务 ──");
  {
    const d = freshDir({ aria2: { enabled: false } });
    const mgr = getTaskManager(d);
    const t1 = mgr.create({ url: LOCAL, saveDir: d });
    check("默认关闭 → 原生后端", t1.backend, "native");
    await sleep(1200);
    check("旧任务后端不变", mgr.snapshot(t1.taskId).backend, "native");

    fs.writeFileSync(path.join(d, "engine-config.json"), JSON.stringify({ aria2: { enabled: true, port: 6886, ...binOpt } }), "utf-8");
    const t2 = mgr.create({ url: LOCAL, saveDir: d });
    check("新任务走 aria2", t2.backend, "aria2");

    const t3 = mgr.create({ url: "https://example.com/c.git", saveDir: d, kind: "command", cmd: { type: "git-clone", args: [], workdir: d } });
    check("命令型永不走 aria2", t3.backend, "command");
    await cleanupDir(d);
  }

  console.log("── 2) backend / gid / generation 写入 tasks.json ──");
  {
    const d = freshDir({ aria2: { enabled: true, port: 6885, ...binOpt } });
    const mgr = getTaskManager(d);
    const t = mgr.create({ url: LOCAL, saveDir: d, fileName: "x.bin" });
    await sleep(2500);
    const meta = JSON.parse(fs.readFileSync(path.join(d, "tasks.json"), "utf-8"));
    const rec = meta.tasks.find((x) => x.taskId === t.taskId);
    check("tasks.json 含 backend", typeof rec?.backend, "string");
    check("tasks.json 含 gid 键", rec && "gid" in rec, true);
    check("tasks.json 含 generation", typeof rec?.generation, "number");
    await cleanupDir(d);
  }

  console.log("── 3) 提交前 aria2 不可用 → 降级，但不假报成功 ──");
  {
    const d = freshDir({ aria2: { enabled: true, bin: "Z:\\nope\\aria2c.exe", port: 6884 } });
    const mgr = getTaskManager(d);
    const t = mgr.create({ url: LOCAL, saveDir: d });
    await sleep(3000);
    const s = mgr.snapshot(t.taskId);
    check("提交前不可用 → 降级为原生后端", s.backend, "native");
    check("未假报 done", s.state === "done" && s.backend === "aria2", false);
    check("不空挂（有终态或在途）", ["running", "pending", "done", "failed", "interrupted"].includes(s.state), true);
    await cleanupDir(d);
  }

  console.log("── 4) 临时文件与最终文件分离（partPath 契约）──");
  {
    const d = freshDir({ aria2: { enabled: true, port: 6883, ...binOpt } });
    const mgr = getTaskManager(d);
    const t = mgr.create({ url: LOCAL, saveDir: d, fileName: "z.bin" });
    check("filePath 不以 .part 结尾", String(t.filePath).endsWith(".part"), false);
    await sleep(2000);
    const p = t.partPath || "";
    check("partPath 以 .part 结尾（或尚未分配）", p === "" || p.endsWith(".part"), true);
    await cleanupDir(d);
  }

  console.log("── 6) hasGid 语义：终态不算活跃（否则重试会被自己挡死）──");
  {
    // 用本地源下载一个小文件到 complete 终态，再断言 hasGid 返回 false（= 可安全重试）。
    // 刻意不用不可达域名：aria2 在 addUri 阶段会校验并拒绝某些 URL（“No URI to download”）。
    const localSrc = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Length": "32" });
      res.end(Buffer.alloc(32, 7));
    });
    await new Promise((r) => localSrc.listen(0, "127.0.0.1", r));
    const srcUrl = `http://127.0.0.1:${localSrc.address().port}/tiny.bin`;

    const d = freshDir({ aria2: { enabled: true, port: 6892, ...binOpt } });
    const up = await aria2.ensureDaemon(d);
    if (!up.ok) {
      console.log("  SKIP  aria2 不可用，跳过 hasGid 语义");
      await cleanupDir(d);
    } else {
      const gid = await aria2.addUri(d, { url: srcUrl, dir: d, out: "tiny.part", gid: "a1b2c3d4e5f60718" });
      let st = "";
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        try { const r = await aria2.rpc(d, "aria2.tellStatus", [gid, ["status"]]); st = String(r.status); } catch { break; }
        if (st === "error" || st === "complete" || st === "removed") break;
      }
      check("任务已落终态（complete/error/removed）", ["error", "complete", "removed"].includes(st), true);
      const has = await aria2.hasGid(d, gid);
      check("hasGid 对终态 gid 返回 false（可安全重试）", has, false);
      const hasMissing = await aria2.hasGid(d, "ffffffffffffffff");
      check("hasGid 对不存在的 gid 返回 false", hasMissing, false);
      await cleanupDir(d);
    }
    try { localSrc.close(); } catch { /* 忽略 */ }
  }

  console.log("── 5) restore() 对 aria2 任务分流（不删文件、不用 .part 长度）──");
  {
    const d = freshDir();
    const fp = path.join(d, "downloads", "keep.bin");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, Buffer.alloc(1024, 1));
    fs.writeFileSync(fp + ".part", Buffer.alloc(2048, 2));
    fs.writeFileSync(path.join(d, "tasks.json"), JSON.stringify({
      version: 3, updatedAt: Date.now(),
      tasks: [{
        taskId: "a2restore1", url: LOCAL, fileName: "keep.bin", filePath: fp,
        saveDir: path.dirname(fp), state: "running", total: 100000, received: 5000,
        speedLimit: 0, startedAt: Date.now() - 5000, finishedAt: null, elapsed: 0,
        error: null, kind: "url", backend: "aria2", gid: "deadbeefdeadbeef", generation: 1,
        partPath: fp + ".part", resumable: true,
      }],
    }), "utf-8");

    _resetTaskManager();
    const mgr = getTaskManager(d);
    mgr.restore();
    const s = mgr.snapshot("a2restore1");
    check("恢复后为 interrupted（待人工重试）", s?.state, "interrupted");
    check("最终文件未被删除", fs.existsSync(fp), true);
    check("received 不来自 .part 长度", s?.received, 5000);
    check("错误信息指向未确认/重试", /未确认|重试/.test(String(s?.error || "")), true);
    await cleanupDir(d);
  }
} catch (e) {
  fail++;
  console.log(`  FAIL 异常: ${e?.message || e}`);
} finally {
  try { src.close(); } catch { /* 忽略 */ }
  for (const d of dirs) { try { await aria2.shutdownDaemon(d); } catch { /* 忽略 */ } }
}

console.log(`\n=== aria2-lifecycle: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
