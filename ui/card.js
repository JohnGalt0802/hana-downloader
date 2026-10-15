// card.js — 聊天流内的下载进度卡片（v2 App，官方 @hana/app-sdk/ui）
//
// 与旧版的区别：
//   1. 不再劫持 window.fetch、不再模拟插件时代的 /download/xxx 路径。
//      后端访问统一走 hana.api.fetch（SDK 自动带上 iframe 的 surface session 票据）。
//   2. 主题与尺寸走 SDK（hana.theme / hana.ui.resize），不再自己解析 iframe URL 参数。
//   3. 任务身份不再靠「无参回退到最近任务」：加载后向引擎 /bind 认领本卡对应的任务，
//      键是宿主铸造的 cardInstanceId（重新投影后不变，所以会话重载不会串）。
//
// 视觉层（配色板、类结构、图标、文案、折叠联动）沿用旧版未改；
// 自 P0（2026-10-15）起，HTML 内容生成改由声明式主题驱动（见 shared/cardview.js + shared/theme.js）。

import { hana } from "./assets/sdk.js";
// 渲染层（P0）：卡片内容由主题数据驱动的纯函数生成。
// 阶段文案、计数单位与任务形态判定的唯一来源（display.js）随渲染逻辑一起收进了 cardview.js，
// 本模块不再直接依赖它——免得同一条文案在两处各存一份。
import { renderCardHTML } from "./shared/cardview.js";
import { resolveTheme, DEFAULT_THEME_ID } from "./shared/theme.js";

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

// ── 卡片主题（P0：声明式主题系统）──
// 主题 = 数据（theme.json），由 ./shared/theme.js 合并继承成完整主题对象后交给 cardview 画。
// 主题 id 的唯一来源是引擎设置里的 cardSkin；P0 阶段该字段通常不存在，
// 此时回落内置默认（minimal）——即与改动前完全一致的现状。
// 任一环节失败（设置读不到 / index.json 取不到 / theme.json 404 / JSON 解析报错）
// 都静默回落内置 minimal，绝不白屏、绝不把异常抛给调用方：卡片外观是次要的，
// 把任务状态渲染出来才是它的功能底线。
var theme = resolveTheme({ id: DEFAULT_THEME_ID }, []); // 兜底：内置 minimal 的默认取值
var allRawThemes = []; // 全部候选主题的原始定义（basedOn 继承链的查找表）

/** 取一份 theme.json：先走相对 card.html 的包内路径，失败再试资产基址方式。 */
async function fetchThemeJSON(relPath) {
  // 包内相对路径（ui/ 快照随包分发，这条是主路径）
  try {
    const res = await fetch(new URL(relPath, import.meta.url).href, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch { /* 落到下一路 */ }
  // 宿主经 hana-asset-base 暴露 ui 目录时的取法（老宿主/特殊挂载环境）
  try {
    const url = hana.assets?.url?.(relPath.replace(/^\.\//, ""));
    if (url) {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    }
  } catch { /* 两路都不可用 */ }
  throw new Error("theme fetch failed: " + relPath);
}

/** 加载并解析当前主题；全部异常在此吞掉并回落内置 minimal（见上方说明）。 */
async function loadTheme() {
  // ① 取主题 id：设置读不到 / 字段缺失 / 老引擎没有该字段，一律用默认 id
  let id = DEFAULT_THEME_ID;
  try {
    const res = await hana.api.fetch("/engine/settings");
    const j = await res.json();
    const skin = j && j.ok && j.settings ? j.settings.cardSkin : null;
    if (typeof skin === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skin)) id = skin;
  } catch { /* 回落默认 id */ }

  try {
    // ② index.json 是全部候选主题清单，同时当 basedOn 继承链的查找表
    const index = await fetchThemeJSON("./themes/index.json");
    const ids = Array.isArray(index)
      ? index.map((e) => e && e.id).filter((v) => typeof v === "string" && v)
      : [];
    // 逐个取原始主题（主题不多，且继承链可能指向清单里的任意一个）；单个取不到就跳过
    const raws = await Promise.all(ids.map(async (tid) => {
      try { return await fetchThemeJSON("./themes/" + tid + "/theme.json"); }
      catch { return null; }
    }));
    allRawThemes = raws.filter(Boolean);
    // ③ 交给 resolveTheme 合并继承；目标缺失（设置里的 id 包内不存在）则保持内置 minimal
    const target = allRawThemes.find((r) => r && r.id === id);
    if (target) theme = resolveTheme(target, allRawThemes);
  } catch { /* 静默回落：theme 仍是内置 minimal */ }
}

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
// 3.1（2026-10-13）：宽度探查窗口的截止时刻。>0 且未过期 = 窗口开着。
// 0 = 关闭，此时去重行为与改动前完全一致（零额外开销）。窗口有上限，不会永久纠缠。
var widthProbeUntil = 0;
// 2026-10-13 补：探测放行的最小间隔。活跃期每 300ms 一次 render→reportSize，
// 若无节流，窗口内宽度始终不对时会连发约 40 条同内容上报。这里限「探测最多每秒一次」。
// 只约束 probing 放行的非 force 上报；force=true 完全不走这条路。
var lastProbeSentAt = 0;
function reportSize(force) {
  try {
    const h = measureH();
    // 高度未变不重复上报（高频轮询下减负）。
    // force=true 时无视去重强制补报 —— 2026-10-06 实测：宿主在卡片加载期可能丢弃上报，
    // 若那一刻高度恰好已稳定，去重会让这张卡「永远不再上报」，尺寸就永久停在宿主
    // 默认值（撑满 + 变高）。这是个单向门，启动期与终态各强制补报几轮把它拆掉。
    // 2026-10-13：去重键纳入「宿主是否已采纳宽度」——切会话/iframe 重建后宿主尺寸 state
    // 归零，而内容高度往往早已是稳定的终态值，只按高度去重会把纠正窗口白白吃掉。
    // 探查窗内且宽度还不达标时照发；宿主采纳（宽度到位）或窗口过期后自动回到零开销。
    const now = Date.now();
    const widthOk = Math.abs(window.innerWidth - CARD_WIDTH) <= 2;
    const probing = now < widthProbeUntil && !widthOk && (now - lastProbeSentAt >= 1000);
    if (!force && h === lastReportedH && !probing) return;
    lastReportedH = h;
    lastProbeSentAt = now;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { /* 老宿主没有这路 */ }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { /* 同上 */ }
  } catch { /* 忽略 */ }
}

if (typeof ResizeObserver !== "undefined") {
  try { new ResizeObserver(() => reportSize(false)).observe(root); } catch { /* 观察失败不影响主流程 */ }
}

// 启动期收敛（轻量版，二稿）：不盲目补报，先做零成本自检——读 window.innerWidth 看
// 宿主是否已把宽度采纳成 CARD_WIDTH（实测宿主取 min(想要,信封上限)-1，故容差 2）。
// 已到位就立即停；未到位才补报。resize 事件作即时信号（宿主采纳时会触发）。
// 典型收敛：1~3 次补报内完成，之后不再打扰通道。
(function bootSettle() {
  if (typeof setInterval !== "function") return;
  // 3.2：启动期开探查窗（12s 上限）。重建/重载时这段重跑，窗口自然重开。
  widthProbeUntil = Date.now() + 12000;
  const adopted = () => {
    try { return Math.abs(window.innerWidth - CARD_WIDTH) <= 2; } catch { return true; }
  };
  let sent = 0; // 本轮已真实发出的强制上报次数（3.4 收兵判据之一）
  reportSize(true); sent += 1; // 首帧立即来一次
  try {
    window.addEventListener("resize", () => { if (!adopted()) reportSize(true); });
  } catch { /* 事件不可用不影响主流程 */ }
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    // 3.4（方案甲）：收兵需「宽度达标」且「已真实发出 ≥2 次上报」。
    // 只看 |innerWidth-400|<=2 会误判：宽度可能是宿主上一轮的残留/巧合（窄列恰好≈400），
    // 而本次上报其实没落地，一收兵就再无纠正机会。多发一次确认，代价仍在秒级。
    if (adopted() && sent >= 2) { clearInterval(timer); return; } // 宿主已采纳，停止打扰
    reportSize(true); sent += 1;
    if (n >= 6) clearInterval(timer); // 兜底上限：6 次检查（约 9 秒）
  }, 1500);
})();

// 3.3：re-show 强制补报（纯事件监听，零轮询）。覆盖「隐藏再显示」这条路径——
// 宿主把卡片 park 后移回时 iframe 不重载，bootSettle 不会重跑，得靠这里重新开窗补报。
var lastReshowAt = 0; // 连续触发（快速切会话）时合并，避免叠加 pending 的一次性定时器
function onReshow() {
  try {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastReshowAt < 400) return;
    lastReshowAt = now;
    widthProbeUntil = Date.now() + 12000;
    [0, 400, 1500].forEach((d) => setTimeout(() => reportSize(true), d)); // 三个一次性定时器
  } catch { /* 事件不可用不影响主流程 */ }
}
try {
  document.addEventListener("visibilitychange", onReshow);
  window.addEventListener("pageshow", onReshow);
} catch { /* 事件不可用不影响主流程 */ }

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
var lostNotified = false; // 任务被清理后只提示一次（保留最后快照时）

function schedule(ms) {
  if (timer) { clearInterval(timer); timer = null; }
  if (!ms) return;
  timer = setInterval(poll, ms);
}

async function poll() {
  try {
    const data = await engineFetch("wait", { taskId: taskId || null });
    if (!data || !data.ok) {
      // 任务真的不存在（被管理器「清空/删除记录」，或引擎重启后没这条记录）：停掉轮询。
      // 注意与「终态」区别：终态要留着慢查等重试，任务没了就没得等了。
      // 2026-10-12：不再把引擎的英文原始错误（"not found"）回显到卡片上。
      stop();
      if (currentTask) {
        // 卡片已渲染过、任务后来被清理：保留最后快照（只读，仍可折叠/查看路径/打开文件），
        // 而不是把整张卡清成一行错误——那会让折叠等按钮一起消失，用户看到的就是「按钮按不动」。
        if (!lostNotified) { lostNotified = true; renderHint("该记录已被清理，以下为最后快照"); }
      } else {
        // 首帧就没有对应记录（清理后再打开这张卡）：给一句中文交代。
        renderFail("找不到该下载记录");
      }
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
    // P0 预留（为 P1 切主题铺路，P0 阶段没人发这条消息，因此零影响）：
    // 管理器选定新主题后广播 skinChanged，在屏卡片重载主题并重绘。
    if (d.type === "skinChanged") {
      (async () => {
        try {
          await loadTheme();
          render(currentTask);
        } catch { /* 重载失败沿用旧主题，不打扰已渲染的卡片 */ }
      })();
      return;
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

// 阶段文案 / 计数单位 / 字节与时长格式化 / 状态徽标 / HTML 拼接，已全部搬到
// ui/shared/cardview.js（由主题数据驱动的纯函数）。本模块只留一份 esc —— renderFail/renderHint
// 是「找不到记录」这类旁路提示，不走 cardview，而 cardview 未导出 esc。

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// 渲染：状态判断、终态补报与 DOM 写入留在本模块（它们是行为，不是样式），
// HTML 内容交给纯函数 renderCardHTML 按当前主题（theme）生成。
function render(t) {
  // ★硬约束：poll() 可能拿到 falsy 的 t（引擎回 ok 但没带任务快照）。
  // renderCardHTML(null, …) 返回空串，若直接写 DOM 会把整张卡清空；
  // 保留上一帧才是原行为（旧 render 也是这里的 if (!t) return）。
  if (!t) return;
  currentTask = t;

  // 终态切换时强制补报几轮：最后一次上报若被宿主丢弃，靠这几轮兜住（2026-10-06）
  const terminal = FINAL_STATES[t.state] === 1;
  if (terminal && !terminalReported) {
    terminalReported = true;
    [0, 1000, 2500].forEach((d) => setTimeout(() => reportSize(true), d));
  }

  // 折叠态 / 重试态 / 任务 id 由本模块持有（render 每次重写 DOM，状态得留在外面），
  // 经 opts 传给纯函数，使其不读任何全局状态。
  const html = renderCardHTML(t, theme, { expanded, allExpanded, retrying, taskId });
  if (root.innerHTML !== html) root.innerHTML = html;
  reportSize();
  // 按钮事件不在这里绑定——render 会被轮询反复调用，每次新建的箭头函数会让
  // addEventListener 在同一节点上不断累加（终态 html 稳定、DOM 不重建，最终演变为
  // 一点即触发 N 次，N 随卡片停留时间增长）。点击分发统一走下方模块级的事件委托。
}

// ── 事件委托（issue #2 修复）──
// 模块加载时给 root 挂唯一一个 click 监听，按 closest("[id]") 分发到对应动作。
// 为什么不用 render 内直接绑定：render 是轮询驱动的，终态下每 5 秒调一次；
// 若每次 render 都 addEventListener(() => ...)，闭包函数每次都是新引用，
// 浏览器不会去重，监听器随渲染次数线性累加——点一次就触发 N 次（N 随卡片寿命增长）。
// 委托挂在 root 上，root 本身不随 innerHTML 重建而消失，因此永远只有一个监听。
root.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest("[id]") : null;
  if (!el) return;
  const id = el.id;
  if (id === "dl-fold") toggleFold();
  else if (id === "dl-all") toggleAll();
  else if (id === "dl-cancel") cancel();
  else if (id === "dl-open") reveal("open");
  else if (id === "dl-folder") reveal("select");
  else if (id === "dl-copy") copyPath(currentTask && currentTask.filePath);
  else if (id === "dl-retry") retry();
});

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
  // 主题加载与 bindTask 并行（两者互不依赖），主题就在 bindTask 内部那段等待里抓好，
  // 不给首帧增加额外延迟；失败已在 loadTheme 内部吸掉，theme 仍是内置 minimal。
  await Promise.all([bindTask(), loadTheme()]);
  await poll(); // poll 内部按任务状态排好后续节奏，这里不再另起 setInterval
})();
