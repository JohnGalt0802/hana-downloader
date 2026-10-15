// tests/tools/make-golden.mjs — 生成 tests/fixtures/cardview-golden.json（P0 · W4）
//
// 目的：P0 的回归基准必须是「改动前」的真实输出。本脚本从 git 一手源码
//   `git show main:ui/card.js`
// 机械提取原 render() 及其依赖（不做手抄），对 tests/fixtures/cardview-cases.json
// 的全部 fixture 生成 HTML 快照，冻结成 cardview-golden.json。
// 方法学参考 D:\HanakoWorks\_temp\extract-oracle.mjs（老哥复核脚本）。
//
// 复现（仓库根目录）：
//   node tests/tools/make-golden.mjs
// 产物：tests/fixtures/cardview-golden.json
//
// ⚠ 时间冻结：详情面板的「预计完成时刻」走 Date.now()，生成与比对若不冻结同一时刻，
//   跨分钟就会假差异。这里与 unit-cardview.mjs 统一冻结到 2026-10-15 20:58:00
//   （FIXED_NOW），快照即在该时刻下的确定性输出。
//
// ⚠ opts 约定：原 render() 的 expanded/allExpanded/retrying 来自模块级状态，默认全 false；
//   taskId 取自绑定。这里统一按「首帧默认态 + taskId 由 fixture 自带」生成：
//   { expanded:false, allExpanded:false, retrying:false, taskId: t.taskId || "" }。
//   比对时用同一组 opts，保证可比。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

// ── 冻结时钟（与 unit-cardview.mjs 一致）──
const FIXED_NOW = new Date(2026, 9, 15, 20, 58, 0).getTime();
const realNow = Date.now;
Date.now = () => FIXED_NOW;

// ── 取 git 一手源码 ──
const src = execFileSync("git", ["show", "main:ui/card.js"], { cwd: ROOT, encoding: "utf8" });

// 从声明处按花括号/方括号配平切出整段（含字符串/模板/注释/正则的跳过逻辑）
function sliceByBraces(startIdx) {
  let i = startIdx;
  while (i < src.length && src[i] !== "{" && src[i] !== "[") i += 1;
  const open = src[i];
  const close = open === "{" ? "}" : "]";
  const REGEX_ALLOW = "(,=:[!&|?{};+*-%^~<>\n";
  let depth = 0;
  let inStr = null, inTpl = false, esc = false, inLineComment = false, inBlockComment = false, inRegex = false, inCharClass = false;
  let lastSig = "";
  for (let j = i; j < src.length; j += 1) {
    const c = src[j], n = src[j + 1];
    if (inLineComment) { if (c === "\n") inLineComment = false; continue; }
    if (inBlockComment) { if (c === "*" && n === "/") { inBlockComment = false; j += 1; } continue; }
    if (inRegex) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === "[") { inCharClass = true; continue; }
      if (c === "]") { inCharClass = false; continue; }
      if (c === "/" && !inCharClass) inRegex = false;
      continue;
    }
    if (inStr) { if (esc) { esc = false; } else if (c === "\\") esc = true; else if (c === inStr) inStr = null; continue; }
    if (inTpl) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "`") inTpl = false; continue; }
    if (c === "/" && n === "/") { inLineComment = true; j += 1; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; j += 1; continue; }
    if (c === "/" && REGEX_ALLOW.includes(lastSig)) { inRegex = true; inCharClass = false; continue; }
    if (c === '"' || c === "'") { inStr = c; lastSig = c; continue; }
    if (c === "`") { inTpl = true; lastSig = c; continue; }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return src.slice(startIdx, j + 1); }
    if (!/\s/.test(c)) lastSig = c;
  }
  throw new Error("unbalanced at " + startIdx);
}
function grab(decl) {
  const idx = src.indexOf(decl);
  if (idx < 0) throw new Error("not found: " + decl);
  return sliceByBraces(idx);
}

// ── 定义明确的文本变换：render(t) → oracle(t, o)，只去宿主耦合 ──
let renderSrc = grab("function render(t) {");
renderSrc = renderSrc.replace(
  "function render(t) {",
  `function oracle(t, o) {
  const expanded = !!o.expanded;
  const allExpanded = !!o.allExpanded;
  const retrying = !!o.retrying;
  const taskId = o.taskId || "";`
);
renderSrc = renderSrc.replace(/^\s*currentTask = t;\s*$/m, "");
renderSrc = renderSrc.replace(/^\s*if \(terminal && !terminalReported\) \{[\s\S]*?\n\s*\}\s*$/m, "");
const cutAt = renderSrc.indexOf("  if (root.innerHTML !== html) root.innerHTML = html;");
if (cutAt < 0) throw new Error("tail marker not found");
renderSrc = renderSrc.slice(0, cutAt) + '\n  return html;\n}\n';
for (const bad of ["root.", "reportSize", "currentTask", "terminalReported", "document.", "window.", "hana.", "setTimeout"]) {
  if (renderSrc.includes(bad)) throw new Error("残留宿主耦合符号: " + bad);
}

// 组装 oracle 模块（含依赖：FINAL_STATES + 四个格式化函数；display 引用改绝对 file URL，
// 因为临时模块落在系统临时目录，相对路径无法回指仓库）
const displayURL = pathToFileURL(path.join(ROOT, "ui", "shared", "display.js")).href;
const mod = [
  `import { STAGE_TEXT, unitSuffix, isPkgTask, isCountTask } from ${JSON.stringify(displayURL)};`,
  grab("var FINAL_STATES ="),
  grab("function esc("),
  grab("function fmtBytes("),
  grab("function fmtDuration("),
  grab("function stateBadge("),
  renderSrc,
  "export { oracle };",
].join("\n\n");

// 落一个临时模块文件再 import（data: URL 下相对/绝对 import 均不受支持），用后即删
const tmpMod = path.join(tmpdir(), `hd-golden-oracle-${process.pid}.mjs`);
writeFileSync(tmpMod, mod, "utf8");
let oracle;
try {
  oracle = (await import(pathToFileURL(tmpMod).href)).oracle;
} finally {
  try { unlinkSync(tmpMod); } catch { /* 清不掉不影响生成 */ }
}

// ── 生成 golden ──
const { cases } = JSON.parse(readFileSync(path.join(ROOT, "tests", "fixtures", "cardview-cases.json"), "utf8"));
const goldenOpts = { expanded: false, allExpanded: false, retrying: false, taskId: "" };
const items = cases.map((c) => {
  const task = c.task;
  const opts = { ...goldenOpts, taskId: task.taskId || "" };
  return { id: c.id, desc: c.desc, opts, html: oracle(task, opts) };
});

const out = {
  note: "改动前基准：由 tests/tools/make-golden.mjs 从 git show main:ui/card.js 的 render() 机械提取后，对 cardview-cases.json 全部 fixture 冻结的 HTML 快照。时间冻结在 2026-10-15 20:58:00。opts 为各 fixture 首帧默认态（taskId 取 task.taskId）。",
  frozenNow: "2026-10-15T20:58:00+08:00",
  source: "main:ui/card.js",
  cases: items,
};
const OUT = path.join(ROOT, "tests", "fixtures", "cardview-golden.json");
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");

console.log("=== cardview-golden.json 生成完成 ===");
console.log("来源:", out.source, "· fixture 数:", items.length, "· 字节:", Buffer.byteLength(JSON.stringify(out), "utf8"));
for (const it of items) console.log("  ", it.id.padEnd(24), it.html.length, "chars");

Date.now = realNow;
