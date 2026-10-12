// card.js — 聊天流内的下载卡片（v2 App，官方 @hana/app-sdk/ui）
//
// 2026-10-12 视觉重构（用户要求「在聊天信息流里正常显示」）：
//   卡片标记生成抽到唯一来源 ui/shared/cardview.js（纯函数，可单测与离线预览）。
//   去掉折叠箭头、全选占位符、6 行详情键值表——它们把两行高的卡撑成一张小表格，
//   而真正的实体（文件名）反而看不见。现在卡上只画三件事：
//     谁（格式徽章 + 文件名）、到哪一步了（状态标签 + 体积/速度/原因）、能做什么（动作按钮）。
//
// 与旧版一致的部分（保持不变）：
//   1. 后端统一走 hana.api.fetch（SDK 自动带 iframe 的 surface session 票据）。
//   2. 主题与尺寸走 SDK（hana.theme / hana.ui.resize）。
//   3. 任务身份用宿主铸造的 cardInstanceId 向引擎 /bind 认领。
//   4. 点击分发走模块级事件委托（唯一监听），不在 render 里绑定（issue #2 的根因）。

import { hana } from "./assets/sdk.js";
import { renderCardHTML } from "./shared/cardview.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = document.getElementById("dl-root");
if (!root) throw new Error("dl-root missing");

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
var CARD_WIDTH = 400;

function measureH() {
  const dlEl = document.querySelector(".dl");
  const bodyEl = document.body;
  let pad = 0;
  if (bodyEl && window.getComputedStyle) {
    const cs = window.getComputedStyle(bodyEl);
    pad = (parseInt(cs.paddingTop, 10) || 0) + (parseInt(cs.paddingBottom, 10) || 0);
  }
  let h = Math.ceil((dlEl ? dlEl.offsetHeight : (bodyEl ? bodyEl.scrollHeight : 0)) + pad);
  if (!isFinite(h) || h < 24) h = 24;
  return h;
}

var lastReportedH = 0;
var terminalReported = false;
function reportSize(force) {
  try {
    const h = measureH();
    // force=true 时无视去重强制补报：宿主在卡片加载期可能丢弃上报，若那一刻高度已稳定，
    // 去重会让这张卡「永远不再上报」。启动期与终态各强制补报几轮把它拆掉（2026-10-06）。
    if (!force && h === lastReportedH) return;
    lastReportedH = h;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主没有这路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}

if (typeof ResizeObserver !== "undefined") {
  try { new ResizeObserver(() => reportSize(false)).observe(root); } catch { /* 观察失败不影响主流程 */ }
}

// 启动期收敛：读 window.innerWidth 看宿主是否已把宽度采纳成 CARD_WIDTH（容差 2），
// 已到位就立即停；未到位才补报。典型 1~3 次补报内完成。
(function bootSettle() {
  if (typeof setInterval !== "function") return;
  const adopted = () => {
    try { return Math.abs(window.innerWidth - CARD_WIDTH) <= 2; } catch { return true; }
  };
  reportSize(true);
  try {
    window.addEventListener("resize", () => { if (!adopted()) reportSize(true); });
  } catch { /* 事件不可用不影响主流程 */ }
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    if (adopted()) { clearInterval(timer); return; }
    reportSize(true);
    if (n >= 6) clearInterval(timer);
  }, 1500);
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
    if (j?.ok && j.taskId) { taskId = j.taskId; return true; }
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

// App 自己的路由（不走 /engine/* 透传）：/retry 由 App 受理，因为它要起终态守望
// 把重试结果通知回原会话。
async function appFetch(path, body) {
  const init = { method: "POST", headers: { "content-type": "application/json" } };
  if (body) init.body = JSON.stringify(body);
  const res = await hana.api.fetch(path, init);
  return res.json();
}

// ── 状态机 ──
// 终态不停轮询，转 5s 慢查等「重试」复活；管理器改状态时广播 taskChanged，立刻恢复快频。
var timer = null;
var FAST_MS = 300;
var IDLE_MS = 5000;
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
      renderFail((data && data.error) || "任务不存在");
      stop();
      return;
    }
    const t = data.task || data.snap;
    if (t && t.taskId) taskId = t.taskId;
    if (retrying && (!FINAL_STATES[t.state] || Date.now() > retryDeadline)) retrying = false;
    render(t);
    schedule(FINAL_STATES[t.state] ? IDLE_MS : FAST_MS);
  } catch (e) {
    schedule(FAST_MS);
  }
}

function stop() { schedule(null); }

// ── 重试 ──
var retrying = false;
var retryDeadline = 0;
const RETRY_WAIT_MS = 8000;

async function retry() {
  if (retrying) return;
  retrying = true;
  retryDeadline = Date.now() + RETRY_WAIT_MS;
  render(currentTask);
  try {
    const d = await appFetch("/retry", { taskId: taskId || null });
    if (!d || !d.ok) {
      retrying = false;
      render(currentTask);
      renderHint((d && d.error) || "重试失败");
      return;
    }
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

// ── 管理器广播：任务状态变了就叫醒本卡 ──
var BC = null;
try { BC = new BroadcastChannel("hana-dl-cards"); } catch (e) { BC = null; }
if (BC) {
  BC.onmessage = (ev) => {
    const d = ev.data;
    if (!d || !d.type) return;
    if (d.type === "taskChanged") {
      if (d.taskId && taskId && d.taskId !== taskId) return;
      schedule(FAST_MS);
      poll();
    }
  };
}

// ── 渲染（标记生成见 ui/shared/cardview.js）──
var currentTask = null;

function render(t) {
  if (!t) return;
  currentTask = t;
  const terminal = FINAL_STATES[t.state] === 1;
  if (terminal && !terminalReported) {
    terminalReported = true;
    [0, 1000, 2500].forEach((d) => setTimeout(() => reportSize(true), d));
  }
  const html = renderCardHTML(t);
  if (root.innerHTML !== html) root.innerHTML = html;
  reportSize();
  // 事件不在这里绑定：render 被轮询反复调用，每次新建的箭头函数会让监听器累加
  //（issue #2 的根因）。点击分发统一走下方模块级事件委托。
}

// ── 事件委托（唯一监听）──
// 挂在 root 上，root 不随 innerHTML 重建而消失，所以监听器恒为 1。
root.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest("[id]") : null;
  if (!el) return;
  const id = el.id;
  if (id === "dl-cancel") cancel();
  else if (id === "dl-open") reveal("open");
  else if (id === "dl-folder") reveal("select");
  else if (id === "dl-retry") retry();
});

function renderFail(msg) {
  root.innerHTML = '<div class="dl"><div class="dl-error">' + String(msg == null ? "" : msg)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</div></div>";
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

(async () => {
  await bindTask();
  await poll(); // poll 内部按任务状态排好后续节奏，这里不再另起 setInterval
})();
