// ui/shared/cardview.js — 卡片内容生成的纯函数（P0 · W2，2026-10-15）
//
// 背景：本项目要把「卡片长什么样」变成由主题数据驱动的结果，
// 见 docs/方案-声明式卡片主题系统-20261015.md 与 docs/施工-卡片主题系统-P0-20261015.md。
// 本文件是渲染层地基：把原先写死在 ui/card.js 里 render() 的 HTML 拼接逻辑搬到这里，
// 改由 theme.layout 的取值决定分支。
//
// 硬约束（P0 成败线）：minimal 主题下的输出必须与改动前的 render() 逐字节一致。
// 因此这里的拼接是「机械搬运」：文案、类名、元素顺序、空格一律照抄原实现，
// 只把控制流的开关从模块级状态换成 theme.layout 的字段。
//
// 纯函数：不碰 DOM、不碰 hana.*、不读全局状态；可在 Node 侧 import 单测。
// 折叠态（expanded/allExpanded）、重试态（retrying）与当前 taskId 全部由调用方经 opts 传入。

// 阶段文案、计数单位与任务形态判定的唯一来源（不另存一份）
import { STAGE_TEXT, unitSuffix, isPkgTask, isCountTask } from "./display.js";

// 终态集合（原 ui/card.js 的 FINAL_STATES，逐字搬来）
const FINAL_STATES = { done: 1, failed: 1, canceled: 1, interrupted: 1 };

// ── 以下四个格式化函数「机械搬运」自 ui/card.js，不得改动 ──
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
  // 2026-10-18：状态缺失时不能直接把 undefined 透出去（会被拼成字面量 "undefined" 徽标
  // 与 class="b-undefined"）。未知状态一律落到 unknown 桶。
  const key = s == null || s === "" ? "unknown" : s;
  return { running: "下载中", pending: "准备中", done: "完成", failed: "失败", canceled: "已取消", interrupted: "已中断", stalled: "停滞" }[key]
    || (key === "unknown" ? "未知" : key);
}

// 文件扩展名（仅 icon:"badge" 用，P1 细化）
function extOf(name) {
  const s = String(name == null ? "" : name);
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(i + 1) : "";
}

// 取 URL 主机名（副行 host 字段用，P0 · W4 契约对齐）：
// 与 PR#4 cardview 的 hostOf 同思路——new URL(url).hostname 去 www. 前缀，解析失败返回空串。
function hostOf(url) {
  try { return new URL(String(url || "")).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * 生成 #dl-root 内部 HTML。
 * @param {object} task   任务快照（引擎 /wait 返回的 task）
 * @param {object} theme  resolveTheme 的返回（含 layout / palette / metrics）
 * @param {object} opts   { expanded?, allExpanded?, retrying?, taskId? }
 * @returns {string}
 */
export function renderCardHTML(task, theme, opts) {
  const t = task;
  if (!t) return "";
  const o = opts || {};
  const expanded = !!o.expanded;
  const allExpanded = !!o.allExpanded;
  const retrying = !!o.retrying;
  const taskId = o.taskId || "";

  // ── 主题结构层取值（缺省回落到与 minimal 等价的默认，保证纯函数独立可用）──
  const L = (theme && theme.layout) || {};
  const fold = L.fold !== false;
  const icon = L.icon || "none";
  const primary = L.primary || "badge";
  const fields = Array.isArray(L.fields) ? L.fields : ["eta", "stage", "note"];
  const fieldSep = L.fieldSep != null ? L.fieldSep : " · ";
  const progress = L.progress || "row";
  const progressWhenDone = L.progressWhenDone !== false;
  // density：P0 只做最轻的落点（comfortable 加一个根类），细节留 P1
  const densityClass = L.density === "comfortable" ? " comfortable" : "";
  const actions = L.actions || { active: ["cancel"], done: ["open", "folder"], failed: ["retry"] };

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
  // badgeState 只能落已知值：undefined 会让 class 变成 b-undefined，样式全丢
  const badgeState = (state === "running" && t.stalled ? "stalled" : state) || "unknown";
  const barClass = "dl-bar"
    + (pending || (!known && !terminal) ? " indet" : "")
    + (done ? " done" : "")
    + (state === "failed" || state === "canceled" || state === "interrupted" ? " failed" : "");
  const barWidth = done ? 100 : (known && pct != null ? Math.min(100, pct) : 0);
  const filePath = t.filePath || "";

  // 2026-09-17：速度从 meta 里移出，与百分比/大小合成「数据组」，统一放到进度条上面那行。
  // 副行字段由 theme.layout.fields 选择，按数组顺序入列，沿用 fieldSep 连接；
  // 核心状态信息（停滞/排队）主题不可关闭，固定置于最前。
  // P0 · W4 契约对齐：size/speed/host/error 与 theme.js 的 FIELD_VALUES 对齐，全部真正渲染，
  // 不再出现「validateTheme 放行、渲染却什么都不出」的静默缺口。
  const metaParts = [];
  if (t.stalled && !terminal) metaParts.push("连接停滞，等待 Agent 决策");
  if (pending) metaParts.push(t.queued ? "排队中…" : "准备中…");
  for (const f of fields) {
    if (f === "eta") {
      if (etaText) metaParts.push(etaText);
    } else if (f === "size") {
      // 已下载/总量：total 已知时报「已下载/总量」，否则只报已下载
      metaParts.push(known ? fmtBytes(t.received) + "/" + fmtBytes(t.total) : fmtBytes(t.received));
    } else if (f === "speed") {
      // 仅下载中且速度为正时报（速度的固定数据组仍由 dl-progress-top 渲染，此处供主题另择位置）
      if (running && t.speed > 0) metaParts.push(fmtBytes(t.speed) + "/s");
    } else if (f === "stage") {
      // 计数型任务（pnpm 等）：优先显示真实计数明细，没有明细才退回阶段名（2026-09-19）
      if (running && t.stageDetail) metaParts.push(t.stageDetail);
      else if (running && t.stage && STAGE_TEXT[t.stage]) metaParts.push(STAGE_TEXT[t.stage]);
    } else if (f === "host") {
      const host = hostOf(t.url);
      if (host) metaParts.push(host);
    } else if (f === "note") {
      if (done && t.note) metaParts.push(t.note);
    } else if (f === "error") {
      // 失败原因：核心已在信息行渲染 errText（failed/canceled/interrupted）时不再重复
      if (t.error && !(state === "failed" || state === "canceled" || state === "interrupted")) {
        metaParts.push(String(t.error).replace(/\s*\n\s*/g, " "));
      }
    }
  }
  const metaText = metaParts.join(fieldSep);

  // 进度条是否显示：progress=row/inline 才画，progressWhenDone=false 时完成态不画
  const showBar = progress !== "none" && (progressWhenDone || !done);

  let html = "";
  html += '<div class="dl' + (fold && expanded ? " expanded" : "") + densityClass + '">';
  html += '<div class="dl-row">';
  if (fold) {
    html += '<span class="dl-left">';
    html += '<button class="dl-fold' + (expanded ? " open" : "") + '" id="dl-fold" title="展开/收起详情">❯</button>';
    html += '<button class="dl-all' + (allExpanded ? " open" : "") + '" id="dl-all" title="展开/收起所有下载">□</button>';
    html += "</span>";
  }
  // 左侧图标形态（icon）——minimal 取 "none"，不额外画元素
  if (icon === "dot") {
    html += '<span class="dl-ico b-' + esc(badgeState) + '"></span>';
  } else if (icon === "badge") {
    // 40×40 格式徽章（图标 + 扩展名）——P1 细化
    html += '<span class="dl-ico-badge">' + esc(extOf(t.fileName)) + "</span>";
  }
  // 主行首元素（primary）——minimal 取 "badge"
  if (primary === "name") {
    html += '<span class="dl-name">' + esc(t.fileName || "—") + "</span>";
    html += '<span class="dl-badge b-' + esc(badgeState) + '">' + esc(badge) + "</span>";
  } else {
    html += '<span class="dl-badge b-' + esc(badgeState) + '">' + esc(badge) + "</span>";
  }

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

  // ── 动作按钮（theme.layout.actions）──
  let actList;
  if (pending || running) actList = actions.active || [];
  else if (done) actList = actions.done || [];
  else if (FINAL_STATES[state]) actList = actions.failed || [];
  else actList = [];
  for (const a of actList) {
    if (a === "cancel") {
      html += '<button class="dl-btn danger" id="dl-cancel">取消</button>';
    } else if (a === "open") {
      // 命令型（kind=command）与包安装型没有可打开的产物文件，跳过
      if (t.kind === "command" || pkgTask) continue;
      html += '<button class="dl-btn primary" id="dl-open">打开</button>';
    } else if (a === "folder") {
      // winget / pip 没有可打开的目标目录，跳过
      if (pkgTask) continue;
      if (t.kind === "command") {
        html += '<button class="dl-btn primary" id="dl-folder" title="打开目标目录">打开文件夹</button>';
      } else {
        html += '<button class="dl-btn" id="dl-folder" title="打开所在文件夹">文件夹</button>';
      }
    } else if (a === "copy") {
      // 复制路径（P0 · W4 契约对齐）：仅在任务有产物路径时给。
      // 复用核心已有的 #dl-copy 事件委托与 .dl-copy 反馈节点，不新增行为。
      // 注：fold:true 的主题其详情面板已常驻一个同 id 的复制按钮，主题一般无需要在 actions 里再列；
      // 内置 minimal（done 不含 copy）与 detail（fold:false，无详情面板）均不产生冲突。
      if (!filePath) continue;
      html += '<button class="dl-btn dl-copy" id="dl-copy" title="复制路径">复制路径</button>';
    } else if (a === "retry") {
      // 终态（失败 / 取消 / 中断）给一个圈箭头重试（2026-09-21）。
      // 箭头转圈 = 已提交，等它翻身；停止由 poll 驱动，状态一变这个分支就不再走。
      html += '<button class="dl-btn ico retry' + (retrying ? " spinning" : "") + '" id="dl-retry"'
        + ' title="' + (retrying ? "重试中…" : "重试下载") + '"'
        + (retrying ? " disabled" : "")
        + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M21 12a9 9 0 1 1-3.2-6.9"/><polyline points="21 4 21 10 15 10"/></svg>'
        + "</button>";
    }
  }
  // inline 进度条（与信息同行）——P1 细化；minimal 走 row 分支
  if (progress === "inline" && showBar) {
    html += '<span class="dl-track inline"><div class="' + barClass + '" style="width:' + barWidth + '%"></div></span>';
  }
  html += "</div>";

  // 进度条独占一行（2026-09-17）：数据组已上移，这里只留条本身。
  if (progress === "row" && showBar) {
    html += '<div class="dl-row2">';
    html += '<div class="dl-track"><div class="' + barClass + '" style="width:' + barWidth + '%"></div></div>';
    html += "</div>";
  }

  // 第三行已撤销（2026-09-14）：metaText 已并入上方信息行。

  // 详情面板仅在启用折叠的主题（fold:true）下渲染；minimal 为 true
  if (fold) {
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
  }

  // 错误行已上移到信息行（2026-09-14），此处不再重复渲染。
  html += "</div>";

  return html;
}
