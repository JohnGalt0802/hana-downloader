// tests/unit-cardview.mjs — ui/shared/cardview.js 的离线单测（P0 · W2，2026-10-15）
//
// 验收硬标准：把「原版逻辑的 oracle」（从 ui/card.js 现有 render() 复制拼接部分，
// 仅去掉最后写 DOM 的两行）与 renderCardHTML(t, minimalTheme, opts) 的输出
// 逐字节比对（严格 ===）。任何差异都打印行级明细。
//
// 为什么 oracle 要在这里手抄一份而不是 import：render() 是卡片模块内的私有函数，
// 且与 DOM/宿主强耦合（无法在 Node 侧 import）。等价于 P0 的「金标准」——
// 它一旦被改动，比对就失去意义，所以本文件里的 oracle 按当日 main 逐字抄录。
//
// 用法（仓库根目录）：node tests/unit-cardview.mjs
// 退出码：全过为 0，任一失败为 1。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCardHTML } from "../ui/shared/cardview.js";
import { STAGE_TEXT, unitSuffix, isPkgTask, isCountTask } from "../ui/shared/display.js";
import { DEFAULTS, resolveTheme } from "../ui/shared/theme.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── 固定 Date.now：oracle 与实现在详情面板的「预计完成时刻」上会各调一次 Date.now，
//    若不冻结，跨分钟边界时两次调用可能落在不同分钟，造成假差异。冻结后比对是真确定的。
const FIXED_NOW = new Date(2026, 9, 15, 20, 58, 0).getTime();
const realNow = Date.now;
Date.now = () => FIXED_NOW;

// ════════════════════════════════════════════════════════════════════════
//  oracle —— 以下四段格式化函数 + oracle() 逐字复制自当日 ui/card.js 的 render() 及其依赖，
//  唯一改动：模块级 expanded/allExpanded/retrying/taskId 改由 opts 传入；
//  删去末尾 `if (root.innerHTML !== html) root.innerHTML = html;` 与 `reportSize();` 两行。
// ════════════════════════════════════════════════════════════════════════

const FINAL_STATES = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n; let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + units[i];
}

function fmtDuration(sec) {
  if (sec < 60) return Math.max(1, Math.round(sec)) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return (sec / 3600).toFixed(1) + "h";
}

function stateBadge(s) {
  return { running: "下载中", pending: "准备中", done: "完成", failed: "失败", canceled: "已取消", interrupted: "已中断", stalled: "停滞" }[s] || s;
}

function oracle(t, o) {
  if (!t) return "";
  const expanded = !!o.expanded;
  const allExpanded = !!o.allExpanded;
  const retrying = !!o.retrying;
  const taskId = o.taskId || "";

  const state = t.state;
  const running = state === "running";
  const pending = state === "pending";
  const done = state === "done";
  const terminal = done || state === "failed" || state === "canceled" || state === "interrupted";
  // winget / pip 是阶段式任务：输出里没有百分比与字节数据，数字区按需收起（2026-09-18）
  const pkgTask = isPkgTask(t);
  const pct = t.percent;
  const known = t.total != null && t.total > 0;
  // 计数型单位（objects / packages / files）在 total 未知时不报 100%：分母本来就不存在（2026-09-19）
  const pctText = done
    ? (known || !isCountTask(t) ? "100%" : "—")
    : (known ? (pct == null ? "0" : pct.toFixed(pct >= 100 ? 0 : 1)) + "%" : "—");
  const unit = t.unit;
  const sizeText = pending ? "—" : isCountTask(t)
    ? (t.received != null ? t.received : 0) + (known ? "/" + t.total : "") + unitSuffix(unit)
    : (done && known ? fmtBytes(t.total) : fmtBytes(t.received) + (known ? "/" + fmtBytes(t.total) : ""));
  const speedText = running && t.speed > 0 ? fmtBytes(t.speed) + "/s" : "";

  let etaText = "";
  if (running && known && t.speed > 0) {
    etaText = "剩" + fmtDuration(Math.max(0, (t.total - t.received) / t.speed));
  }

  const badge = stateBadge(state);
  const badgeState = state === "running" && t.stalled ? "stalled" : state;
  const barClass = "dl-bar"
    + (pending || (!known && !terminal) ? " indet" : "")
    + (done ? " done" : "")
    + (state === "failed" || state === "canceled" || state === "interrupted" ? " failed" : "");
  const barWidth = done ? 100 : (known && pct != null ? Math.min(100, pct) : 0);
  const filePath = t.filePath || "";

  // 2026-09-17：速度从 meta 里移出，与百分比/大小合成「数据组」，统一放到进度条上面那行。
  const metaParts = [];
  if (t.stalled && !terminal) metaParts.push("连接停滞，等待 Agent 决策");
  if (etaText) metaParts.push(etaText);
  if (pending) metaParts.push(t.queued ? "排队中…" : "准备中…");
  // 计数型任务（pnpm 等）：优先显示真实计数明细，没有明细才退回阶段名（2026-09-19）
  if (running && t.stageDetail) metaParts.push(t.stageDetail);
  else if (running && t.stage && STAGE_TEXT[t.stage]) metaParts.push(STAGE_TEXT[t.stage]);
  if (done && t.note) metaParts.push(t.note);
  const metaText = metaParts.join(" · ");

  let html = "";
  html += '<div class="dl' + (expanded ? " expanded" : "") + '">';
  html += '<div class="dl-row"><span class="dl-left">';
  html += '<button class="dl-fold' + (expanded ? " open" : "") + '" id="dl-fold" title="展开/收起详情">❯</button>';
  html += '<button class="dl-all' + (allExpanded ? " open" : "") + '" id="dl-all" title="展开/收起所有下载">□</button>';
  html += "</span>";
  html += '<span class="dl-badge b-' + badgeState + '">' + badge + "</span>";

  // 失败/中断原因：放在进度条上面那行（信息行）里，红色短文本，超长省略；
  // 全文在展开区的「状态」行。2026-09-14：原本独占卡片底部一行。
  const errText = (state === "failed" || state === "canceled" || state === "interrupted")
    ? (t.error || "下载失败") : "";
  // 信息行：错误优先、其次阶段/备注；与徽标文案重复时省略（如 winget 下载阶段两处都是「下载中」）；
  // 错误里的换行压成空格，避免撑破单行布局（全文仍在 title 里）
  let lineText = errText ? errText.replace(/\s*\n\s*/g, " ") : metaText;
  if (lineText === badge) lineText = "";
  if (lineText) {
    html += '<span class="dl-meta' + (errText ? " err" : "") + '"'
      + (errText ? ' title="' + esc(errText) + '"' : "") + ">" + esc(lineText) + "</span>";
  }

  // 进度数据组（百分比 · 已下载/总量 · 速度）：2026-09-17 从进度条右侧上移到这一行（进度条上面那行），
  // 紧邻操作按钮之前；进度条自己独占下面一行。
  html += '<span class="dl-progress-top">';
  // 阶段式任务（winget/pip）默认收起数字区；一旦有真实字节数据（下载探测到的进度）就照常显示
  if (!pkgTask || done || known) html += '<span class="dl-pct">' + esc(pctText) + "</span>";
  if (!pkgTask || known) html += '<span class="dl-size">' + esc(sizeText) + "</span>";
  if (speedText) html += '<span class="dl-speed">' + esc(speedText) + "</span>";
  html += "</span>";

  if (pending || running) {
    html += '<button class="dl-btn danger" id="dl-cancel">取消</button>';
  } else if (done) {
    if (pkgTask) {
      // winget / pip 没有可打开的产物：完成态不给打开按钮
    } else if (t.kind === "command") {
      html += '<button class="dl-btn primary" id="dl-folder" title="打开目标目录">打开文件夹</button>';
    } else {
      html += '<button class="dl-btn primary" id="dl-open">打开</button>'
        + '<button class="dl-btn" id="dl-folder" title="打开所在文件夹">文件夹</button>';
    }
  } else if (FINAL_STATES[t.state]) {
    // 终态（失败 / 取消 / 中断）给一个圈箭头重试（2026-09-21）。
    // 箭头转圈 = 已提交，等它翻身；停止由 poll 驱动，状态一变这个分支就不再走。
    html += '<button class="dl-btn ico retry' + (retrying ? " spinning" : "") + '" id="dl-retry"'
      + ' title="' + (retrying ? "重试中…" : "重试下载") + '"'
      + (retrying ? " disabled" : "")
      + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M21 12a9 9 0 1 1-3.2-6.9"/><polyline points="21 4 21 10 15 10"/></svg>'
      + "</button>";
  }
  html += "</div>";

  // 进度条独占一行（2026-09-17）：数据组已上移，这里只留条本身。
  html += '<div class="dl-row2">';
  html += '<div class="dl-track"><div class="' + barClass + '" style="width:' + barWidth + '%"></div></div>';
  html += "</div>";

  // 第三行已撤销（2026-09-14）：metaText 已并入上方信息行。

  html += '<div class="dl-detail">';
  html += '<div class="dl-d-row"><span class="dl-d-label">文件</span><span class="dl-d-value">' + esc(t.fileName || "—") + "</span></div>";
  if (filePath) html += '<div class="dl-d-row"><span class="dl-d-label">路径</span><span class="dl-d-value">' + esc(filePath) + "</span></div>";
  html += '<div class="dl-d-row"><span class="dl-d-label">操作</span><span class="dl-d-value">'
    + '<button class="dl-btn dl-copy" id="dl-copy">复制路径</button></span></div>';
  if (known) {
    const count = isCountTask(t);
    let sizeDetail = count
      ? t.total + unitSuffix(unit)
      : fmtBytes(t.total);
    if (running && t.received != null) {
      sizeDetail += (count ? "（已完成 " + t.received + "）" : "（已下载 " + fmtBytes(t.received) + "）");
    }
    // 计数型（packages/objects/files）的“大小”其实是计数，标签跟着改（2026-09-19）
    html += '<div class="dl-d-row"><span class="dl-d-label">' + (count ? "数量" : "大小") + '</span><span class="dl-d-value">' + esc(sizeDetail) + "</span></div>";
  }
  html += '<div class="dl-d-row"><span class="dl-d-label">任务</span><span class="dl-d-value">' + esc(t.taskId || taskId) + "</span></div>";
  html += '<div class="dl-d-row"><span class="dl-d-label">状态</span><span class="dl-d-value">' + esc(badge) + (metaText ? "（" + esc(metaText) + "）" : "") + "</span></div>";
  if (running && known && t.speed > 0 && t.received < t.total) {
    const remainSec = Math.max(0, (t.total - t.received) / t.speed);
    const etaAbs = new Date(Date.now() + remainSec * 1000);
    html += '<div class="dl-d-row"><span class="dl-d-label">预计</span><span class="dl-d-value">'
      + String(etaAbs.getHours()).padStart(2, "0") + ":" + String(etaAbs.getMinutes()).padStart(2, "0")
      + " 完成（剩" + fmtDuration(remainSec) + "）</span></div>";
  }
  html += "</div>";

  // 错误行已上移到信息行（2026-09-14），此处不再重复渲染。
  html += "</div>";

  return html;
}

// ════════════════════════════════════════════════════════════════════════
//  minimal 主题（等价取值，构造自任务书）
// ════════════════════════════════════════════════════════════════════════
const minimalTheme = {
  id: "minimal",
  name: "极简",
  layout: {
    fold: true,
    icon: "none",
    primary: "badge",
    fields: ["eta", "stage", "note"],
    fieldSep: " · ",
    progress: "row",
    progressWhenDone: true,
    density: "compact",
    actions: { active: ["cancel"], done: ["open", "folder"], failed: ["retry"] },
  },
};

// ── 断言框架 ──
let pass = 0, fail = 0;
const failures = [];
function ok(name) { pass++; }
function bad(name, detail) { fail++; failures.push({ name, detail }); console.log("FAIL:", name, "=>", detail); }

// 行级差异明细（供比对失败时定位）
function diffDetail(a, b) {
  const la = a.split("\n"), lb = b.split("\n");
  if (la.length !== lb.length) return `行数不同：oracle ${la.length} 行 / cardview ${lb.length} 行`;
  for (let i = 0; i < la.length; i++) {
    if (la[i] !== lb[i]) return `第 ${i + 1} 行不同：\n  oracle   : ${la[i]}\n  cardview : ${lb[i]}`;
  }
  // 行数相同、逐行相同却不等 → 只可能是不可见字符/长度差
  for (let i = 0; i < la.length; i++) {
    if (la[i].length !== lb[i].length) return `第 ${i + 1} 行长度不同：oracle ${la[i].length} / cardview ${lb[i].length}`;
  }
  return "逐行相同但整体不等（可能存在不可见字符差异）";
}

// ── 载入 fixture ──
const fixturePath = path.join(here, "fixtures", "cardview-cases.json");
const { cases } = JSON.parse(readFileSync(fixturePath, "utf8"));

console.log("=== cardview 纯函数单测（P0 · W2）===");
console.log(`fixture: ${cases.length} 例 · minimal 主题逐字节回归比对\n`);

const baseOpts = { expanded: false, allExpanded: false, retrying: false, taskId: "" };

for (const c of cases) {
  const task = c.task;
  const optsList = [{ label: "默认", opts: { ...baseOpts, taskId: task.taskId || "" } }];
  // 中断态额外跑一遍「重试中」，覆盖 retrying 分支
  if (task.state === "interrupted") {
    optsList.push({ label: "重试中", opts: { ...baseOpts, retrying: true, taskId: task.taskId || "" } });
  }
  // 展开态额外跑一遍（覆盖 expanded 分支，仅对首个用例，避免刷屏）
  if (c.id === "running-known") {
    optsList.push({ label: "展开", opts: { ...baseOpts, expanded: true, taskId: task.taskId || "" } });
  }

  for (const { label, opts } of optsList) {
    const tag = `${c.id} [${label}]`;

    // ① 逐字节比对：oracle vs cardview
    const exp = oracle(task, opts);
    const got = renderCardHTML(task, minimalTheme, opts);
    if (got === exp) ok(`${tag} 逐字节一致`);
    else bad(`${tag} 逐字节一致`, diffDetail(exp, got));

    // ② 结构断言（对默认态跑即可，避免同一期望被重复计）
    if (label !== "默认") continue;

    const ex = c.expect || {};
    if (ex.badge != null) {
      const expBadge = `>${ex.badge}</span>`;
      if (got.includes(expBadge)) ok(`${tag} 徽标签`); else bad(`${tag} 徽标签`, `未找到「${ex.badge}」徽标片段`);
    }
    for (const s of ex.contains || []) {
      if (got.includes(s)) ok(`${tag} 含「${s}」`);
      else bad(`${tag} 含片段`, `缺少：${s}`);
    }
    for (const s of ex.notContains || []) {
      if (!got.includes(s)) ok(`${tag} 不含「${s}」`);
      else bad(`${tag} 不应含片段`, `出现了：${s}`);
    }
  }
}

// ── 额外：density/fold 的差异化形状自检（不参与回归比对，仅确认分支落地）──
{
  const t = cases.find((x) => x.id === "done-url").task;
  const comfy = { ...minimalTheme, layout: { ...minimalTheme.layout, density: "comfortable" } };
  const h = renderCardHTML(t, comfy, baseOpts);
  if (h.includes('class="dl comfortable"')) ok("density=comfortable 加根类");
  else bad("density=comfortable 加根类", h.slice(0, 80));

  const noFold = { ...minimalTheme, layout: { ...minimalTheme.layout, fold: false } };
  const h2 = renderCardHTML(t, noFold, baseOpts);
  if (!h2.includes('id="dl-fold"') && !h2.includes("dl-detail")) ok("fold=false 无折叠与详情");
  else bad("fold=false 无折叠与详情", "仍出现折叠/详情元素");

  const noBar = { ...minimalTheme, layout: { ...minimalTheme.layout, progressWhenDone: false } };
  const h3 = renderCardHTML(t, noBar, baseOpts);
  if (!h3.includes("dl-track") && !h3.includes("dl-row2")) ok("progressWhenDone=false 完成态无进度条");
  else bad("progressWhenDone=false 完成态无进度条", "仍出现进度条");
}

// ════════════════════════════════════════════════════════════════════════
// (b) 第三腿一致性：cardview.js 内部缺省字面量 == theme.js 的 DEFAULTS.layout
//
// 为什么单列一腿：DEFAULTS 是「运行时兜底」，ui/themes/minimal/theme.json 是「审核与人读」，
// 而 cardview.js 里还藏着第三份同名缺省（L.fold !== false、L.fields 回落数组、actions 回落对象…）。
// 现有 unit-theme.mjs 只盯 theme.js ↔ theme.json 两腿，没人看 cardview 这条。
// 这里两条防线：
//   ① 行为等价：renderCardHTML(t, {}, opts) 走内部缺省，renderCardHTML(t, {layout: DEFAULTS.layout}, opts)
//      走 DEFAULTS，两者对同一输入必须逐字节一致（多 fixture × 多 opts 横扫）；
//   ② 字面扫描：对输出中不可观测的字段（density/fieldSep/actions 等）直接查源码字面量是否与 DEFAULTS 取值吻合。
// ════════════════════════════════════════════════════════════════════════
{
  const optSets = [
    { expanded: false, allExpanded: false, retrying: false, taskId: "" },
    { expanded: true, allExpanded: true, retrying: true, taskId: "X" },
  ];
  let mism = 0;
  for (const c of cases) {
    for (const o of optSets) {
      const internal = renderCardHTML(c.task, {}, o);
      const fromDefaults = renderCardHTML(c.task, { layout: DEFAULTS.layout }, o);
      if (internal !== fromDefaults) mism += 1;
    }
  }
  if (mism === 0) ok("第三腿: cardview 内部缺省与 DEFAULTS.layout 行为等价");
  else bad("第三腿: cardview 内部缺省与 DEFAULTS.layout 行为等价", `${mism} 处不一致`);

  // 字面扫描：DEFAULTS.layout 每个字段的取值都必须在 cardview 源码里以字面出现
  const cvSrc = readFileSync(path.join(here, "..", "ui", "shared", "cardview.js"), "utf8").replace(/\s+/g, " ");
  const literalChecks = [
    ["fold 默认 true", "L.fold !== false"],
    ["icon 默认 none", 'L.icon || "none"'],
    ["primary 默认 badge", 'L.primary || "badge"'],
    ["fields 默认 [eta,stage,note]", '["eta", "stage", "note"]'],
    ["fieldSep 默认 ·", 'L.fieldSep != null ? L.fieldSep : " · "'],
    ["progress 默认 row", 'L.progress || "row"'],
    ["progressWhenDone 默认 true", "L.progressWhenDone !== false"],
    ["actions 默认三组", '["cancel"], done: ["open", "folder"], failed: ["retry"]'],
  ];
  const missing = literalChecks.filter(([, lit]) => !cvSrc.includes(lit)).map(([name]) => name);
  if (missing.length === 0) ok("第三腿: cardview 缺省字面量与 DEFAULTS.layout 吻合");
  else bad("第三腿: cardview 缺省字面量与 DEFAULTS.layout 吻合", "缺字面量: " + missing.join(" / "));

  // density 的缺省在 cardview 里是「非 comfortable 即 compact」，与 DEFAULTS.density="compact" 等价
  if (DEFAULTS.layout.density === "compact" && cvSrc.includes('L.density === "comfortable"')) ok("第三腿: density 缺省与 DEFAULTS 一致");
  else bad("第三腿: density 缺省与 DEFAULTS 一致", "cardview 缺省不是 compact 语义");
}

// ════════════════════════════════════════════════════════════════════════
// (a) 契约对齐：fields 的 size/speed/host/error 与 actions.done 的 copy 必须真正渲染
// （不参与 minimal 回归；用修改后的主题单独验，确认校验器放行的取值渲染端有对应实现）
// ════════════════════════════════════════════════════════════════════════
{
  const wide = {
    id: "wide",
    layout: {
      ...minimalTheme.layout,
      fields: ["size", "speed", "host", "eta", "stage", "note", "error"],
      actions: { active: ["cancel"], done: ["open", "folder", "copy"], failed: ["retry"] },
    },
  };
  const task = {
    taskId: "t-wide", state: "running", kind: "url",
    fileName: "x.iso", filePath: "D:\\x.iso", url: "https://www.example.com/x.iso",
    received: 524288, total: 1048576, percent: 50, speed: 131072, unit: "bytes",
  };
  const h = renderCardHTML(task, wide, { ...baseOpts, taskId: task.taskId });
  // 副行（dl-meta）应含按 fields 顺序拼出的全串；用它作为锚，才不会被 dl-progress-top 的同名数据蒙混
  const metaOpen = h.indexOf('<span class="dl-meta"');
  const metaClose = h.indexOf("</span>", metaOpen);
  const meta = metaOpen >= 0 ? h.slice(metaOpen, metaClose + 7) : "";
  if (meta.includes("512KB/1.00MB")) ok("fields:size 进副行且为 已下载/总量");
  else bad("fields:size 进副行且为 已下载/总量", `副行=${meta}`);
  if (meta.includes("128KB/s")) ok("fields:speed 进副行");
  else bad("fields:speed 进副行", `副行=${meta}`);
  if (meta.includes("example.com") && !meta.includes("www.example.com")) ok("fields:host 去 www 前缀");
  else bad("fields:host 去 www 前缀", `副行=${meta}`);
  // fields 顺序：size → speed → host → eta，按数组顺序出现
  if (meta.indexOf("512KB/1.00MB") < meta.indexOf("128KB/s") && meta.indexOf("128KB/s") < meta.indexOf("example.com")) ok("fields 按数组顺序入副行");
  else bad("fields 按数组顺序入副行", `副行=${meta}`);

  const noTotal = { ...task, total: null, percent: null };
  const h2 = renderCardHTML(noTotal, wide, { ...baseOpts, taskId: task.taskId });
  const m2o = h2.indexOf('<span class="dl-meta"');
  const m2c = h2.indexOf("</span>", m2o);
  const meta2 = m2o >= 0 ? h2.slice(m2o, m2c + 7) : "";
  if (meta2.includes("512KB") && !meta2.includes("512KB/")) ok("fields:size 无 total 时只报已下载");
  else bad("fields:size 无 total 时只报已下载", `副行=${meta2}`);

  // copy 动作：fold:false 主题（无详情面板）下应出现复制按钮
  const noFoldCopy = { id: "nf", layout: { ...wide.layout, fold: false } };
  const h3 = renderCardHTML({ ...task, state: "done", percent: 100 }, noFoldCopy, baseOpts);
  if (h3.includes('id="dl-copy"') && h3.includes("复制路径")) ok("actions:copy 在 fold:false 下渲染");
  else bad("actions:copy 在 fold:false 下渲染", "未出现 #dl-copy");

  // copy 动作：无 filePath 时不给
  const h4 = renderCardHTML({ ...task, state: "done", percent: 100, filePath: "" }, noFoldCopy, baseOpts);
  if (!h4.includes('id="dl-copy"')) ok("actions:copy 无 filePath 时不给");
  else bad("actions:copy 无 filePath 时不给", "filePath 为空仍渲染了复制按钮");

  // error 字段：失败态核心已渲染 error，副行不再重复
  const failTask = { taskId: "t-err", state: "failed", kind: "url", fileName: "y.zip", received: 0, total: 0, error: "网络超时" };
  const h5 = renderCardHTML(failTask, wide, baseOpts);
  const occurrences = h5.split("网络超时").length - 1;
  // 出现两处：信息行文本 + title 属性（同一 errText）；副行不应再加一处
  if (occurrences === 2) ok("fields:error 失败态与核心 errText 不重复");
  else bad("fields:error 失败态与核心 errText 不重复", `网络超时出现 ${occurrences} 次（期望 2：正文 + title）`);
}

// ════════════════════════════════════════════════════════════════════════
// (d) golden 基准比对：cardview 在 minimal 下与改动前 render() 冻结快照逐字节一致
// ════════════════════════════════════════════════════════════════════════
{
  const golden = JSON.parse(readFileSync(path.join(here, "fixtures", "cardview-golden.json"), "utf8"));
  const minimalRaw = JSON.parse(readFileSync(path.join(here, "..", "ui", "themes", "minimal", "theme.json"), "utf8"));
  const realMinimal = resolveTheme(minimalRaw, [minimalRaw]);
  let gFail = 0;
  for (const item of golden.cases) {
    const c = cases.find((x) => x.id === item.id);
    if (!c) { gFail += 1; bad(`golden:${item.id}`, "fixture 缺失"); continue; }
    const got = renderCardHTML(c.task, realMinimal, item.opts);
    if (got === item.html) ok(`golden:${item.id} 与改动前一致`);
    else { gFail += 1; bad(`golden:${item.id} 与改动前一致`, diffDetail(item.html, got)); }
  }
  if (gFail === 0) ok(`golden: ${golden.cases.length} 例全部与改动前冻结快照逐字节一致`);
}

console.log(`\n=== cardview: ${pass} passed, ${fail} failed ===`);
Date.now = realNow;
process.exit(fail ? 1 : 0);
