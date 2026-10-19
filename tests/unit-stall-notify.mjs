// tests/unit-stall-notify.mjs — 卡滞提醒的投递通道（2026-10-19 新增）
//
// 为什么单独测：2026-10-19 用户实测「一次下 3 个文件，聊天区冒出 6 个后台任务条目」
//（3 个「下载 x」+ 3 个「停滞提醒：x」），而 sdk.tasks 的 22 个成员里没有 remove，
// abort/cancel 只改状态、条目永久占着任务面。修法是把卡滞提醒从「宿主任务 + next-step」
// 换成「session:send-custom + triggerTurn」，前者不占任务条目。
//
// 这个文件钉住四件事（全部对 index.js 的 apply() 起一个假 SDK，不起引擎、不联网）：
//   1. download-file 仍然只建一条「下载 xxx」宿主任务，不再建「停滞提醒：xxx」
//   2. stalled/ 出现一个卡滞 → 走 sendCustom，triggerTurn === true
//   3. 一轮扫描里出现两个卡滞 → 只投一次 sendCustom，内容含两个任务
//   4. 重试通知（notifyRetryStarted）仍然是 triggerTurn === false（不无故唤醒）
//
// 用法（仓库根目录）：node tests/unit-stall-notify.mjs
// 退出码：全过为 0，任一失败为 1。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-stallnotify-test-"));
const DATA_DIR = path.join(BASE, "data");
fs.mkdirSync(path.join(DATA_DIR, "stalled"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "finished"), { recursive: true });
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });

const FAKE_SESSION = "C:\\fake\\sessions\\notify-test.jsonl";
const SESSION_ID = "sess-notify-test";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); }
  return false;
}

// ── 假 SDK：只实现 index.js 真正会碰到的面 ──────────────────────────
const taskCalls = [];          // sdk.tasks 的每次调用（用来断言「没建停滞任务」）
const sendCustoms = [];        // session:send-custom 的入参
const registeredTools = [];
const routeHandlers = { get: {}, post: {}, all: {} };

const fakeTasks = {
  async create(input) { taskCalls.push({ op: "create", input }); return { taskId: `host-${taskCalls.length}` }; },
  async complete(id, opt) { taskCalls.push({ op: "complete", id, opt }); },
  async cancel(id) { taskCalls.push({ op: "cancel", id }); },
  async abort(id, reason) { taskCalls.push({ op: "abort", id, reason }); },
  async fail(id, reason) { taskCalls.push({ op: "fail", id, reason }); },
};

const fakeFetch = async (url, init = {}) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const body = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (p === "/ping") return body({ ok: true });
  if (p === "/download") return body({ ok: true, taskId: "tool-t1", fileName: "tool.bin", saveDir: BASE, state: "running", filePath: path.join(BASE, "tool.bin") });
  if (p === "/retry") return body({ ok: true, taskId: "retry-t1", fileName: "retry.bin", sessionPath: FAKE_SESSION });
  return body({ ok: true });
};

const context = {
  dataDir: DATA_DIR,
  logger: { info() {}, error() {} },
  bus: {
    async request(verb, input) {
      if (verb === "session:send-custom") { sendCustoms.push(input); return { ok: true }; }
      if (verb === "session:list") return { sessions: [{ path: FAKE_SESSION, sessionId: SESSION_ID }] };
      return { ok: true };
    },
  },
  tools: {
    async register(def) { registeredTools.push(def); return { ready: Promise.resolve() }; },
  },
  hooks: {
    async onDecision() { return { ready: Promise.resolve() }; },
  },
  routes: {
    async register(cb) {
      const app = {
        all: (p, h) => { routeHandlers.all[p] = h; },
        get: (p, h) => { routeHandlers.get[p] = h; },
        post: (p, h) => { routeHandlers.post[p] = h; },
      };
      cb(app);
      return { ready: Promise.resolve() };
    },
  },
  runtime: {
    async list() { return []; },
    async start() { return { runtimeId: "rt-fake", state: "ready" }; },
    async get() { return { runtimeId: "rt-fake", state: "ready" }; },
    async stop() { return { ok: true }; },
  },
  network: { fetch: fakeFetch },
  sessions: {},
  tasks: fakeTasks,
  models: {},
  media: {},
  providers: {},
  storage: { global: {}, agent: () => ({}) },
};

// 启动首扫是 silent 的（存量卡滞不回放）。这里先放一个 13 小时前的陈旧文件：
// 它会被首扫删掉 —— 它消失就是「首扫已完成、watcher 已就位」的确定性信号。
const STALE_FILE = path.join(DATA_DIR, "stalled", "stale-probe.json");
fs.writeFileSync(STALE_FILE, JSON.stringify({ taskId: "stale", stalledAt: Date.now() - 13 * 60 * 60 * 1000 }));

const app = (await import("../index.js")).default;
try {
  await app.apply(context);
} catch (e) {
  fail++; console.log("FAIL: apply 抛错 =>", String(e?.message || e));
}

check("首扫已跑（陈旧 stalled 文件被清掉）", await until(() => !fs.existsSync(STALE_FILE), 5000), (x) => x === true);

// ════════════════════════════════════════════════════════════════════
// 1. download-file：只建「下载 xxx」，不再建「停滞提醒：xxx」
// ════════════════════════════════════════════════════════════════════
{
  const tool = registeredTools.find((t) => t?.name === "download-file");
  check("download-file 已注册", !!tool, (x) => x === true);
  const before = taskCalls.length;
  let res = null;
  try {
    res = await tool.execute({
      url: "http://127.0.0.1:1/tool.bin",
      context: { callToken: "tok-1", sessionPath: FAKE_SESSION, messageId: "m-1" },
    });
  } catch (e) {
    fail++; console.log("FAIL: download-file execute 抛错 =>", String(e?.message || e));
  }
  const created = taskCalls.slice(before).filter((c) => c.op === "create");
  check("download-file: 只建 1 条宿主任务（不是 2 条：下载 + 停滞提醒）", created.length, (x) => x === 1);
  check("download-file: 那条是「下载 xxx」（用户要看进度的正当用途，未误伤）",
    created[0]?.input?.label, (x) => typeof x === "string" && x.startsWith("下载 ") && x.includes("tool.bin"));
  check("download-file: 不再出现「停滞提醒：」条目",
    taskCalls.filter((c) => c.op === "create" && String(c?.input?.label || "").includes("停滞提醒")).length,
    (x) => x === 0);
  check("download-file: 返回里仍带宿主任务 id（会话通知没断）",
    res?.details?.download?.hostTaskId, (x) => typeof x === "string" && x.length > 0);
}

// ════════════════════════════════════════════════════════════════════
// 2. 一个卡滞 → 一次 sendCustom，triggerTurn === true
// ════════════════════════════════════════════════════════════════════
const F_ONE = path.join(DATA_DIR, "stalled", "t-one.json");
fs.writeFileSync(F_ONE, JSON.stringify({
  taskId: "t-one", fileName: "one.bin", received: 200, total: 1000000,
  sessionId: SESSION_ID, sessionPath: FAKE_SESSION, stalledAt: Date.now(),
}));
{
  const createdBefore = taskCalls.filter((c) => c.op === "create").length;
  check("单个卡滞：watcher 投递并删掉 stalled 文件", await until(() => !fs.existsSync(F_ONE)), (x) => x === true);
  const c = sendCustoms.at(-1) || {};
  check("单个卡滞：sendCustom 收到 1 条", sendCustoms.length, (x) => x >= 1);
  check("单个卡滞：triggerTurn === true（叫醒决策）", c.triggerTurn, (x) => x === true);
  check("单个卡滞：customType 仍是 download-stall", c.customType, (x) => x === "download-stall");
  check("单个卡滞：scope === 'all'（目标会话不属于本 App）", c.scope, (x) => x === "all");
  check("单个卡滞：目标 sessionId 正确", c.sessionId, (x) => x === SESSION_ID);
  check("单个卡滞：content 是字符串（宿主会读 .length）", c.content, (x) => typeof x === "string");
  check("单个卡滞：content 含任务 ID 与文件名", c.content, (x) => x.includes("t-one") && x.includes("one.bin"));
  check("单个卡滞：没为卡滞创建任何宿主任务", taskCalls.filter((c2) => c2.op === "create").length,
    (x) => x === createdBefore);
}

// ════════════════════════════════════════════════════════════════════
// 3. 一轮里两个卡滞 → 只投一次，内容含两个任务
// ════════════════════════════════════════════════════════════════════
const F_A = path.join(DATA_DIR, "stalled", "t-aa.json");
const F_B = path.join(DATA_DIR, "stalled", "t-bb.json");
fs.writeFileSync(F_A, JSON.stringify({
  taskId: "t-aa", fileName: "a.bin", received: 10, total: 100,
  sessionId: SESSION_ID, sessionPath: FAKE_SESSION, stalledAt: Date.now(),
}));
fs.writeFileSync(F_B, JSON.stringify({
  taskId: "t-bb", fileName: "b.bin", received: 20, total: 200,
  sessionId: SESSION_ID, sessionPath: FAKE_SESSION, stalledAt: Date.now(),
}));
{
  const before = sendCustoms.length;
  check("两个卡滞：两份 stalled 文件都被投递并删掉",
    await until(() => !fs.existsSync(F_A) && !fs.existsSync(F_B)), (x) => x === true);
  const delta = sendCustoms.slice(before);
  check("两个卡滞：只调一次 sendCustom（不是两条消息）", delta.length, (x) => x === 1);
  const msg = delta[0]?.content || "";
  check("两个卡滞：同一条内容里含两个任务 ID", msg, (x) => x.includes("t-aa") && x.includes("t-bb"));
  check("两个卡滞：同一条内容里含两个文件名", msg, (x) => x.includes("a.bin") && x.includes("b.bin"));
  check("两个卡滞：合并消息仍是 triggerTurn === true", delta[0]?.triggerTurn, (x) => x === true);
  check("两个卡滞：段落之间有空行（可读性）", msg, (x) => x.includes("\n\n"));
  check("两个卡滞：仍未为卡滞创建宿主任务",
    taskCalls.filter((c) => c.op === "create" && String(c?.input?.label || "").includes("停滞提醒")).length,
    (x) => x === 0);
}

// ════════════════════════════════════════════════════════════════════
// 4. 重试通知：triggerTurn 必须仍是 false（不无故唤醒）
// ════════════════════════════════════════════════════════════════════
{
  const handler = routeHandlers.post["/retry"];
  check("/retry 路由已注册", typeof handler === "function", (x) => x === true);
  const before = sendCustoms.length;
  try {
    await handler({
      req: { json: async () => ({}) },
      json: (o) => ({ body: o }),
    });
  } catch (e) {
    fail++; console.log("FAIL: /retry 处理抛错 =>", String(e?.message || e));
  }
  await until(() => sendCustoms.length > before, 3000);
  const delta = sendCustoms.slice(before);
  check("重试发起：投了一条通知", delta.length, (x) => x >= 1);
  check("重试发起：triggerTurn === false（不能无故唤醒）", delta[0]?.triggerTurn, (x) => x === false);
  check("重试发起：customType 是 retry-note", delta[0]?.customType, (x) => x === "retry-note");
  // 顺带钉住反向约束：全仓唯一为 true 的只有 download-stall
  const triggerTrue = sendCustoms.filter((c) => c.triggerTurn === true);
  check("所有 triggerTurn=true 的投递都属于卡滞提醒", triggerTrue.map((c) => c.customType),
    (x) => x.length > 0 && x.every((t) => t === "download-stall"));
}

console.log(`\n=== stall-notify: ${pass} passed, ${fail} failed ===`);
// 这里有 watcher 的 1s 定时器、settleWhenDone / retry 守望的长轮询，不硬退出就退不掉。
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
