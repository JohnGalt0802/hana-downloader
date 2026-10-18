// tests/unit-contract.mjs — 契约兜底的离线单测（2026-10-18 整改）
//
// 钉住的四件事，全部对应「字段丢失 / 乱码当成功 / undefined 字面量」这类事故：
//   1. summarizeTask：/list 与 finished / stalled 落盘共用的摘要，字段集必须覆盖管理器用到的全部字段，
//      且 percent / stalled / speed 的口径与 dlcore.snapshot() 一致（两者被 UI 同一套代码消费）。
//   2. parseEngineResponse：引擎回非 JSON 时必须给结构化错误，绝不把裸字符串交给调用方。
//   3. displayNameOf：任意入参组合都不产出 undefined（`下载 undefined` 的源头）。
//   4. renderCardHTML 的 stateBadge / badgeState：状态缺失时不能渲染出字面量 "undefined"。
//
// 用法（仓库根目录）：node tests/unit-contract.mjs
// 退出码：全过为 0，任一失败为 1。
import { summarizeTask, percentOf } from "../engine/summary.js";
import { parseEngineResponse, asText } from "../engine/ipc-contract.js";
import { displayNameOf } from "../ui/shared/display.js";
import { renderCardHTML } from "../ui/shared/cardview.js";
import { DEFAULTS } from "../ui/shared/theme.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

// ════════════════════════════════════════════════════════════════════
// 1. summarizeTask：/list 必须带上管理器读的每一个字段
// ════════════════════════════════════════════════════════════════════
// 管理器（ui/manager.js）真正读的字段集：
const MANAGER_FIELDS = [
  "taskId", "state", "fileName", "url", "filePath", "error", "note",
  "unit", "stage", "stageDetail", "percent", "speed", "elapsed", "queued",
  "kind", "cmdType", "total", "received", "startedAt", "finishedAt",
  "sessionPath", "sessionId", "stalled",
];

// 快照形态（mgr.list() 的产物：cmdType / percent / stalled 布尔齐备）
const snapForm = {
  taskId: "t-snap", url: "https://example.com/a.bin", fileName: "a.bin",
  filePath: "D:\\dl\\a.bin", state: "running", queued: false,
  canceledBy: null, stalled: false, stalledAt: null,
  total: 1048576, received: 524288, speed: 131072.7, percent: 50,
  startedAt: 1700000000000, finishedAt: null, elapsed: 5000,
  error: null, kind: "url", cmd: null, cmdType: null, unit: "bytes",
  stage: "downloading", stageDetail: null, note: null,
  sessionId: "sess-1", sessionPath: "C:\\s\\a.jsonl",
  saveDir: "D:\\dl", speedLimit: 0,
};

// 原始任务形态（mgr.onFinal / onStall 直接给 task：没有 percent，只有 cmd.type）
const rawForm = {
  taskId: "t-raw", url: undefined, fileName: "repo",
  filePath: "D:\\work\\repo", state: "done", queued: false,
  total: 68, received: 68, speed: 0,
  startedAt: 1700000000000, finishedAt: 1700000060000, elapsed: 60000,
  error: null, kind: "command", cmd: { type: "git-clone" }, unit: "objects",
  stage: null, stageDetail: null, note: null,
  sessionId: "sess-2", sessionPath: "C:\\s\\b.jsonl", stalledAt: null,
};

for (const [label, t] of ["快照形态", "原始任务形态"].map((n, i) => [n, i === 0 ? snapForm : rawForm])) {
  const s = summarizeTask(t);
  const missing = MANAGER_FIELDS.filter((f) => !(f in s));
  check(`${label}: 字段齐全（缺 ${missing.join(",") || "无"}）`, missing.length, (x) => x === 0);
  check(`${label}: 不是 null`, s, (x) => x && typeof x === "object");
  check(`${label}: 序列化后不含 undefined 键值`, JSON.stringify(s), (x) => !x.includes("undefined"));
  // 序列化不吞键：Object.keys 与 JSON.parse(JSON.stringify()) 的键数必须相等。
  // 这比逐个字段断言更能防回归——只要有任何字段是 undefined（JSON 会整键丢掉），这里就红。
  check(`${label}: JSON 序列化不吞键`, s, (x) => Object.keys(JSON.parse(JSON.stringify(x))).length === Object.keys(x).length);
}

// summarizeTask 是**对外契约的收口点**：上游给什么都要能出完整对象，不能依赖调用方补字段。
// 这几个输入都是「缺一大堆字段」的形态（manager 的记录可能来自老版本 tasks.json）。
{
  const sparse = [
    { taskId: "s1" },
    { taskId: "s2", state: "running" },
    { taskId: "s3", fileName: undefined, url: undefined, state: null },
    { taskId: "s4", total: null, received: null, speed: null, elapsed: null },
    { taskId: "s5", cmd: null, note: undefined, error: "" },
    { taskId: "s6", stalled: undefined, stalledAt: undefined, queued: undefined },
  ];
  for (const t of sparse) {
    const s = summarizeTask(t);
    const keys = Object.keys(s);
    const round = Object.keys(JSON.parse(JSON.stringify(s)));
    check(`缺字段输入 ${t.taskId}: 序列化键数不变（${keys.length}）`, keys.length, (x) => x === round.length);
    check(`缺字段输入 ${t.taskId}: 无 undefined 值`, keys.filter((k) => s[k] === undefined), (x) => x.length === 0);
    check(`缺字段输入 ${t.taskId}: JSON 文本无 undefined 字面量`, JSON.stringify(s), (x) => !x.includes("undefined"));
  }
  // fileName 是本轮修的那个：缺了要给 null，不能给 undefined（否则 JSON 里整个键消失）
  check("缺 fileName → null（键保留）", summarizeTask({ taskId: "s7" }),
    (x) => x.fileName === null && "fileName" in x && Object.keys(JSON.parse(JSON.stringify(x))).includes("fileName"));
  // taskId 刻意不兜底：缺失就应当看得见（见 summary.js 的注释）
  check("缺 taskId → 保持 undefined（不静默兜底，主键缺失要暴露）", summarizeTask({}),
    (x) => x.taskId === undefined);
}

{
  const s = summarizeTask(snapForm);
  check("快照: percent 与 total/received 现算一致", s.percent, (x) => x === 50);
  check("快照: unit/stage 原样带出", s, (x) => x.unit === "bytes" && x.stage === "downloading");
  check("快照: speed 取整", s.speed, (x) => x === 131073);
  check("快照: elapsed/startedAt/finishedAt", s,
    (x) => x.elapsed === 5000 && x.startedAt === 1700000000000 && x.finishedAt === null);
  check("快照: stalled 布尔", s.stalled, (x) => x === false);

  // 关键回归：git/pnpm 的计数不能丢（否则管理器把对象数当字节）
  const r = summarizeTask(rawForm);
  check("任务形态: unit=objects 带出（计数型不再按字节显示）", r.unit, (x) => x === "objects");
  check("任务形态: cmdType 从 cmd.type 取", r.cmdType, (x) => x === "git-clone");
  check("任务形态: kind=command", r.kind, (x) => x === "command");
  check("任务形态: percent 现算 68/68 = 100", r.percent, (x) => x === 100);
  check("任务形态: url 缺失给 null（不让键消失）", r, (x) => x.url === null && "url" in x);
  check("任务形态: elapsed 带出", r.elapsed, (x) => x === 60000);
}

// percentOf 是全仓唯一的百分比口径（snapshot 与摘要都调它）。
// 断言逐条对着**改造前 snapshot 的内联算法**写，改了就是漂移。
{
  const legacy = (t) => {
    const p = t.total ? Math.min(100, (t.received / t.total) * 100) : null;
    return p == null ? null : Math.round(p * 10) / 10;
  };
  const cases = [
    { total: 3, received: 1 },
    { total: 100, received: 250 },      // 超量 → 封顶 100
    { total: 1048576, received: 524288 },
    { total: null, received: 10 },      // 无 total → null
    { total: 0, received: 10 },         // total=0 也算「无 total」
    { total: undefined, received: 10 },
    { total: 7, received: 2 },          // 小数
    { total: 1, received: 1 },
    { total: 1000, received: 1 },
    { total: 3, received: 2 },
    {},
  ];
  let diff = 0;
  for (const c of cases) {
    if (percentOf(c) !== legacy(c)) { diff += 1; console.log("  percent 差异:", JSON.stringify(c), percentOf(c), legacy(c)); }
  }
  check(`percentOf 与改造前 snapshot 算法逐例一致（${cases.length} 例）`, diff, (x) => x === 0);
  check("percentOf: 超量夹到 100", percentOf({ total: 100, received: 250 }), (x) => x === 100);
  check("percentOf: total=0 → null（不能除零）", percentOf({ total: 0, received: 10 }), (x) => x === null);
  check("percentOf: total=null → null", percentOf({ total: null, received: 10 }), (x) => x === null);
  // 收口后的行为：不再读 t.percent（否则同一份数据有两个真相源）
  check("percentOf: 忽略入参自带的 percent（口径单一）", percentOf({ percent: 12.5, total: 0, received: 0 }), (x) => x === null);
  check("percentOf: 自带 percent 与现算打架时以现算为准", percentOf({ percent: 99, total: 4, received: 2 }), (x) => x === 50);
  check("percentOf: 空对象不抛", percentOf({}), (x) => x === null);
  check("percentOf: received 非数值 → null（不产出 NaN）", percentOf({ total: 100 }), (x) => x === null);
}

// 与 snapshot 的一致性：同一条原始任务，两条路算出的 percent 必须相同
{
  const fake = { total: 7, received: 2 };
  const viaSnapshot = Math.round(Math.min(100, (fake.received / fake.total) * 100) * 10) / 10;
  check("percent 口径与 snapshot 一致", percentOf(fake), (x) => x === viaSnapshot);
}

check("summarizeTask(null) → null", summarizeTask(null), (x) => x === null);

// ════════════════════════════════════════════════════════════════════
// 2. parseEngineResponse：非 JSON 一律结构化错误
// ════════════════════════════════════════════════════════════════════
{
  const r = parseEngineResponse("<html>502 Bad Gateway</html>");
  check("非 JSON: ok=false", r.ok, (x) => x === false);
  check("非 JSON: 带 error 且截断到 200 字符", r.error, (x) => typeof x === "string" && x.startsWith("engine non-JSON: ") && x.length <= 200 + 18);
  check("非 JSON: 不返回裸字符串", r, (x) => typeof x === "object" && x !== null);
  check("空串: 结构化错误", parseEngineResponse(""), (x) => x && x.ok === false);
  check("合法 JSON 对象: 原样返回", parseEngineResponse('{"ok":true,"taskId":"t1"}'), (x) => x.ok === true && x.taskId === "t1");
  check("合法 JSON null: 不当对象交给调用方", parseEngineResponse("null"), (x) => x.ok === false);
  check("合法 JSON 数组: 不当对象交给调用方", parseEngineResponse("[1,2]"), (x) => x.ok === false);
  check("合法 JSON 标量: 不当对象交给调用方", parseEngineResponse("42"), (x) => x.ok === false);
  check("非字符串入参（Buffer 形态）不抛", parseEngineResponse(Buffer.from('{"ok":true}')), (x) => x.ok === true);

  // 事故复现：旧实现返回裸字符串，调用方 r.ok 是 undefined（"乱码当成功"）
  const legacy = (() => { try { return JSON.parse("garbage"); } catch { return "garbage"; } })();
  const fixed = parseEngineResponse("garbage");
  check("事故复现: 旧路径下 r.ok === undefined", legacy.ok, (x) => x === undefined);
  check("事故复现: 新路径下 r.ok === false", fixed.ok, (x) => x === false);
}

// ════════════════════════════════════════════════════════════════════
// 3. asText / displayNameOf：模型可见文本恒为字符串
// ════════════════════════════════════════════════════════════════════
{
  check("asText(null) === ''", asText(null), (x) => x === "");
  check("asText(undefined) === ''", asText(undefined), (x) => x === "");
  check("asText(对象) 得字符串", asText({ a: 1 }), (x) => x === "[object Object]");
  check("asText(0) === '0'", asText(0), (x) => x === "0");
  check("asText(字符串) 原样", asText("x"), (x) => x === "x");
}

{
  const combos = [
    [],
    [undefined],
    [null],
    ["", ""],
    [undefined, null, ""],
    [{ a: 1 }, [], false],
    [undefined, "a.bin"],
    ["a.bin", "b.bin"],
    [0],
    [123],
    ["  "],
  ];
  for (const c of combos) {
    const v = displayNameOf(...c);
    check(`displayNameOf(${JSON.stringify(c)}) 是字符串且非 undefined`, v,
      (x) => typeof x === "string" && x.length > 0 && !x.includes("undefined"));
  }
  check("displayNameOf: 取第一个非空", displayNameOf(undefined, "", "a.bin", "b.bin"), (x) => x === "a.bin");
  check("displayNameOf: 全空给固定兜底", displayNameOf(), (x) => x === "未命名任务");
  check("displayNameOf: 去首尾空白", displayNameOf("  a.bin  "), (x) => x === "a.bin");
}

// ════════════════════════════════════════════════════════════════════
// 4. cardview：stateBadge / badgeState 不得渲染出 "undefined"
// ════════════════════════════════════════════════════════════════════
{
  const minimalTheme = { id: "minimal", layout: { ...DEFAULTS.layout } };
  const states = [undefined, null, "", "running", "pending", "done", "failed", "canceled", "interrupted", "weird-state"];
  for (const s of states) {
    const t = { taskId: "t-x", fileName: "x.bin", received: 0, total: null, state: s };
    const html = renderCardHTML(t, minimalTheme, { taskId: "t-x" });
    check(`cardview state=${JSON.stringify(s)}: 输出无字面量 undefined`, html,
      (x) => typeof x === "string" && !x.includes("undefined"));
    check(`cardview state=${JSON.stringify(s)}: class 不含 b-undefined`, html, (x) => !x.includes("b-undefined"));
  }
  // 状态缺失时徽标落「未知」，class 落 b-unknown
  const noState = renderCardHTML({ taskId: "t-y", fileName: "y.bin" }, minimalTheme, { taskId: "t-y" });
  check("cardview 无 state: 徽标为「未知」", noState, (x) => x.includes(">未知</span>"));
  check("cardview 无 state: class 为 b-unknown", noState, (x) => x.includes("b-unknown"));
  // 最简任务（什么都没有）也不能炸
  const bare = renderCardHTML({ taskId: "t-z" }, minimalTheme, { taskId: "t-z" });
  check("cardview 空任务: 无 undefined", bare, (x) => typeof x === "string" && !x.includes("undefined"));
}

// ════════════════════════════════════════════════════════════════════
// 5. 集成：真内核 + /list 那条链路（mgr.list() → summarizeTask）
//    纯函数测完了还不够——事故正是「真实 snapshot 有字段、summarize 又把它丢了」。
//    这里起一个本地 HTTP 源、真跑一次下载，然后按 /list 的做法取摘要，确认字段都在。
// ════════════════════════════════════════════════════════════════════
{
  const http = await import("node:http");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { getTaskManager } = await import("../engine/dlcore.js");

  const BASE = path.join(os.tmpdir(), "hd-contract-test");
  const DATA_DIR = path.join(BASE, "data");
  const SAVE_DIR = path.join(BASE, "out");
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(SAVE_DIR, { recursive: true });

  const BODY = Buffer.alloc(4096, 7);
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(BODY.length) });
    res.end(BODY);
  });
  await new Promise((r) => srv.listen(18993, "127.0.0.1", r));

  const mgr = getTaskManager(DATA_DIR);
  const created = mgr.create({ url: "http://127.0.0.1:18993/small.bin", fileName: "small.bin", saveDir: SAVE_DIR });

  // 等终态（本地回环，毫秒级；上限 20s）
  let snap = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    snap = mgr.snapshot(created.taskId);
    if (snap && ["done", "failed", "canceled", "interrupted"].includes(snap.state)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  srv.close();

  check("集成: 下载完成", snap?.state, (x) => x === "done");

  // 照 /list 的写法取摘要
  const listed = (mgr.list() || []).map(summarizeTask);
  const row = listed.find((x) => x && x.taskId === created.taskId);
  check("集成 /list: 行存在", row, (x) => !!x);
  const missing = MANAGER_FIELDS.filter((f) => !(f in (row || {})));
  check(`集成 /list: 管理器字段齐全（缺 ${missing.join(",") || "无"}）`, missing.length, (x) => x === 0);
  check("集成 /list: unit=bytes", row?.unit, (x) => x === "bytes");
  check("集成 /list: percent=100（算出来的，不是 undefined）", row?.percent, (x) => x === 100);
  check("集成 /list: kind=url", row?.kind, (x) => x === "url");
  check("集成 /list: startedAt/finishedAt/elapsed 有值", row,
    (x) => typeof x.startedAt === "number" && typeof x.finishedAt === "number" && x.elapsed >= 0);
  check("集成 /list: received/total 对齐", row, (x) => x.total === 4096 && x.received === 4096);
  check("集成 /list: 与 snapshot 同语义（state/percent/unit 一致）", row && snap,
    (x) => x.state === snap.state && x.percent === snap.percent && x.unit === snap.unit);
  check("集成 /list: 序列化里无 undefined", JSON.stringify(listed), (x) => !x.includes("undefined"));

  fs.rmSync(BASE, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════
// 6. 引擎侧：/cancel 的响应形状必须能支撑消费方（index.js / 管理器）
//    旧形状 {ok:true, result} 让「半成品已保留供续传」永远不显示，
//    且任务不存在时顶层 ok 仍为 true → 工具谎报「已取消」。
// ════════════════════════════════════════════════════════════════════
{
  const httpMod = await import("node:http");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");

  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const BASE = path.join(os.tmpdir(), "hd-cancel-contract");
  const DATA_DIR = path.join(BASE, "data");
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const PORT = 18992;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 慢源：发一点数据就一直拉着，给取消留窗口
  const socks = new Set();
  const quiet = httpMod.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000000" });
    res.write(Buffer.alloc(1000));
    res.on("close", () => {});
  });
  quiet.on("connection", (s) => { socks.add(s); s.on("close", () => socks.delete(s)); });
  await new Promise((r) => quiet.listen(18991, "127.0.0.1", r));

  // 引擎用 stdio:ignore 起（不接管道）：管道在 kill 瞬间的撕裂是 libuv 在 Windows 上的
  // 已知断言源（`!(handle->flags & UV_HANDLE_CLOSING)`），会让测试进程带着非零码退出。
  // 就绪改用 HTTP /ping 探活，不依赖 stdout 的 READY 标记。
  const engine = spawn(process.execPath, [path.join(appRoot, "engine", "server.js"), DATA_DIR], {
    env: { ...process.env, HD_ENGINE_PORT: String(PORT) },
    stdio: "ignore",
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await sleep(100);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/ping`);
      const j = await res.json();
      ready = j?.ok === true;
    } catch { /* 还没起 */ }
  }
  check("引擎（/cancel 测试）起得来", ready, (x) => x === true);

  const api = async (p, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };

  if (ready) {
    const made = await api("/download", { url: "http://127.0.0.1:18991/slow.bin", fileName: "slow.bin" });
    check("下载已发起", made, (x) => x && x.ok === true && !!x.taskId);
    await sleep(300);

    const cancelled = await api("/cancel", { taskId: made.taskId, source: "agent" });
    check("/cancel: 顶层 ok=true", cancelled.ok, (x) => x === true);
    check("/cancel: result.ok=true", cancelled.result, (x) => !!x && x.ok === true);
    check("/cancel: 响应带 snap（否则 partPath 永远报不出来）", cancelled.snap, (x) => x && typeof x === "object" && x.taskId === made.taskId);
    check("/cancel: snap 带 partPath", cancelled.snap?.partPath, (x) => typeof x === "string" && x.length > 0);

    // 任务不存在：不能谎报已取消
    const ghost = await api("/cancel", { taskId: "no-such-task", source: "agent" });
    check("/cancel 不存在: 顶层 ok=false", ghost.ok, (x) => x === false);
    check("/cancel 不存在: result.ok=false", ghost.result, (x) => x && x.ok === false);
    check("/cancel 不存在: 带 error 文案", ghost.error, (x) => typeof x === "string" && x.length > 0);

    // /list 同样验一遍：字段齐全（服务端链路，非纯函数）
    const listed = await api("/list");
    const row = (listed.tasks || []).find((x) => x && x.taskId === made.taskId);
    check("/list: 行存在", row, (x) => !!x);
    const miss = MANAGER_FIELDS.filter((f) => !(f in (row || {})));
    check(`/list: 字段齐全（缺 ${miss.join(",") || "无"}）`, miss.length, (x) => x === 0);
    check("/list: 序列化无 undefined", JSON.stringify(listed), (x) => !x.includes("undefined"));
  }

  engine.kill();
  await new Promise((r) => { engine.on("exit", r); setTimeout(r, 3000); });
  for (const s of socks) { try { s.destroy(); } catch { /* 已断开 */ } }
  await new Promise((r) => quiet.close(r));
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 引擎可能还在刷盘 */ }}

// ════════════════════════════════════════════════════════════════════
// 7. dlcore 的退出码文案：code 为 null（信号杀死）时不能拼成「命令退出码 null」
//    这句会经 finished/*.json → 模型可见文本（源码级回归护栏）
// ════════════════════════════════════════════════════════════════════
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = fs.readFileSync(path.join(appRoot, "engine", "dlcore.js"), "utf8");
  check("dlcore: 有 code == null 分支", src, (x) => x.includes("code == null"));
  check("dlcore: 信号终止有人话文案", src, (x) => x.includes("进程被信号终止"));
  check("dlcore: 不再无条件拼「命令退出码 ${code}」", src, (x) => !x.includes("+ `命令退出码 ${code}`"));
}

console.log(`\n=== contract: ${pass} passed, ${fail} failed ===`);
// 不用 process.exit：Windows 上此刻还有内核留下的 socket/定时器在收尾，
// 硬退出会让 libuv 在关闭中的 handle 上命中断言（`!(handle->flags & UV_HANDLE_CLOSING)`）。
// 设 exitCode 让它自然退出即可。
process.exitCode = fail ? 1 : 0;
