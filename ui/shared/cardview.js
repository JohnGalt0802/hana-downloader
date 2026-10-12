// ui/shared/cardview.js — 聊天流下载卡片的标记生成（唯一来源）
//
// 纯函数：输入一份任务快照，输出 #dl-root 内部的 HTML 字符串。
// 不碰 DOM、不碰 SDK，因此可在 Node 侧单测与离线预览（tests/unit-cardview.mjs）。
//
// 2026-10-12 重构（用户要求）：卡片要在聊天信息流里自洽地表达「下载了什么」。
// 旧版把折叠箭头、全选框、详情键值表都塞进两行高的卡里，真正的实体（文件名）
// 反而看不见。新版只保留三件事：文件是谁（格式徽章 + 文件名）、到哪一步了
// （状态标签 + 体积/速度/原因）、能做什么（打开/文件夹/取消/重试）。

import { unitSuffix, isPkgTask, isCountTask } from "./display.js";

// ── 转义 ──
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── 数值格式化（与卡片一致，供模板使用）──
export function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n; let i = -1;
  do { v /= 1024; i += 1; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + units[i];
}

export function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return Math.max(1, Math.round(sec)) + "s";
  if (sec < 3600) return Math.round(sec / 60) + "m";
  return (sec / 3600).toFixed(1) + "h";
}

// ── 文件类型判定：决定徽章配色与角标文字 ──
const KIND_BY_EXT = {
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab"],
  exe: ["exe", "msi", "dmg", "appimage", "deb", "rpm", "apk"],
  pdf: ["pdf"],
  img: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff"],
  vid: ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv"],
  aud: ["mp3", "flac", "wav", "m4a", "ogg", "aac", "opus"],
  code: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "json", "html", "css", "sh", "ps1", "yml", "yaml", "toml", "xml", "c", "cpp", "h", "java", "go", "rs", "rb", "php"],
  txt: ["txt", "md", "csv", "log", "ini", "cfg", "conf"],
  model: ["bin", "safetensors", "gguf", "pth", "pt", "onnx", "ckpt", "h5", "pb"],
};

export function fileKind(name) {
  const s = String(name || "");
  const m = /\.([a-z0-9]{1,12})$/i.exec(s);
  const ext = m ? m[1].toLowerCase() : "";
  // 角标文字：短扩展名直接给（ZIP / EXE / PDF）；超过 4 字符的（safetensors / gguf）不硬截，
  // 截成 “SAFE” 反而没了语义——交给图标 + title 表达。无扩展名给 FILE。
  const badge = ext && ext.length <= 4 ? ext.toUpperCase() : (ext ? "" : "FILE");
  for (const [kind, list] of Object.entries(KIND_BY_EXT)) {
    if (ext && list.includes(ext)) return { kind, ext: badge, fullExt: ext.toUpperCase() };
  }
  return { kind: "file", ext: badge, fullExt: ext ? ext.toUpperCase() : "" };
}

// ── 图标（内联 SVG，线稿风格，stroke 跟随 currentColor）──
// 注意：下面的值统一用 svg() 包一层，生成完整的 <svg> 元素。
// 裸 <path> 直接内联进 HTML 不在 SVG 命名空间里，浏览器不会渲染（实测踩过）。
const svg = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + p + "</svg>";

const ICON = {
  archive: svg('<path d="M3 8l9-4 9 4v9a1 1 0 0 1-.6.9l-8 3.4a1 1 0 0 1-.8 0l-8-3.4A1 1 0 0 1 3 17z"/><path d="M3 8l9 4 9-4"/><path d="M12 12v9"/>'),
  exe: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6.2" cy="6.5" r=".6"/>'),
  pdf: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  img: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/>'),
  vid: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/>'),
  aud: svg('<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>'),
  code: svg('<path d="M9 8l-5 4 5 4"/><path d="M15 8l5 4-5 4"/>'),
  txt: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>'),
  model: svg('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
};

const ACT_ICON = {
  open: svg('<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'),
  folder: svg('<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>'),
  cancel: svg('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  retry: svg('<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 5v6h-6"/>'),
};

// 取 URL 主机名（副行的来源提示；拿不到就返回空串）
function hostOf(url) {
  try { return new URL(String(url || "")).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/**
 * 生成卡片内部 HTML。
 * @param {object} t 任务快照（引擎 /wait 返回的 task）
 * @returns {string} #dl-root 内部 HTML
 */
export function renderCardHTML(t) {
  if (!t) return "";

  const state = t.state;
  const running = state === "running";
  const pending = state === "pending";
  const done = state === "done";
  const failed = state === "failed" || state === "canceled" || state === "interrupted";
  const pkgTask = isPkgTask(t);
  const count = isCountTask(t);
  const known = t.total != null && t.total > 0;
  const pct = t.percent;
  const unit = t.unit;

  // 卡片主实体：文件名（URL 退居副行，不再抢主标题）
  const rawName = t.fileName || t.url || t.taskId || "下载任务";
  const name = String(rawName);
  const { kind, ext, fullExt } = fileKind(name);
  const filePath = t.filePath || "";

  // ── 状态标签（唯一的状态信号，不再与百分比/进度条重复三次）──
  let tagCls = "run";
  let tagText = "";
  if (done) { tagCls = "ok"; tagText = "✓ 已完成"; }
  else if (running) {
    if (t.stalled) { tagCls = "warn"; tagText = "停滞"; }
    else { tagCls = "run"; tagText = known && pct != null ? Math.round(pct) + "%" : "下载中"; }
  } else if (pending) { tagCls = "idle"; tagText = t.queued ? "排队中" : "准备中"; }
  else if (state === "failed") { tagCls = "err"; tagText = "失败"; }
  else if (state === "canceled") { tagCls = "err"; tagText = "已取消"; }
  else if (state === "interrupted") { tagCls = "err"; tagText = "已中断"; }
  else { tagCls = "idle"; tagText = state || "—"; }

  // ── 副行：体积 / 速度 / 剩余 / 原因 ──
  let subText = "";
  let subErr = false;
  if (done) {
    const parts = [];
    if (known) parts.push(count ? t.total + unitSuffix(unit) : fmtBytes(t.total));
    // 来源主机：设计稿里副行是「体积 · 来源」，给产物一个出处（轻量、不抢眼）
    const host = hostOf(t.url);
    if (host) parts.push(host);
    if (t.note) parts.push(t.note);
    subText = parts.join(" · ") || "已完成";
  } else if (running) {
    const parts = [];
    if (count) parts.push((t.received || 0) + (known ? "/" + t.total : "") + unitSuffix(unit));
    else if (known) parts.push(fmtBytes(t.received || 0) + " / " + fmtBytes(t.total));
    else parts.push(fmtBytes(t.received || 0));
    if (t.speed > 0) parts.push(fmtBytes(t.speed) + "/s");
    if (known && t.speed > 0 && t.total - (t.received || 0) > 0) {
      const eta = fmtDuration((t.total - t.received) / t.speed);
      if (eta) parts.push("剩" + eta);
    }
    subText = parts.join(" · ") || "下载中…";
  } else if (pending) {
    // 副行不重复标签文案：标签已说「排队中/准备中」，这里给来源主机（可用信息）
    subText = hostOf(t.url) || (t.queued ? "等待开始" : "准备中…");
  } else if (failed) {
    subErr = true;
    subText = String(t.error || "下载失败").replace(/\s*\n\s*/g, " ");
  } else {
    subText = "—";
  }

  // ── 进度条：完成态不显示（减少视觉噪声）；仅对确定进度画填充 ──
  let progress = "";
  if (!done) {
    const indet = pending || (!known && !failed);
    const barCls = "dl-bar" + (indet ? " indet" : "") + (failed ? " err" : "");
    const w = indet ? 40 : (known && pct != null ? Math.min(100, pct) : 0);
    progress = '<div class="dl-progress"><div class="dl-track">'
      + '<div class="' + barCls + '" style="width:' + w + '%"></div>'
      + "</div></div>";
  }

  // ── 动作区（按状态给最少必要按钮）──
  let actions = "";
  if (pending || running) {
    actions = '<button class="dl-btn icon" id="dl-cancel" title="取消下载">' + ACT_ICON.cancel + "</button>";
  } else if (done) {
    if (pkgTask) {
      actions = ""; // winget / pip 无可打开的产物
    } else if (t.kind === "command") {
      actions = '<button class="dl-btn" id="dl-folder" title="打开目标目录">' + ACT_ICON.folder + "打开文件夹</button>";
    } else {
      actions = '<button class="dl-btn primary" id="dl-open" title="打开文件">' + ACT_ICON.open + "打开</button>"
        + '<button class="dl-btn icon" id="dl-folder" title="打开所在文件夹' + (filePath ? "\n" + esc(filePath) : "") + '">' + ACT_ICON.folder + "</button>";
    }
  } else if (failed) {
    actions = '<button class="dl-btn" id="dl-retry" title="重试下载">' + ACT_ICON.retry + "重试</button>";
  }

  // ── 组装 ──
  let html = '<div class="dl">';
  html += '<div class="dl-main">';
  html += '<div class="dl-badge-icon k-' + kind + '" title="' + esc(fullExt || "文件") + '">'
    + '<span class="dl-badge-svg">' + (ICON[kind] || ICON.file) + "</span>"
    + (ext ? '<span class="dl-badge-ext">' + esc(ext) + "</span>" : "")
    + "</div>";
  html += '<div class="dl-info">';
  html += '<div class="dl-title-row">';
  html += '<span class="dl-name" title="' + esc(name) + '">' + esc(name) + "</span>";
  html += '<span class="dl-tag ' + tagCls + '">' + esc(tagText) + "</span>";
  html += "</div>";
  html += '<div class="dl-sub' + (subErr ? " err" : "") + '" title="' + esc(subText) + '">' + esc(subText) + "</div>";
  html += "</div>";
  if (actions) html += '<div class="dl-actions">' + actions + "</div>";
  html += "</div>";
  html += progress;
  html += "</div>";
  return html;
}
