// ui/shared/display.js — 进度文案的唯一来源
//
// 为什么要有这个文件：阶段文案表与计数单位表原本在 card.js 与 manager.js 各存一份，
// 而「这是包安装还是计数型任务」的判定在 index.js（工具面）、card.js（流内卡）、
// manager.js（管理器）各写了一遍。2026-09-19 改 pnpm 文案时就吃过一次亏：
// 两处都得改，漏一处就是同一个任务在两处显示不同说法。
//
// 这里只放**纯数据与纯判定**，不碰 DOM、不碰 hana.*，所以 Node 侧（index.js）
// 与浏览器侧（card.js / manager.js）都能 import。
//
// 三个消费方：
//   index.js    → 工具面文案（download-wait / 终态结算）
//   ui/card.js  → 聊天流进度卡
//   ui/manager.js → 跨会话管理器

/** 阶段标识 → 中文。git/pnpm 系与 winget/pip 系并存。 */
export const STAGE_TEXT = {
  // winget / pip 链路（2026-09-18）
  found: "查找包",
  downloading: "下载中",
  verifying: "校验哈希",
  installing: "安装中",
  collecting: "解析依赖",
  finalizing: "收尾",
  // git / pnpm 链路
  receiving: "接收中",
  checkout: "检出中",
  fetching: "拉取中",
  linking: "链接中",
  building: "编译中",
  "resolving-deps": "解析依赖",
  cloning: "准备克隆",
  enumerating: "枚举对象",
  resolving: "解析增量",
};

/** 计数单位 → 中文。git 的对象/文件数、pnpm 的包数都不是字节（2026-09-19）。 */
export const UNIT_NAME = { objects: "对象", files: "文件", packages: "包" };

/** 阶段文案；未知阶段回落到原标识。 */
export function stageLabel(stage) {
  if (!stage) return "";
  return STAGE_TEXT[stage] || String(stage);
}

/** 计数单位的后缀（含前导空格）；字节型返回空串。 */
export function unitSuffix(unit) {
  return UNIT_NAME[unit] ? ` ${UNIT_NAME[unit]}` : "";
}

/** 从任务对象取命令类型，兼容快照（cmdType）与任务对象（cmd.type）两种形态。 */
export function cmdTypeOf(task) {
  if (!task) return null;
  return task.cmdType || task.cmd?.type || null;
}

/** 包安装型：winget / pip。没有字节数据，只有阶段。 */
export function isPkgTask(task) {
  const t = cmdTypeOf(task);
  return t === "winget-install" || t === "pip-install";
}

/** git 克隆。 */
export function isCloneTask(task) {
  return cmdTypeOf(task) === "git-clone";
}

/** 计数型：received/total 是对象数/包数，不是字节（unit 非 bytes）。 */
export function isCountTask(task) {
  const u = task?.unit;
  return !!u && u !== "bytes";
}

/** 命令型（有产物路径可报）：git-clone / pnpm-install。 */
export function isCmdTask(task) {
  const t = cmdTypeOf(task);
  return t === "git-clone" || t === "pnpm-install";
}

/**
 * 任务显示名的唯一口径（2026-10-18）。
 *
 * 为什么收成函数：显示名原先在 index.js 里用 `a || b || c` 拼，任一段拿到 undefined
 * 就会漏到模型可见文本（`下载 undefined`）、宿主任务 label 和卡片标题里。
 * 这里按顺序取第一个非空字符串，全空则给固定兜底，保证**永远不是 undefined**。
 *
 * @param {...any} candidates 候选名（按优先级）
 * @returns {string}
 */
export function displayNameOf(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string") {
      const s = c.trim();
      if (s) return s;
      continue;
    }
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return "未命名任务";
}

/**
 * 任务进度的一行人话，三处共用。
 * 返回 null 表示该任务形态没有可报的进度（如包安装且阶段未知）。
 *
 * @param {object} task  任务快照（engine snapshot 或 /list 的一项）
 * @param {object} [opts]
 * @param {boolean} [opts.doneText] true 时终态用「完成：」而不是「进度：」（工具面用）
 */
export function progressText(task, opts = {}) {
  if (!task) return null;
  const { received, total } = task;
  if (isPkgTask(task)) return task.stage ? `阶段：${stageLabel(task.stage)}` : null;
  if (isCountTask(task)) {
    const suffix = unitSuffix(task.unit);
    const lead = opts.doneText && task.state === "done" ? "完成" : "进度";
    if (lead === "完成" && total) return `完成：${received ?? "?"}/${total}${suffix}`;
    if (task.stageDetail) return `${lead}：${task.stageDetail}`;
    return `${lead}：${received ?? "?"}${total ? `/${total}` : ""}${suffix}`;
  }
  if (total) {
    // 数值守卫（2026-10-18）：received 缺失时不能再硬算，否则会输出「进度：NaN%（undefined/100 字节）」。
    // 正常输入（snapshot 恒给数值）下输出与之前逐字节等价。
    if (!Number.isFinite(received)) return `进度：${total} 字节（已下载量未知）`;
    const pct = Math.round((received / total) * 100);
    return `进度：${pct}%（${received}/${total} 字节）`;
  }
  return `已下载：${received ?? "?"} 字节`;
}

/**
 * 工具面（download-wait）的一行文案 —— 保证返回值**永远是字符串**。
 *
 * 为什么要包一层：progressText 返回 null 是给 UI 的设计契约
 * （card.js / manager.js 靠 null 决定「这一行不渲染」），必须原样保留。
 * 但工具返回的 content[].text 是**模型可见字段**，宿主会直接读它的 .length，
 * 一旦是 null 就抛 `Cannot read properties of null (reading 'length')`，
 * 整条会话当场断掉（2026-10-18 事故：pip/winget 任务刚启动、stage 尚未赋值时）。
 *
 * 所以：UI 拿 progressText（可为 null），工具面拿 waitLineText（恒为字符串）。
 *
 * @param {object|null} snap 任务快照
 * @returns {string}
 */
export function waitLineText(snap) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return "快照缺失：暂无进度可报";
  // 空快照（引擎只回了 {}，既没状态也没进度）不能落成「已下载：? 字节」这种看似有数的脏话。
  const usable = !!snap.state || snap.received != null || snap.total != null || !!snap.stage;
  if (!usable) return "快照缺失：暂无进度可报";
  const running = snap.state === "running";
  const progressLine = progressText(snap, { doneText: true });
  // 包安装刚起步（stage 还没赋值）时 progressText 是 null，这里给一句人话，
  // 不能把 null 拼进文案，也不能出现「undefined｜null」这种脏数据。
  const body = progressLine || (running ? "进行中：暂无可报进度" : "暂无可报进度");
  const line = running ? body : `${snap.state || "未知状态"}｜${body}`;
  const text = snap.error ? `${line}｜错误：${snap.error}` : line;
  return typeof text === "string" && text ? text : "暂无进度可报";
}

// ── aria2 加速开关的文案（2026-10-18 W3，管理器设置菜单用）────────────

/**
 * 显示限制说明。必须显示在状态行下方。
 *
 * 为什么要写死一句：命令型任务（git clone / pip / pnpm / winget）是外部程序自己下网，
 * aria2 接不进去，开关对它们天然无效。不说清楚，用户会以为「开了没效果」。
 */
export const ARIA2_LIMIT_NOTE = "aria2 只加速普通文件下载；git clone / pip / pnpm 等命令型任务由对应程序自行下载，不受影响。";

/** 状态行里两个固定出口的文案。 */
export const ARIA2_STATUS_TEXT = Object.freeze({ off: "未启用", probing: "检测中…" });

/**
 * aria2 状态行文案的唯一口径（三态 + 检测中，共四条出口）。
 *
 *   检测中      → 「检测中…」
 *   未启用      → 「未启用」
 *   启用且可用  → 「已启用 · aria2 1.37.0 · 端口 6802」
 *   启用不可用  → 「已启用但不可用：<reason（来自 capabilities）>」
 *
 * 口径：**任何输入都不抛、且永远不出现 undefined/null**。capabilities 缺 version / port 时
 * 只省掉那一段，不写占位符（`aria2 undefined` 这种脏话会直接被用户看到）。
 *
 * @param {object} [input]
 * @param {boolean} [input.enabled] settings.aria2.enabled
 * @param {object|null} [input.cap] capabilities 回包 { available, version, port, reason }
 * @param {boolean} [input.probing] 正在探测（优先于一切，避免用户面对空白/旧值）
 * @param {string} [input.error] 探测请求本身失败时的错误文案（拿不到 cap 时兜底）
 * @returns {{ text: string, tone: "muted"|"probing"|"ok"|"danger", available: boolean }}
 */
export function aria2StatusText(input = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (src.probing === true) {
    return { text: ARIA2_STATUS_TEXT.probing, tone: "probing", available: false };
  }
  if (src.enabled !== true) {
    return { text: ARIA2_STATUS_TEXT.off, tone: "muted", available: false };
  }
  const cap = src.cap && typeof src.cap === "object" && !Array.isArray(src.cap) ? src.cap : null;
  // 取属性一律走 safeGet：cap 是老对象也可能带着会抛的 getter（探测回包被代理页/畸形 JSON 污染时），
  // 一个属性读取抛错不能把整个设置菜单带下去。
  const safeGet = (obj, key) => { try { return obj ? obj[key] : undefined; } catch { return undefined; } };
  if (cap && safeGet(cap, "available") === true) {
    const parts = ["已启用"];
    const verRaw = safeGet(cap, "version");
    const ver = typeof verRaw === "string" ? verRaw.trim() : "";
    if (ver) parts.push(`aria2 ${ver}`);
    const port = Number(safeGet(cap, "port"));
    if (Number.isInteger(port) && port > 0 && port <= 65535) parts.push(`端口 ${port}`);
    return { text: parts.join(" · "), tone: "ok", available: true };
  }
  const pickText = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const reason = pickText(cap && safeGet(cap, "reason")) || pickText(src.error) || "探测失败，原因未知";
  return { text: `已启用但不可用：${reason}`, tone: "danger", available: false };
}
