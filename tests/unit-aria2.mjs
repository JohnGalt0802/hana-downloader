// tests/unit-aria2.mjs — aria2 backend（W2）单测
//
// 分两段：
//   A. 纯函数段（任何机器都跑）：状态映射、进度映射、错误文案、端口候选、契约校验、交付校验
//   B. 真实链路段（没装 aria2 就整体 skip，不算失败）：
//        本地 HTTP 源 → aria2 backend 下载 → **断言 SHA-256 与源一致**
//        中断后重试 → 再断言 SHA 一致（续传）
//
// 为什么 SHA 是核心断言：上一轮续传 bug 让文件前半段清零而状态报 done。
// 「state === done」不等于「文件正确」，这里只认内容级对拍。
//
// 用法（仓库根目录）：node tests/unit-aria2.mjs
// 退出码：全过（含 skip）为 0，有失败为 1。
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  REQUIRED_CAPABILITIES, REQUIRED_TASK_FIELDS, validateBackend, validateCapabilities,
  capabilitiesOf, deliverPartFile, sha256File,
} from "../engine/backends/contract.js";
import {
  aria2Backend, mapAria2Status, mapProgress, friendlyAria2Error, portCandidates,
  resolveAria2Bin, shutdownInstance,
} from "../engine/backends/aria2.js";
import { getTaskManager } from "../engine/dlcore.js";
import { summarizeTask } from "../engine/summary.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每进程唯一临时目录：并行跑两套测试时不互相踩（原固定名 hd-aria2-* 会互指同一份文件）
const TMP_DIRS = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
};
process.on("exit", () => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

// 本进程独占的 aria2 基端口：portCandidates 会从基端口往后连试 8 个，
// 所以要求这 8 个都空着（两个进程并行跑时写死 6828 会互撞端口）。
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
  return 6828; // 实在找不到就回落到旧值
})();

// ════════════════════════════════════════════════════════════════
// A. 纯函数（不需要 aria2）
// ════════════════════════════════════════════════════════════════

// A1. 状态映射：complete 绝不能直接变 done
{
  check("map active → running", mapAria2Status("active"), (x) => x === "running");
  check("map waiting → pending", mapAria2Status("waiting"), (x) => x === "pending");
  check("map paused → pending", mapAria2Status("paused"), (x) => x === "pending");
  // ← 本轮最重要的一条：aria2 的 complete 只代表「它传完了」，交付要等内容级校验
  check("map complete → complete（不是 done）", mapAria2Status("complete"), (x) => x === "complete");
  check("map complete 明确不等于 done", mapAria2Status("complete"), (x) => x !== "done");
  check("map error → failed", mapAria2Status("error"), (x) => x === "failed");
  check("map removed → canceled", mapAria2Status("removed"), (x) => x === "canceled");
  // 未知状态不能猜成 done（假报成功比报错更糟）
  for (const weird of ["", null, undefined, "ACTIVE", "weird", 0, {}]) {
    check(`map 未知值 ${JSON.stringify(weird)} 不产出 done`, mapAria2Status(weird), (x) => x !== "done");
  }
  check("map 大小写不敏感（ACTIVE → running）", mapAria2Status("ACTIVE"), (x) => x === "running");
}

// A2. 进度映射：只认 completedLength，字符串转数字，非法值不产 NaN
{
  const p = mapProgress({ completedLength: "300000", totalLength: "1000000", downloadSpeed: "51200" });
  check("progress: received 取 completedLength", p.received, (x) => x === 300000);
  check("progress: total 取 totalLength", p.total, (x) => x === 1000000);
  check("progress: speed 取 downloadSpeed", p.speed, (x) => x === 51200);

  const zero = mapProgress({ completedLength: "0", totalLength: "0", downloadSpeed: "0" });
  check("progress: totalLength=0 → total null（不猜）", zero.total, (x) => x === null);
  check("progress: totalLength=0 时 received 保留原值", zero.received, (x) => x === 0);

  const empty = mapProgress({});
  check("progress: 空对象 received=0", empty.received, (x) => x === 0);
  check("progress: 空对象 total=null", empty.total, (x) => x === null);
  check("progress: 空对象 speed=0（不是 NaN）", empty.speed, (x) => Number.isFinite(x) && x === 0);

  const junk = mapProgress({ completedLength: "abc", totalLength: null, downloadSpeed: undefined });
  check("progress: 非法字符串不产 NaN", junk, (x) => Number.isFinite(x.received) && Number.isFinite(x.speed));
  check("progress: 缺字段 total=null", junk.total, (x) => x === null);

  // 关键：传 null/undefined 不能炸
  check("progress: null 入参不炸", mapProgress(null), (x) => x && x.received === 0);

  // 夹紧：completedLength 略大于 total 时不许百分比溢出
  const over = mapProgress({ completedLength: "1000500", totalLength: "1000000" });
  check("progress: 超量夹到 total（不产 >100%）", over, (x) => x.received === 1000000 && x.total === 1000000);
}

// A3. aria2 errorCode → 人话
{
  check("err 3 → 资源不存在", friendlyAria2Error(3), (x) => String(x).includes("404"));
  check("err 9 → 磁盘空间不足", friendlyAria2Error(9), (x) => String(x).includes("磁盘空间"));
  check("err 32 → 校验和不符", friendlyAria2Error(32), (x) => String(x).includes("校验和"));
  check("err 未知码 → 带码但不崩", friendlyAria2Error(999), (x) => typeof x === "string" && x.includes("999"));
  check("err 空码 → 字符串", friendlyAria2Error(null), (x) => typeof x === "string" && x.length > 0);
  check("err 带 message → 加括号附注", friendlyAria2Error(6, "conn reset"), (x) => String(x).includes("conn reset"));
}

// A4. 端口候选
{
  const c = portCandidates(6802);
  check("ports: 8 个候选", c.length, (x) => x === 8);
  check("ports: 从基端口起", c[0], (x) => x === 6802);
  check("ports: 到 6809", c[c.length - 1], (x) => x === 6809);
  check("ports: 非法基端口回落 6802", portCandidates("abc")[0], (x) => x === 6802);
  check("ports: 负数基端口回落 6802", portCandidates(-5)[0], (x) => x === 6802);
}

// A5. 契约校验：缺 name/capabilities/run 都要报出来
{
  const good = { name: "x", capabilities: () => ({ available: true, name: "x", features: [], reason: null }), run: async () => {} };
  check("validate: 合法 backend 通过", validateBackend(good).ok, (x) => x === true);
  check("validate: node-http 通过", validateBackend({ name: "node-http", capabilities: () => ({ available: true, name: "node-http", features: [], reason: null }), run: async () => {} }).ok, (x) => x === true);
  check("validate: aria2 通过", validateBackend(aria2Backend).ok, (x) => x === true);

  for (const bad of [null, undefined, {}, { name: "x" }, { name: "", capabilities() {}, run() {} }, { name: "x", capabilities: 1, run: 2 }]) {
    check(`validate: 残缺 backend ${JSON.stringify(bad)} 被拒`, validateBackend(bad).ok, (x) => x === false);
  }
  check("validate: 错误信息可读（指向缺失项）", validateBackend({ name: "x" }).errors.join("|"),
    (x) => x.includes("capabilities") && x.includes("run"));

  // capabilities 字段完整性
  check("cap: 缺字段被拒", validateCapabilities({ available: true, name: "x" }), (x) => x.length > 0);
  check("cap: available 非布尔被拒", validateCapabilities({ available: "yes", name: "x", features: [], reason: null }), (x) => x.length > 0);
  check("cap: features 非数组被拒", validateCapabilities({ available: true, name: "x", features: {}, reason: null }), (x) => x.length > 0);
  check("cap: 完整通过", validateCapabilities({ available: true, name: "x", features: [], reason: null }), (x) => x.length === 0);
  check("cap: REQUIRED_CAPABILITIES 四个", REQUIRED_CAPABILITIES.length, (x) => x === 4);

  // capabilitiesOf 兼容同步/异步/抛错
  const capsOf = await capabilitiesOf(aria2Backend, { dataDir: tmpDir("hd-aria2-cap-") });
  check("capabilitiesOf: 回对象", capsOf, (x) => x && typeof x === "object" && typeof x.available === "boolean");
  const boom = await capabilitiesOf({ name: "boom", capabilities() { throw new Error("x"); }, run: async () => {} });
  check("capabilitiesOf: 抛错 → available=false 且带原因", boom, (x) => x.available === false && typeof x.reason === "string" && x.reason.length > 0);
  const asyncCap = await capabilitiesOf({ name: "a", capabilities: async () => ({ available: true, name: "a", features: [], reason: null }), run: async () => {} });
  check("capabilitiesOf: Promise 形态可用", asyncCap.available, (x) => x === true);

  check("REQUIRED_TASK_FIELDS 含 state/received/total/error", REQUIRED_TASK_FIELDS.join(","), (x) => x === "state,received,total,error");
}

// A6. deliverPartFile：SHA 不符绝不交付（这条就是上周事故的护栏）
{
  const dir = tmpDir("hd-aria2-deliver-");
  const body = crypto.randomBytes(200000);
  const sha = crypto.createHash("sha256").update(body).digest("hex");

  // ① 无 expectedSha256：直接交付
  const p1 = path.join(dir, "a.part"); const f1 = path.join(dir, "a.bin");
  fs.writeFileSync(p1, body);
  const r1 = deliverPartFile({ partPath: p1, filePath: f1, expectedSha256: null });
  check("deliver: 无摘要时交付成功", r1.ok, (x) => x === true);
  check("deliver: 无摘要时文件就位且内容一致", fs.existsSync(f1) && fs.readFileSync(f1).equals(body), (x) => x === true);
  check("deliver: .part 已改名（不残留）", fs.existsSync(p1), (x) => x === false);

  // ② 摘要正确：交付
  const p2 = path.join(dir, "b.part"); const f2 = path.join(dir, "b.bin");
  fs.writeFileSync(p2, body);
  const r2 = deliverPartFile({ partPath: p2, filePath: f2, expectedSha256: sha.toUpperCase() });
  check("deliver: 摘要正确（大写也认）→ 交付", r2.ok, (x) => x === true);
  check("deliver: 摘要正确 → 文件就位", fs.existsSync(f2), (x) => x === true);

  // ③ 摘要错误：拒绝交付，且 .part 留着（可排查/重试），正式文件不存在
  const p3 = path.join(dir, "c.part"); const f3 = path.join(dir, "c.bin");
  fs.writeFileSync(p3, body);
  const r3 = deliverPartFile({ partPath: p3, filePath: f3, expectedSha256: "0".repeat(64) });
  check("deliver: 摘要不符 → 拒绝", r3.ok, (x) => x === false);
  check("deliver: 摘要不符 → 标 shaMismatch", r3.shaMismatch, (x) => x === true);
  check("deliver: 摘要不符 → 文案含 SHA-256", r3.error, (x) => String(x).includes("SHA-256"));
  check("deliver: 摘要不符 → 正式文件不存在（不交付）", fs.existsSync(f3), (x) => x === false);
  check("deliver: 摘要不符 → .part 保留", fs.existsSync(p3), (x) => x === true);

  // ④ 半成品不存在
  const r4 = deliverPartFile({ partPath: path.join(dir, "nope.part"), filePath: path.join(dir, "nope.bin") });
  check("deliver: 半成品不存在 → 失败", r4.ok, (x) => x === false);
  check("deliver: 缺路径 → 失败", deliverPartFile({}).ok, (x) => x === false);

  // ⑤ 流式哈希与整文件哈希一致（1MB 分块边界）
  const big = path.join(dir, "big.bin");
  const bigBody = crypto.randomBytes(1024 * 1024 * 2 + 12345);
  fs.writeFileSync(big, bigBody);
  const want = crypto.createHash("sha256").update(bigBody).digest("hex");
  check("sha256File: 分块与整块一致", sha256File(big), (x) => x === want);

  fs.rmSync(dir, { recursive: true, force: true });
}

// A7. 可执行探测：显式路径不存在时不静默回落 PATH（配错要看得见）
{
  check("bin: 显式不存在路径 → 空串", resolveAria2Bin(path.join(os.tmpdir(), "no-such-aria2c-xyz.exe")), (x) => x === "");
  const found = resolveAria2Bin("");
  check("bin: 自动探测返回字符串", typeof found, (x) => x === "string");
}

// A7b. 探测失败不缓存（2026-10-18 修）：
//   此前把 ""（没找到）也缓存 30 秒 → 用户在引擎运行期装了 aria2 也不生效，必须重启。
//   现在只缓存找到的结果。本条在**子进程**里做：需要控制 PATH / LOCALAPPDATA 造「找不到」的环境，
//   而主进程（本次测试进程）自己就要用真实 aria2 跑真链路段，不能把它弄脏。
{
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sandbox = tmpDir("hd-aria2-nocache-");
  const fakeLocal = path.join(sandbox, "localappdata");
  const linksDir = path.join(fakeLocal, "Microsoft", "WinGet", "Links");
  fs.mkdirSync(linksDir, { recursive: true });
  const sample = resolveAria2Bin(""); // 有真 aria2 就拿它当「待安装样本」

  // 子进程里：先探测（应空）→ 把 aria2c 放进目标目录 → 再探测（应找得到）
  // 写成临时 .mjs 文件而不用 -e：PowerShell 下 -e 的引号会把脚本内容搞坏（实测无输出）。
  //
  // 2026-10-19：光改环境变量做不到真隔离。resolveAria2Bin 在 which/where 失败后会走
  // **硬编码绝对路径候选表**（/usr/bin/aria2c、/opt/homebrew/bin/aria2c、
  // C:\ProgramData\chocolatey\bin\aria2c.exe …），这些不受任何环境变量控制；
  // GitHub runner 预装 aria2c，于是三平台都探到了真 aria2c。
  // 现在：① PATH 只给一个空的沙箱目录（which/where 找不到，也连命令本身都起不来，落回候选表）；
  //       ② candidates 只指向沙箱内的目标文件——环境干净与否都不影响结果。
  const probeFile = path.join(sandbox, "probe.mjs");
  const aria2Url = new URL(`file:///${path.join(appRoot, "engine", "backends", "aria2.js").replace(/\\/g, "/")}`).href;
  const targetFile = path.join(linksDir, "aria2c.exe");
  const emptyBin = path.join(sandbox, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.writeFileSync(probeFile, `
    import fs from "node:fs";
    import { resolveAria2Bin } from ${JSON.stringify(aria2Url)};
    const target = ${JSON.stringify(targetFile.replace(/\\/g, "/"))};
    const sample = ${JSON.stringify((sample || "").replace(/\\/g, "/"))};
    const opts = { candidates: () => [target] }; // 内置候选表全部拿掉，只认沙箱内的文件
    const before = resolveAria2Bin("", opts);
    const before2 = resolveAria2Bin("", opts);
    fs.mkdirSync(${JSON.stringify(linksDir.replace(/\\/g, "/"))}, { recursive: true });
    if (sample) fs.copyFileSync(sample, target); else fs.writeFileSync(target, "");
    const after = resolveAria2Bin("", opts);
    process.stdout.write(JSON.stringify({ before, before2, after, target }));
  `, "utf-8");
  const r = spawnSync(process.execPath, [probeFile], {
    encoding: "utf-8",
    windowsHide: true,
    env: {
      ...process.env,
      // 空目录当 PATH：which / where 都不可能探到 aria2c（也不再受 runner 预装影响）
      PATH: emptyBin,
      LOCALAPPDATA: fakeLocal,
      USERPROFILE: path.join(sandbox, "userprofile"),
      // 2026-10-18：探测逻辑新增了 HOMEDRIVE+HOMEPATH 优先于 LOCALAPPDATA
      // （宿主沙箱把 LOCALAPPDATA / USERPROFILE 都重定向到 .runtime-tmp，
      //  但 HOMEDRIVE / HOMEPATH 没被改，真实 aria2c 只能从这条拼出来）。
      // 隔离环境必须把这两个也改掉，否则仍会找到宿主机上的真 aria2c。
      HOMEDRIVE: "D:",
      HOMEPATH: path.join("\\", "hd-no-such-home"),
      ProgramFiles: path.join(sandbox, "programfiles"),
    },
  });
  let out = null;
  try { out = JSON.parse(String(r.stdout || "")); } catch { out = null; }
  if (!out) console.log("  probe stderr:", String(r.stderr || "").slice(0, 300));
  check("bin 缓存: 子进程探测跑得起来", out, (x) => !!x && typeof x === "object");
  check("bin 缓存: 隔离环境下第一次探测为空", out?.before, (x) => x === "");
  check("bin 缓存: 连续两次探测都为空（空值没被缓存成“有”）", out?.before2, (x) => x === "");
  // 核心：刚放进去就找得到（修复前这一步会返回 ""，因为空结果被缓存了 30s）
  check("bin 缓存: 放入后立即探测能找到（不等 30s、不重启）", out?.after, (x) => typeof x === "string" && x.length > 0);
  check("bin 缓存: 找到的是刚放进去的那个路径", out?.after, (x) => typeof x === "string" && x.toLowerCase() === String(out?.target || "").toLowerCase());

  fs.rmSync(sandbox, { recursive: true, force: true });
}

// A7c. 显式配置不存在的 bin：保持旧行为（返回空、不回落 PATH），且**不进缓存**
{
  const missing = path.join(os.tmpdir(), "no-such-dir-xyz", "aria2c.exe");
  check("bin 显式: 不存在 → 空串（不回落 PATH，配错要稳定报错）", resolveAria2Bin(missing), (x) => x === "");
  check("bin 显式: 重复调用仍为空（行为稳定）", resolveAria2Bin(missing), (x) => x === "");
  // 显式路径不会污染自动探测：自动探测仍应返回真实路径（本机有的话）
  const auto = resolveAria2Bin("");
  check("bin 显式失败不影响自动探测", typeof auto, (x) => x === "string");
}

// A9. capabilities 的可用性判定：端口上坐的不是 aria2 → 必须 available:false（2026-10-18 修）
//   这条不需要 aria2 本体：起一个假 HTTP 服务占住配置端口，它回 JSON 但不是 aria2 的 JSON-RPC。
//   修复前：available:true、version:null、port 自动避让到下一个空端口（用户开启开关时被骗）。
//   修复后：available:false，reason 说清「端口被非 aria2 程序占用」。
{
  const httpMod = await import("node:http");
  const squatBin = resolveAria2Bin("");
  if (!squatBin) {
    console.log("（跳过 A9：本机没有 aria2c，无法验证「非 aria2 占端口」分支）");
  } else {
  const BASE = tmpDir("hd-aria2-squat-unit-");
  // 本段故意验证「端口被非 aria2 占着」——所以这里必须有一个真被占用的端口。
  // 端口号仍向系统要（先 listen(0) 拿真端口，占着不放），不写死，并行跑不互抢。
  // mock：回一个合法 JSON，但不是 JSON-RPC 形状（aria2 的回包一定有 jsonrpc/id 字段）
  const fake = httpMod.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"hello":"i am not aria2"}');
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const SQUAT_PORT = fake.address().port;

  // setOptions 会失效探测缓存，但 options 没变时不会 —— 抖一下端口（用一个不会去探测的临时值），保证读到本轮结果
  aria2Backend.setOptions({ bin: squatBin, port: 1 });
  aria2Backend.setOptions({ bin: squatBin, port: SQUAT_PORT });

  const cap = await capabilitiesOf(aria2Backend, { dataDir: BASE });
  check("capabilities: 端口上不是 aria2 → available=false", cap.available, (x) => x === false);
  check("capabilities: reason 说清不是 aria2", cap.reason, (x) => typeof x === "string" && /aria2/i.test(x) && /占用|不是|无法/.test(x));
  check("capabilities: 不报可用时不带假 version", cap, (x) => x.version === undefined || !x.version);
  check("capabilities: features 空数组（不宣称能力）", cap.features, (x) => Array.isArray(x) && x.length === 0);

  // 对照：mock 一个「看起来像 JSON-RPC 但没 version」的响应，也不能算可用
  const fake2 = httpMod.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"jsonrpc":"2.0","id":"hd","result":{"enabledFeatures":[]}}');
  });
  await new Promise((r) => fake2.listen(0, "127.0.0.1", r));
  const SQUAT_PORT2 = fake2.address().port;
  aria2Backend.setOptions({ bin: squatBin, port: 1 });
  aria2Backend.setOptions({ bin: squatBin, port: SQUAT_PORT2 });
  const cap2 = await capabilitiesOf(aria2Backend, { dataDir: BASE });
  check("capabilities: JSON-RPC 外形但缺 version → available=false", cap2.available, (x) => x === false);
  check("capabilities: 缺 version 的 reason 指向 version", cap2.reason, (x) => typeof x === "string" && /version/i.test(x));

  await new Promise((r) => fake.close(r));
  await new Promise((r) => fake2.close(r));
  fs.rmSync(BASE, { recursive: true, force: true });
  }
}

// A8. restore()：aria2 任务的 .part 大小不能当 received（否则重启后进度直接 100%）
//   不需要 aria2 本体——这条纯在 dlcore 的恢复逻辑里。
{
  const { _resetTaskManager } = await import("../engine/dlcore.js");
  const BASE = tmpDir("hd-aria2-restore-");
  const DATA = path.join(BASE, "data");
  fs.mkdirSync(DATA, { recursive: true });
  const fp = path.join(BASE, "big.bin");
  const pp = fp + ".part";
  fs.writeFileSync(pp, Buffer.alloc(1000000)); // 假装 aria2 把 .part 开到了全长
  const meta = {
    version: 3, updatedAt: 1,
    tasks: [
      {
        taskId: "a2-task", url: "http://x/1", fileName: "big.bin", filePath: fp, saveDir: BASE,
        state: "running", total: 1000000, received: 250000, speedLimit: 0,
        startedAt: 1, finishedAt: null, elapsed: 0, error: null, kind: "url", unit: "bytes",
        partPath: pp, resumable: true, backend: "aria2",
      },
      {
        taskId: "nh-task", url: "http://x/2", fileName: "big.bin", filePath: fp, saveDir: BASE,
        state: "running", total: 1000000, received: 250000, speedLimit: 0,
        startedAt: 1, finishedAt: null, elapsed: 0, error: null, kind: "url", unit: "bytes",
        partPath: pp, resumable: true, backend: "node-http",
      },
    ],
  };
  fs.writeFileSync(path.join(DATA, "tasks.json"), JSON.stringify(meta), "utf-8");
  // 单例是 globalThis 级别的：先拆干净，否则后面真实链路段会拿到这里这台（dataDir 不对）。
  _resetTaskManager();
  delete globalThis.__dlTaskMgr;
  const m = getTaskManager(DATA);
  m.restore();
  const a2 = m.snapshot("a2-task");
  const nh = m.snapshot("nh-task");
  check("restore: aria2 任务沿用持久化的 received（不拿 .part 大小兑现）", a2?.received, (x) => x === 250000);
  check("restore: node-http 任务仍用 .part 大小（旧行为不变）", nh?.received, (x) => x === 1000000);
  check("restore: aria2 任务状态落 interrupted", a2?.state, (x) => x === "interrupted");
  check("restore: backend 字段保留", a2?.backend, (x) => x === "aria2");
  _resetTaskManager();
  delete globalThis.__dlTaskMgr; // 交还给后续真实链路段（它自己要一台新 manager）
  fs.rmSync(BASE, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════
// B. 真实链路（无 aria2 则 skip）
// ════════════════════════════════════════════════════════════════
const ARIA2_BIN = process.env.HD_TEST_NO_ARIA2 ? "" : resolveAria2Bin("");
if (!ARIA2_BIN) {
  console.log("\n跳过 aria2 真实链路（未检测到 aria2c）— 纯函数段已通过");
  console.log(`\n=== aria2: ${pass} passed, ${fail} failed（真实链路已跳过）===`);
  process.exitCode = fail ? 1 : 0;
} else {
  console.log(`\n检测到 aria2c：${ARIA2_BIN}`);
  await runReal();
  console.log(`\n=== aria2: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
}

async function runReal() {
  // ── 本地 HTTP 源：支持 Range（续传必需），可切「第一次中途掐断」模式 ──
  const SIZE = 1200000;
  const BODY = crypto.randomBytes(SIZE);
  const SHA = crypto.createHash("sha256").update(BODY).digest("hex");
  const cutState = { cutEvery: false, hits: 0 };

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

    // 掐断模式：每个连接发一点就断，让 aria2 重试用尽后落 error（造「中断」现场）
    if (cutState.cutEvery) {
      cutState.hits += 1;
      res.write(BODY.subarray(start, Math.min(start + 20000, end + 1)), () => setTimeout(() => res.destroy(), 30));
      return;
    }

    let off = start;
    // /slow 开头的路径走慢速（给「取消」与「并发」留出可观测窗口）
    const slow = (req.url || "").includes("slow");
    const step = slow ? 20000 : 60000;
    const delay = slow ? 60 : 8;
    const tick = () => {
      if (off > end) return res.end();
      const n = Math.min(step, end - off + 1);
      res.write(BODY.subarray(off, off + n));
      off += n;
      setTimeout(tick, delay);
    };
    tick();
  });
  const PORT = 0;
  await new Promise((r) => srv.listen(PORT, "127.0.0.1", r));
  const SRC_PORT = srv.address().port;

  const BASE = tmpDir("hd-aria2-test-");
  const DATA_DIR = path.join(BASE, "data");
  const SAVE_DIR = path.join(BASE, "out");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SAVE_DIR, { recursive: true });

  // 打开配置开关（本测试独占一个 dataDir，不碰用户真实配置）
  fs.writeFileSync(path.join(DATA_DIR, "engine-config.json"), JSON.stringify({
    aria2: { enabled: true, bin: ARIA2_BIN, port: A2_BASE_PORT },
  }, null, 2));

  // 把 backend 的选项对齐到本段要用的端口：前面 A9 把 options.port 改到过别的值，
  // capabilities 现在也走 ensureInstance（会读 state.options.port），不重置就会起在旧端口上。
  aria2Backend.setOptions({ bin: ARIA2_BIN, port: A2_BASE_PORT });

  // 后端真的可用吗（端口全占等情况下 skip 而不是失败）
  const cap = await capabilitiesOf(aria2Backend, { dataDir: DATA_DIR });
  if (!cap.available) {
    console.log(`跳过 aria2 真实链路（${cap.reason || "不可用"}）— 纯函数段已通过`);
    srv.close();
    fs.rmSync(BASE, { recursive: true, force: true });
    return;
  }
  check("能力探测: available", cap.available, (x) => x === true);
  check("能力探测: name=aria2", cap.name, (x) => x === "aria2");
  check("能力探测: features 是数组", Array.isArray(cap.features), (x) => x === true);
  check("能力探测: 回包不含 secret", JSON.stringify(cap).toLowerCase(), (x) => !x.includes("secret"));
  // available:true 必须伴随真实拿到的版本号（2026-10-18 修：此前这条是 version:null）
  check("能力探测: version 是真实版本号", cap.version, (x) => typeof x === "string" && /^\d+\.\d+\.\d+/.test(x));
  check("能力探测: 带实例端口", cap.port, (x) => Number.isInteger(x) && x > 0);

  const mgr = getTaskManager(DATA_DIR);
  const waitFinal = async (taskId, timeoutMs = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = mgr.snapshot(taskId);
      if (s && ["done", "failed", "canceled", "interrupted"].includes(s.state)) return s;
      await sleep(100);
    }
    return mgr.snapshot(taskId);
  };

  const URL = `http://127.0.0.1:${SRC_PORT}/file.bin`;

  // ── 场景 1：正常下载，断言 SHA 与源一致 ──
  {
    cutState.cutEvery = false; // 本轮不掐断
    const t = mgr.create({ url: URL, fileName: "plain.bin", saveDir: SAVE_DIR });
    const snap = await waitFinal(t.taskId);
    check("plain: done", snap?.state, (x) => x === "done");
    check("plain: 走的是 aria2 backend", snap?.backend, (x) => x === "aria2");
    check("plain: 字节数对齐", snap, (x) => x.total === SIZE && x.received === SIZE);
    check("plain: 文件落盘", snap, (x) => fs.existsSync(x.filePath));
    check("plain: 无 .part 残留", snap, (x) => !fs.existsSync(x.filePath + ".part"));
    // 核心断言：内容级对拍
    check("plain: 文件 SHA-256 与源一致", snap && fs.existsSync(snap.filePath)
      ? crypto.createHash("sha256").update(fs.readFileSync(snap.filePath)).digest("hex") : null,
      (x) => x === SHA);
    check("plain: 摘要经 summarizeTask 带出 backend", summarizeTask(snap).backend, (x) => x === "aria2");
  }

  // ── 场景 2：expectedSha256 正确 → 交付 ──
  {
    const t = mgr.create({ url: URL, fileName: "sum-ok.bin", saveDir: SAVE_DIR, expectedSha256: SHA });
    const snap = await waitFinal(t.taskId);
    check("sha 正确: done", snap?.state, (x) => x === "done");
    check("sha 正确: 文件 SHA 一致", snap && fs.existsSync(snap.filePath)
      ? crypto.createHash("sha256").update(fs.readFileSync(snap.filePath)).digest("hex") : null,
      (x) => x === SHA);
  }

  // ── 场景 3：expectedSha256 错误 → 失败且不交付（内容级护栏）──
  {
    const t = mgr.create({ url: URL, fileName: "sum-bad.bin", saveDir: SAVE_DIR, expectedSha256: "0".repeat(64) });
    const snap = await waitFinal(t.taskId);
    check("sha 错误: failed（不能报 done）", snap?.state, (x) => x === "failed");
    check("sha 错误: 文案含 SHA-256 或校验和", String(snap?.error || ""), (x) => x.includes("SHA-256") || x.includes("校验和"));
    check("sha 错误: 正式文件未交付", snap && fs.existsSync(snap.filePath), (x) => x === false);
  }

  // ── 场景 4：中断 → 重试（续传）→ SHA 一致 ──
  {
    cutState.cutEvery = true;
    const t = mgr.create({ url: URL, fileName: "resume.bin", saveDir: SAVE_DIR });
    const first = await waitFinal(t.taskId);
    check("resume: 第一次未完成（interrupted/failed）", first?.state, (x) => x === "interrupted" || x === "failed");
    check("resume: 没有误报 done", first?.state, (x) => x !== "done");
    check("resume: 掐断确实发生过", cutState.hits, (x) => x > 0);

    cutState.cutEvery = false;
    const r = mgr.retry(t.taskId);
    check("resume: 重试被受理", r.ok, (x) => x === true);
    const snap = await waitFinal(t.taskId);
    check("resume: 续传后 done", snap?.state, (x) => x === "done");
    check("resume: 字节数对齐", snap, (x) => snap.total === SIZE && snap.received === SIZE);
    // 核心断言（上一轮就是这里出的事）：内容必须与源完全一致
    const fileBuf = snap && fs.existsSync(snap.filePath) ? fs.readFileSync(snap.filePath) : null;
    check("resume: 最终文件 SHA-256 与源一致", fileBuf
      ? crypto.createHash("sha256").update(fileBuf).digest("hex") : null, (x) => x === SHA);
    check("resume: 前段未被清零", fileBuf ? fileBuf.subarray(0, 1000).every((b) => b === 0) : true, (x) => x === false);
    check("resume: 无 .part 残留", snap.filePath + ".part", (x) => !fs.existsSync(x));
  }

  // ── 场景 5：进度映射在真实运行中可用（轮询期间收到的值单调不减）──
  {
    const t = mgr.create({ url: URL, fileName: "progress.bin", saveDir: SAVE_DIR });
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const s = mgr.snapshot(t.taskId);
      if (s) {
        seen.push(s.received);
        if (["done", "failed", "canceled", "interrupted"].includes(s.state)) break;
      }
      await sleep(100);
    }
    const mono = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
    check("progress: 过程中 received 单调不减", mono, (x) => x === true);
    check("progress: 进度不超过 total", seen.every((v) => v <= SIZE), (x) => x === true);
  }

  // ── 场景 6：取消（aria2.remove → 确认 removed）不假报完成、保留半成品 ──
  {
    const t = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/slow-cancel.bin`, fileName: "cancel.bin", saveDir: SAVE_DIR });
    // 等它真的开始传（received > 0）再取消，否则可能刚提交就取消
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const s = mgr.snapshot(t.taskId);
      if (s && s.received > 0) break;
      await sleep(80);
    }
    const before = mgr.snapshot(t.taskId);
    check("cancel: 取消前已有进度", before?.received, (x) => x > 0);
    const r = mgr.cancel(t.taskId, "agent");
    check("cancel: 取消被受理", r.ok, (x) => x === true);
    const snap = await waitFinal(t.taskId);
    check("cancel: 终态为 canceled", snap?.state, (x) => x === "canceled");
    check("cancel: 没有假报 done", snap?.state, (x) => x !== "done");
    check("cancel: 正式文件未交付", snap && fs.existsSync(snap.filePath), (x) => x === false);
  }

  // ── 场景 7：两个 aria2 任务同时跑（dlcore 管并发，aria2 不能把它干晩着）──
  {
    mgr.applyConfig({ maxConcurrent: 2 });
    const a = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/slow-a.bin`, fileName: "conc-a.bin", saveDir: SAVE_DIR });
    const b = mgr.create({ url: `http://127.0.0.1:${SRC_PORT}/slow-b.bin`, fileName: "conc-b.bin", saveDir: SAVE_DIR });
    const [sa, sb] = [await waitFinal(a.taskId), await waitFinal(b.taskId)];
    check("并发: 任务 1 done", sa?.state, (x) => x === "done");
    check("并发: 任务 2 done", sb?.state, (x) => x === "done");
    check("并发: 两个都走 aria2", sa?.backend, (x) => x === "aria2");
    for (const s of [sa, sb]) {
      check(`并发: ${s?.fileName} SHA-256 与源一致`, s && fs.existsSync(s.filePath)
        ? crypto.createHash("sha256").update(fs.readFileSync(s.filePath)).digest("hex") : null,
        (x) => x === SHA);
    }
    mgr.applyConfig({ maxConcurrent: 1 });
  }

  // ── 场景 8：只关自己的实例（不误杀）──
  {
    const info = aria2Backend.instanceInfo();
    check("instance: 有端口", info.port, (x) => Number.isInteger(x) && x > 0);
    check("instance: 信息不含 secret", JSON.stringify(info), (x) => !x.toLowerCase().includes("secret"));
    await shutdownInstance();
    const after = aria2Backend.instanceInfo();
    check("instance: 关闭后 ready=false", after.ready, (x) => x === false);
    // 记录文件可以留着（下次靠 pid 判活），但进程必须真的没了
    check("instance: 关闭后端口释放", after.port, (x) => !x);
  }

  srv.close();
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 引擎可能还在刷盘 */ }
}
