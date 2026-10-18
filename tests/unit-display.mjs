// tests/unit-display.mjs — ui/shared/display.js 的离线单测（2026-09-20 新增）
//
// 为什么要测它：阶段文案、计数单位与「这是什么形态的任务」原本在 index.js / card.js /
// manager.js 各写一份，2026-09-19 改 pnpm 文案时两处都要动。收成一份之后，
// 这份断言就是三处共同的地基——它错了，三个面一起错，所以必须有网。
import {
  STAGE_TEXT, UNIT_NAME, stageLabel, unitSuffix, cmdTypeOf,
  isPkgTask, isCloneTask, isCountTask, isCmdTask, progressText, waitLineText,
} from "../ui/shared/display.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

// ── 表本身 ──
check("stage table: winget 四阶段在内", STAGE_TEXT, (x) => ["found", "downloading", "verifying", "installing"].every((k) => typeof x[k] === "string"));
check("stage table: git/pnpm 阶段在内", STAGE_TEXT, (x) => ["fetching", "enumerating", "resolving", "finalizing"].every((k) => typeof x[k] === "string"));
check("unit table", UNIT_NAME, (x) => x.objects === "对象" && x.files === "文件" && x.packages === "包");

// ── 取值函数 ──
check("stageLabel: 已知", stageLabel("verifying"), (x) => x === "校验哈希");
check("stageLabel: 未知回落原值", stageLabel("weird"), (x) => x === "weird");
check("stageLabel: 空值", stageLabel(null), (x) => x === "");
check("unitSuffix: 包", unitSuffix("packages"), (x) => x === " 包");
check("unitSuffix: 字节型为空", unitSuffix("bytes"), (x) => x === "");
check("unitSuffix: 空值", unitSuffix(undefined), (x) => x === "");

// ── 形态判定：兼容快照（cmdType）与任务对象（cmd.type）两种形态 ──
check("cmdTypeOf: 快照形态", cmdTypeOf({ cmdType: "pip-install" }), (x) => x === "pip-install");
check("cmdTypeOf: 任务形态", cmdTypeOf({ cmd: { type: "winget-install" } }), (x) => x === "winget-install");
check("cmdTypeOf: 空对象", cmdTypeOf({}), (x) => x === null);
check("cmdTypeOf: null", cmdTypeOf(null), (x) => x === null);

check("isPkgTask: winget", isPkgTask({ cmdType: "winget-install" }), (x) => x === true);
check("isPkgTask: pip", isPkgTask({ cmd: { type: "pip-install" } }), (x) => x === true);
check("isPkgTask: 普通下载为假", isPkgTask({ unit: "bytes" }), (x) => x === false);
check("isCloneTask", isCloneTask({ cmdType: "git-clone" }), (x) => x === true);
check("isCmdTask: pnpm 为真", isCmdTask({ cmdType: "pnpm-install" }), (x) => x === true);
check("isCmdTask: winget 为假", isCmdTask({ cmdType: "winget-install" }), (x) => x === false);
check("isCountTask: packages", isCountTask({ unit: "packages" }), (x) => x === true);
check("isCountTask: bytes 为假", isCountTask({ unit: "bytes" }), (x) => x === false);
check("isCountTask: 缺 unit 为假", isCountTask({}), (x) => x === false);

// ── 文案：包安装走阶段 ──
check("pkg: 有阶段", progressText({ cmdType: "winget-install", stage: "downloading" }), (x) => x === "阶段：下载中");
check("pkg: 无阶段 → null", progressText({ cmdType: "pip-install" }), (x) => x === null);

// ── 文案：计数型 ──
check("count: 完成态（工具面）", progressText({ unit: "packages", state: "done", received: 68, total: 68 }, { doneText: true }), (x) => x === "完成：68/68 包");
check("count: 有明细走明细", progressText({ unit: "objects", state: "running", received: 3, total: 9, stageDetail: "接收中 3/9" }), (x) => x === "进度：接收中 3/9");
check("count: 无明细拼计数", progressText({ unit: "packages", state: "running", received: 12, total: 68 }), (x) => x === "进度：12/68 包");
check("count: total 未知", progressText({ unit: "objects", state: "running", received: 7 }), (x) => x === "进度：7 对象");
check("count: doneText 但未终态仍写进度", progressText({ unit: "packages", state: "running", received: 1, total: 2 }, { doneText: true }), (x) => x === "进度：1/2 包");

// ── 文案：字节型 ──
check("bytes: 有总量", progressText({ unit: "bytes", state: "running", received: 512, total: 1024 }), (x) => x === "进度：50%（512/1024 字节）");
check("bytes: 无总量", progressText({ received: 512 }), (x) => x === "已下载：512 字节");
check("null 任务", progressText(null), (x) => x === null);
// 数值守卫（2026-10-18）：received 非数值时不能输出「进度：NaN%（undefined/100 字节）」
check("bytes: received 缺失不产出 NaN", progressText({ unit: "bytes", state: "running", total: 100 }),
  (x) => typeof x === "string" && !x.includes("NaN") && !x.includes("undefined"));
check("bytes: received=null 不产出 NaN", progressText({ unit: "bytes", state: "running", total: 100, received: null }),
  (x) => typeof x === "string" && !x.includes("NaN"));
check("bytes: received 正常时输出不变（守卫不改变既有语义）",
  progressText({ unit: "bytes", received: 512, total: 1024 }), (x) => x === "进度：50%（512/1024 字节）");

// ── progressText 返回 null 的三种场景（设计契约，给 UI 用：null = 这一行不渲染）──
// 2026-10-18 事故回归：这三条 null 一旦被工具面当成字符串用，content[].text 就是 null，
// 宿主读 .length 直接抛 `Cannot read properties of null (reading 'length')`，会话当场断。
check("null 契约 1/3: pip-install + stage=null → null", progressText({ cmdType: "pip-install", stage: null, state: "running", unit: "bytes" }, { doneText: true }), (x) => x === null);
check("null 契约 2/3: winget-install + stage 缺省 → null", progressText({ cmdType: "winget-install", state: "running" }, { doneText: true }), (x) => x === null);
check("null 契约 3/3: task 为 null → null", progressText(null, { doneText: true }), (x) => x === null);

// ── waitLineText：工具面专用，恒为字符串（模型可见的 content[].text）──
const isStr = (x) => typeof x === "string" && x.length > 0;
check("waitLineText: pip + stage=null 是字符串", waitLineText({ cmdType: "pip-install", stage: null, state: "running" }), isStr);
check("waitLineText: pip + stage=null 给的是人话", waitLineText({ cmdType: "pip-install", stage: null, state: "running" }), (x) => x === "进行中：暂无可报进度");
check("waitLineText: winget + stage 缺省", waitLineText({ cmdType: "winget-install", state: "running" }), (x) => x === "进行中：暂无可报进度");
check("waitLineText: snap=null 不出现 undefined/null", waitLineText(null), (x) => isStr(x) && !/undefined|null/.test(x));
check("waitLineText: snap=undefined", waitLineText(undefined), (x) => isStr(x) && !/undefined|null/.test(x));
check("waitLineText: 非对象入参", waitLineText("oops"), isStr);
check("waitLineText: 数组入参", waitLineText([]), isStr);
check("waitLineText: 空快照（引擎只回 {}）不冒充进度", waitLineText({}), (x) => x === "快照缺失：暂无进度可报");
check("waitLineText: 只有状态也能出字符串", waitLineText({ state: "pending" }), (x) => isStr(x) && !/undefined|null/.test(x));
check("waitLineText: 有阶段照常报阶段", waitLineText({ cmdType: "pip-install", stage: "installing", state: "running" }), (x) => x === "阶段：安装中");
check("waitLineText: 终态带状态前缀", waitLineText({ unit: "bytes", state: "done", received: 1024, total: 1024 }), (x) => x === "done｜进度：100%（1024/1024 字节）");
check("waitLineText: 错误仍报错误", waitLineText({ cmdType: "pip-install", stage: null, state: "failed", error: "pip exited 1" }), (x) => x.includes("错误：pip exited 1"));
check("waitLineText: 错误 + 未知状态", waitLineText({ state: "failed", error: "boom" }), (x) => isStr(x) && x.includes("boom"));
check("waitLineText: 计数型跑通", waitLineText({ cmdType: "pnpm-install", unit: "packages", state: "running", received: 12, total: 68 }), (x) => x === "进度：12/68 包");

// 全形态扫描：任何输入都不得产出非字符串（这就是宿主侧的崩溃面）
const SNAPS = [
  null, undefined, 0, "", "x", [], {},
  { state: "running", cmdType: "pip-install", stage: null },
  { state: "running", cmdType: "winget-install", stage: null },
  { state: "pending", cmdType: "git-clone" },
  { state: "done" }, { state: "failed" }, { state: "canceled", error: null },
  { state: "running", unit: "bytes", received: 0, total: 0 },
  { state: "running", unit: "objects", received: null, total: null },
  { state: "running", error: "x" },
];
check("waitLineText: 全形态扫描均为非空字符串", SNAPS.map((s) => waitLineText(s)), (arr) => arr.every(isStr));
check("waitLineText: 全形态扫描无 undefined 污染", SNAPS.map((s) => waitLineText(s)), (arr) => arr.every((x) => !x.includes("undefined") && !x.includes("null")));

console.log(`\n=== display: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
