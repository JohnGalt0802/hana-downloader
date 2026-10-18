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
