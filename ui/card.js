// card.js — 聊天流内的下载进度卡片（v2 App，官方 @hana/app-sdk/ui）
//
// 与旧版的区别：
//   1. 不再劫持 window.fetch、不再模拟插件时代的 /download/xxx 路径。
//      后端访问统一走 hana.api.fetch（SDK 自动带上 iframe 的 surface session 票据）。
//   2. 主题与尺寸走 SDK（hana.theme / hana.ui.resize），不再自己解析 iframe URL 参数。
//   3. 任务身份不再靠「无参回退到最近任务」：加载后向引擎 /bind 认领本卡对应的任务，
//      键是宿主铸造的 cardInstanceId（重新投影后不变，所以会话重载不会串）。
//
// 视觉层（配色板、类结构、图标、文案、折叠联动）沿用旧版，未改。

import { hana } from "./assets/sdk.js";
// 阶段文案、计数单位与任务形态判定都有唯一来源（Node 侧 index.js 同用这个模块）
import { STAGE_TEXT, unitSuffix, isPkgTask, isCountTask } from "./shared/display.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = document.getElementById("dl-root");
if (!root) throw new Error("dl-root missing");

// card.html 里没有内联脚本了，__API 基址完全由 SDK 负责解析。
try { hana.ready(); } catch (e) { /* ready 失败不阻塞渲染 */ }

// ── 主题 ──
function syncTheme() {
  let snap = null;
  try { snap = hana.theme?.getSnapshot?.() || null; } catch { snap = null; }
  const label = String(snap?.theme || "");
  let dark = snap?.appearance === "dark" || /dark|midnight|contrast|深|夜/i.test(label);
  if (!snap?.appearance && (!label || label === "inherit")) {
    dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  document.body.classList.toggle("t-dark", dark);
}
syncTheme();
try { hana.theme?.subscribe?.(() => syncTheme()); } catch { /* 订阅不可用就只保留首帧 */ }

// ── 尺寸上报 ──
// 高度走 SDK 的 ui.resize；同时保留 hana.card-resize 这条顶层消息作兜底——
// 0.970.9 聊天流挂载位的卡壳只认这一条高度消息（实测），SDK 那条在这条路径上没人接。
var CARD_WIDTH = 400; // 2026-09-17：450 → 400（收窄 50px）

function measureH() {
  const dlEl = document.querySelector(".dl");
  const bodyEl = document.body;
  let pad = 0;
  if (bodyEl && window.getComputedStyle) {
    const cs = window.getComputedStyle(bodyEl);
    pad = (parseInt(cs.paddingTop, 10) || 0) + (parseInt(cs.paddingBottom, 10) || 0);
  }
  let h = Math.ceil((dlEl ? dlEl.offsetHeight : (bodyEl ? bodyEl.scrollHeight : 0)) + pad);
  // 下限 24px：内容真没了也得留出可点的两行。
  // 2026-09-14 压薄：原为 40，等于给卡片钉了块地板，内容压到 32 也报 40，
  // 底部就永远有 8px 空白（用户看到的“进度条到下边框的距离”）。
  if (!isFinite(h) || h < 24) h = 24;
  return h;
}

var lastReportedH = 0;
var terminalReported = false; // 终态补报只触发一次
function reportSize(force) {
  try {
    const h = measureH();
    // 高度未变不重复上报（高频轮询下减负；宽度是常量，不参与变化判断）。
    // force=true 时无视去重强制补报 —— 2026-10-06 实测：宿主在卡片加载期可能丢弃上报，
    // 若那一刻高度恰好已稳定，去重会让这张卡「永远不再上报」，尺寸就永久停在宿主
    // 默认值（撑满 + 变高）。这是个单向门，启动期与终态各强制补报几轮把它拆掉。
    if (!force && h === lastReportedH) return;
    lastReportedH = h;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主没有这路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}

if (typeof ResizeObserver !== "undefined") {
  try { new ResizeObserver(() => reportSize(false)).observe(root); } catch { /* 观察失败不影响主流程 */ }
}

// 启动期兜底：挂载后前 10 秒每秒强制补报一次（覆盖宿主加载期丢弃上报的窗口）
(function bootReport() {
  if (typeof setInterval !== "function") return;
  reportSize(true); // 首帧立即来一次
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    reportSize(true);
    if (n >= 10) clearInterval(timer);
  }, 1000);
})();

// ── 任务绑定 ──
let taskId = "";

function surfaceContext() {
  try { return hana.surface?.getContext?.() || null; } catch { return null; }
}

async function bindTask() {
  let ctx = null;
  for (let i = 0; i < 12 && !ctx; i++) {
    ctx = surfaceContext();
    if (!ctx) await sleep(150);
  }
  const cardInstanceId = ctx?.cardInstanceId || "";
  const sessionId = ctx?.embeddedSessionId || ctx?.originSessionId || null;

  try {
    const res = await hana.api.fetch("/engine/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardInstanceId, sessionId }),
    });
    const j = await res.json();
    if (j?.ok && j.taskId) {
      taskId = j.taskId;
      return true;
    }
  } catch (e) {
    // 认领失败：退回无参轮询（引擎回退到最近任务），至少让卡片有内容
  }
  return false;
}

// ── 引擎访问 ──
async function engineFetch(path, body, method) {
  const init = { method: method || (body ? "POST" : "GET") };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await hana.api.fetch(`/engine/${path}`, init);
  return res.json();
}

// App 自己的路由（不走 /engine/* 透传）。目前用于 /retry：该路由由 App 处理，
// 因为 App 受理后要起一个终态守望，好在跑完后把结果通知回原会话。
async function appFetch(path, body) {
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  const res = await hana.api.fetch(path, init);
  return res.json();
}

// ── 状态机 ──
// 2026-09-21：终态不再彻底停轮询。管理器的「重试」是在同一个 taskId 上把任务复活，
// 卡片若已 stop() 就永远看不到新状态，必须刷新前端才恢复（用户实测反馈）。
// 现在：活跃 300ms，终态后转 5s 慢查等复活；管理器改状态时会广播 taskChanged，
// 卡片收到立刻恢复快频并马上查一次。
var timer = null;
var FAST_MS = 300;   // 活跃期（引擎侧数据源 500ms 更新一轮）
var IDLE_MS = 5000;  // 终态后的慢查，只为等「重试」把任务唤起
var FINAL_STATES = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

function schedule(ms) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!ms) return;
  timer = setInterval(poll, ms);
}

async function poll() {
  try {
    const data = await engineFetch("wait", { taskId: taskId || null });
    if (!data || !data.ok) {
      // 任务真的不存在（被删除，或引擎重启后没这条记录）：停掉轮询。
      // 注意与「终态」区别：终态要留着慢查等重试，任务没了就没得等了。
      renderFail((data && data.error) || "任务不存在");
      stop();
      return;
    }
    const t = data.task || data.snap;
    if (t && t.taskId) taskId = t.taskId;
    // 重试等待的收尾：状态翻身（或等到超时）就停止转圈，交给紧随其后的 render 画对
    if (retrying && (!FINAL_STATES[t.state] || Date.now() > retryDeadline)) retrying = false;
    render(t);
    // 终态转慢查（任务可能被管理器重试复活），非终态保持快频
    schedule(FINAL_STATES[t.state] ? IDLE_MS : FAST_MS);
  } catch (e) {
    // 瞬时错误（引擎重启/网络抖动）：保持节奏，别把轮询丢掉
    schedule(FAST_MS);
  }
}

function stop() { schedule(null); }

// ── 卡片上的重试（圈箭头，2026-09-21）──
// 只出现在终态（失败 / 取消 / 中断）。点一下箭头转圈，直到任务离开终态——
// 转圈的停止交给 poll：状态一翻身，render 出来就没有这个按钮了。
var retrying = false;      // 点过重试、正等状态翻身
var retryDeadline = 0;     // 超过这个时刻就不再等（避免箭头无限转）
const RETRY_WAIT_MS = 8000;

async function retry() {
  if (retrying) return;
  retrying = true;
  retryDeadline = Date.now() + RETRY_WAIT_MS;
  render(currentTask); // 立刻画出转圈态
  try {
    const d = await appFetch("/retry", { taskId: taskId || null });
    if (!d || !d.ok) {
      retrying = false;
      render(currentTask);
      renderHint((d && d.error) || "重试失败");
      return;
    }
    // 受理成功：转圈继续，等 poll 拿到非终态；顺带立刻查一次
    schedule(FAST_MS);
    poll();
  } catch (e) {
    retrying = false;
    render(currentTask);
    renderHint("重试失败：网络错误");
  }
}

async function cancel() {
  try {
    const d = await engineFetch("cancel", { taskId: taskId || null, source: "user" });
    if (d && d.ok) poll();
  } catch (e) { /* 卡片即将随任务终态刷新 */ }
}

async function reveal(mode) {
  const p = currentTask && currentTask.filePath;
  if (!p) return;
  try {
    const d = await engineFetch("reveal", { path: p, mode: mode || "select" });
    if (d && d.ok === false) renderHint(d.error || "打开失败");
  } catch (e) { renderHint("打开失败"); }
}

async function copyPath(p) {
  if (!p) return;
  try {
    await hana.clipboard.writeText(p);
    flashBtn("已复制");
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = p;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flashBtn("已复制");
    } catch (e2) { renderHint("复制失败"); }
  }
}

function flashBtn(msg) {
  const b = root.querySelector(".dl-copy");
  if (!b) return;
  const old = b.textContent;
  b.textContent = msg;
  setTimeout(() => { if (b) b.textContent = old; }, 1200);
}

// ── 折叠状态（render 每次重写 DOM，这里记住状态防丢失）──
var expanded = false;
var allExpanded = false;
var BC = null;
try { BC = new BroadcastChannel("hana-dl-cards"); } catch (e) { BC = null; }
if (BC) {
  BC.onmessage = (ev) => {
    const d = ev.data;
    if (!d || !d.type) return;
    // 折叠联动：卡片之间同步「展开全部」
    if (d.type === "setAll") {
      allExpanded = !!d.value;
      expanded = allExpanded;
      applyExpandState();
      return;
    }
    // 2026-09-21：管理器改了任务状态（重试 / 取消 / 删除 / 改设置），
    // 立刻恢复快频并马上查一次，不必等前端刷新。
    if (d.type === "taskChanged") {
      if (d.taskId && taskId && d.taskId !== taskId) return; // 不是本卡的任务，忽略
      schedule(FAST_MS);
      poll();
    }
  };
}

function applyExpandState() {
  const dl = root.querySelector(".dl");
  if (dl) dl.classList.toggle("expanded", expanded);
  const foldBtn = document.getElementById("dl-fold");
  if (foldBtn) foldBtn.classList.toggle("open", expanded);
  const allBtn = document.getElementById("dl-all");
  if (allBtn) allBtn.classList.toggle("open", allExpanded);
  reportSize();
}

function toggleFold() { expanded = !expanded; applyExpandState(); }

function toggleAll() {
  allExpanded = !allExpanded;
  expanded = allExpanded;
  applyExpandState();
  if (BC) { try { BC.postMessage({ type: "setAll", value: allExpanded }); } catch (e) { /* 忽略 */ } }
}

// ── 渲染 ──
var currentTask = null;

// 阶段文案与计数单位来自 ui/shared/display.js（唯一来源），这里不再各存一份。

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

function render(t) {
  if (!t) return;
  currentTask = t;

  const state = t.state;
  const running = state === "running";
  const pending = state === "pending";
  const done = state === "done";
  const terminal = done || state === "failed" || state === "canceled" || state === "interrupted";
  // 终态切换时强制补报几轮：最后一次上报若被宿主丢弃，靠这几轮兜住（2026-10-06）
  if (terminal && !terminalReported) {
    terminalReported = true;
    [0, 1000, 2500].forEach((d) => setTimeout(() => reportSize(true), d));
  }
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

  if (root.innerHTML !== html) root.innerHTML = html;

  reportSize();

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("dl-fold", toggleFold);
  on("dl-all", toggleAll);
  on("dl-cancel", cancel);
  on("dl-open", () => reveal("open"));
  on("dl-folder", () => reveal("select"));
  on("dl-copy", () => copyPath(filePath));
  on("dl-retry", retry);
}

function renderFail(msg) {
  root.innerHTML = '<div class="dl"><div class="dl-error">' + esc(msg) + "</div></div>";
  reportSize();
}

function renderHint(msg) {
  const div = document.createElement("div");
  div.className = "dl-hint";
  div.textContent = msg;
  root.appendChild(div);
  reportSize();
}

// ── 启动 ──
window.addEventListener("load", () => setTimeout(reportSize, 60));

// 尺寸诊断已于 2026-09-25 移除。
// 原实现在挂载后 1.2s 调 hana.track("diag", {...}) 上报 iframe 宽度与信封尺寸，
// 用于排查「撑满聊天流」问题（见 docs/踩坑记录.md 第 38 条）。该问题已定性，
// 而这段代码在宿主 0.1023.1 上会报两个错：
//   ① events/track cardInstanceId must be a host-minted app card id.
//      —— 聊天流卡的 id 是 stableCardId() 自算的，新宿主只认宿主铸造的 id；
//   ② Plugin host request timed out: hana.track.
//      —— 多卡同时挂载时成批发请求，正是第 38 条里「插件通道堵」的同期证据，
//         留着它等于自己给通道加负担。

(async () => {
  await bindTask();
  await poll(); // poll 内部按任务状态排好后续节奏，这里不再另起 setInterval
})();
