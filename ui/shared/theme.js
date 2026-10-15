// ui/shared/theme.js — 声明式卡片主题的数据层（P0 · W1）
//
// 职责（只做数据：不碰 DOM、不碰 hana.*、不读全局状态，所以 Node 侧可直接 import 测试）：
//   ① resolveTheme   把 theme.json 原始定义与其 basedOn 继承链合并成完整 Theme
//   ② validateTheme  按方案第七节 7.2 的审核清单机械校验一份 theme.json
//   ③ listThemes     把 index.json 的条目整理成管理器枚举用的清单
//
// 默认值 = 内置基线 minimal 的取值（施工文档 §2.1：resolveTheme 必须填满，不允许 undefined）。
// DEFAULTS 与 ui/themes/minimal/theme.json 的一致性由 tests/unit-theme.mjs 逐字段比对兜底，
// 免得两边各存一份后悄悄漂走。
//
// 合并规则（方案第六节）：对象深合并；数组整体替换（fields 不做逐项合并，避免顺序歧义）；
// id / name / description / author / version 不继承，只从 theme.json 自身取。

/** 默认主题 id（方案 §11 决策 3：新装用户默认极简） */
export const DEFAULT_THEME_ID = "minimal";

/** 结构层默认值（= minimal 的 layout） */
export const DEFAULT_LAYOUT = {
  fold: true,
  icon: "none",           // 现状卡片无文件类型图标（ui/card.js 的 render 不输出 .dl-icon）
  primary: "badge",       // 状态徽章打头
  fields: ["eta", "stage", "note"],
  fieldSep: " · ",
  progress: "row",        // 进度条独占一行
  progressWhenDone: true, // 完成态保留绿条
  density: "compact",
  actions: {
    active: ["cancel"],
    done: ["open", "folder"],
    failed: ["retry"],
  },
};

/** 样式层默认值（= ui/card.css 的 :root / body.t-dark） */
export const DEFAULT_PALETTE = {
  light: {
    text: "#101012",
    muted: "#45484D",
    accent: "#3B82F6",
    green: "#22C55E",
    danger: "#EF4444",
    warn: "#B45309",
    track: "rgba(0, 0, 0, 0.07)",
    surface: "rgba(0, 0, 0, 0.06)",
  },
  dark: {
    text: "#E1EAF0",
    muted: "#B7C5CE",
    accent: "#7C9BFF",
    green: "#4ADE80",
    danger: "#F87171",
    warn: "#FBBF24",
    track: "rgba(255, 255, 255, 0.1)",
    surface: "rgba(255, 255, 255, 0.08)",
  },
};

/** 尺寸层默认值（= minimal 的 metrics；对应 .dl 的 width/padding、.dl-row 的 gap、body 的 font-size） */
export const DEFAULT_METRICS = {
  width: 400,
  radius: 0,
  padding: "0 10px",
  gap: 8,
  fontSize: 11.5,
};

/** 默认值汇总（供测试与 cardview 对照） */
export const DEFAULTS = { layout: DEFAULT_LAYOUT, palette: DEFAULT_PALETTE, metrics: DEFAULT_METRICS };

// ── 校验用的取值集（与 schema 同一份口径）──
const TOP_KEYS = ["id", "name", "description", "author", "version", "basedOn", "layout", "palette", "metrics"];
const LAYOUT_KEYS = ["fold", "icon", "primary", "fields", "fieldSep", "progress", "progressWhenDone", "density", "actions"];
const METRIC_KEYS = ["width", "radius", "padding", "gap", "fontSize"];
const PALETTE_KEYS = ["light", "dark"];
const TOKEN_KEYS = ["text", "muted", "accent", "green", "danger", "warn", "track", "surface"];
const ICON_VALUES = ["badge", "dot", "none"];
const PRIMARY_VALUES = ["name", "badge"];
const FIELD_VALUES = ["size", "speed", "eta", "stage", "host", "note", "error"];
const PROGRESS_VALUES = ["row", "inline", "none"];
const DENSITY_VALUES = ["compact", "comfortable"];
// 各状态的允许动作集：动作行为由核心实现，主题只挑不造
const ACTIONS_ALLOWED = {
  active: ["cancel"],
  done: ["open", "folder", "copy"],
  failed: ["retry"],
};

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([^()]*\))$/;
const PADDING_RE = /^\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw)?(?: \d+(?:\.\d+)?(?:px|em|rem|%|vh|vw)?){0,3}$/;

// ── 小工具 ──
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** JSON 安全深拷贝（主题数据只有 JSON 值，用序列化即可，且天然切断与 DEFAULTS 的引用共享） */
function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 深合并：对象逐键递归，数组 / 标量整体替换右侧 */
function deepMerge(base, over) {
  if (!isPlainObject(over)) return deepClone(base);
  const out = isPlainObject(base) ? deepClone(base) : {};
  for (const key of Object.keys(over)) {
    const next = over[key];
    if (isPlainObject(next) && isPlainObject(out[key])) out[key] = deepMerge(out[key], next);
    else out[key] = deepClone(next);
  }
  return out;
}

function asString(v) {
  return typeof v === "string" ? v : "";
}

function asVersion(v) {
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/** 把 allRawThemes 归一成 id → raw 的 Map。接受数组 / Map / { id: raw } 三种形态。 */
function indexById(allRawThemes) {
  const map = new Map();
  const put = (t) => {
    if (!isPlainObject(t)) return;
    const id = asString(t.id);
    if (id && !map.has(id)) map.set(id, t);
  };
  if (Array.isArray(allRawThemes)) {
    allRawThemes.forEach(put);
  } else if (allRawThemes instanceof Map) {
    allRawThemes.forEach((v, k) => put(isPlainObject(v) && !v.id ? { ...v, id: String(k) } : v));
  } else if (isPlainObject(allRawThemes)) {
    if (Array.isArray(allRawThemes.themes)) allRawThemes.themes.forEach(put);
    for (const key of Object.keys(allRawThemes)) {
      if (key === "themes") continue;
      const v = allRawThemes[key];
      if (!isPlainObject(v)) continue;
      put(asString(v.id) ? v : { ...v, id: key });
    }
  }
  return map;
}

/** 沿 basedOn 往上取继承链：[raw, 基线, 基线的基线, …]。环 / 缺基线 / 超深就地断开。 */
function inheritanceChain(raw, index) {
  const chain = [raw];
  const seen = new Set([asString(raw.id)]);
  let cur = raw;
  for (let depth = 0; depth < 16; depth += 1) {
    const baseId = asString(cur.basedOn);
    if (!baseId) break;
    if (seen.has(baseId)) break; // 自指或环
    const base = index.get(baseId);
    if (!base) break; // 基线不存在 → 回落内置默认（方案 §6.4）
    seen.add(baseId);
    chain.push(base);
    cur = base;
  }
  return chain;
}

// ── resolveTheme ──
/**
 * 合并继承：把 raw 与其 basedOn 链逐层合并，返回完整主题对象（未覆盖字段落默认值）。
 * @param {object} raw            theme.json 解析后的原始定义
 * @param {object|Array|Map} allRawThemes 全部候选主题（用于解析 basedOn 链）
 * @returns {object} Theme
 */
export function resolveTheme(raw, allRawThemes) {
  const src = isPlainObject(raw) ? raw : {};
  const index = indexById(allRawThemes);
  const chain = inheritanceChain(src, index);

  let layout = {};
  let palette = {};
  let metrics = {};
  // 自基线往回合并：链尾是最底层的基线，raw 覆盖最靠后生效。
  // 只合并 layout / palette / metrics 三段——身份字段（id/name/description/author/version）
  // 不参与继承，因此根本不会被基线带进来。
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const layer = chain[i];
    layout = deepMerge(layout, isPlainObject(layer.layout) ? layer.layout : {});
    palette = deepMerge(palette, isPlainObject(layer.palette) ? layer.palette : {});
    metrics = deepMerge(metrics, isPlainObject(layer.metrics) ? layer.metrics : {});
  }

  layout = deepMerge(DEFAULT_LAYOUT, layout);
  palette = deepMerge(DEFAULT_PALETTE, palette);
  metrics = deepMerge(DEFAULT_METRICS, metrics);

  return {
    id: asString(src.id),
    name: asString(src.name) || asString(src.id),
    description: asString(src.description),
    author: asString(src.author),
    version: asVersion(src.version),
    layout,
    palette,
    metrics,
  };
}

// ── validateTheme ──
/**
 * 校验一份 theme.json（方案 §7.2 审核清单的机械实现）。
 * @param {object} raw
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTheme(raw) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (!isPlainObject(raw)) {
    push("主题必须是 JSON 对象");
    return { ok: false, errors };
  }

  // 顶层
  checkUnknownKeys(raw, TOP_KEYS, "", push);
  if (typeof raw.id !== "string" || !raw.id) push("缺少必填字段 id（字符串）");
  else if (!KEBAB_RE.test(raw.id)) push(`id 必须是 kebab-case：${raw.id}`);
  if (typeof raw.name !== "string" || !raw.name) push("缺少必填字段 name（字符串）");
  if (raw.description !== undefined && typeof raw.description !== "string") push("description 必须是字符串");
  if (raw.author !== undefined && typeof raw.author !== "string") push("author 必须是字符串");
  if (raw.version !== undefined && (!Number.isInteger(raw.version) || raw.version < 1)) push("version 必须是从 1 起的整数");
  if (raw.basedOn !== undefined) {
    if (typeof raw.basedOn !== "string" || !KEBAB_RE.test(raw.basedOn)) push("basedOn 必须是 kebab-case 主题 id");
    else if (raw.basedOn === raw.id) push("basedOn 不能指向自身");
  }

  // 结构层
  if (raw.layout !== undefined) {
    const L = raw.layout;
    if (!isPlainObject(L)) push("layout 必须是对象");
    else {
      checkUnknownKeys(L, LAYOUT_KEYS, "layout.", push);
      if (L.fold !== undefined && typeof L.fold !== "boolean") push("layout.fold 必须是布尔值");
      checkEnum(L, "icon", ICON_VALUES, "layout.", push);
      checkEnum(L, "primary", PRIMARY_VALUES, "layout.", push);
      checkEnum(L, "progress", PROGRESS_VALUES, "layout.", push);
      checkEnum(L, "density", DENSITY_VALUES, "layout.", push);
      if (L.progressWhenDone !== undefined && typeof L.progressWhenDone !== "boolean") push("layout.progressWhenDone 必须是布尔值");
      if (L.fieldSep !== undefined && (typeof L.fieldSep !== "string" || !L.fieldSep)) push("layout.fieldSep 必须是非空字符串");
      if (L.fields !== undefined) {
        if (!Array.isArray(L.fields)) push("layout.fields 必须是数组");
        else {
          const seen = new Set();
          for (const f of L.fields) {
            if (typeof f !== "string" || !FIELD_VALUES.includes(f)) push(`layout.fields 含未知字段：${f}`);
            else if (seen.has(f)) push(`layout.fields 字段重复：${f}`);
            else seen.add(f);
          }
        }
      }
      if (L.actions !== undefined) {
        if (!isPlainObject(L.actions)) push("layout.actions 必须是对象");
        else {
          for (const key of Object.keys(L.actions)) {
            const allowed = ACTIONS_ALLOWED[key];
            if (!allowed) { push(`layout.actions 未知状态：${key}`); continue; }
            if (!Array.isArray(L.actions[key])) { push(`layout.actions.${key} 必须是数组`); continue; }
            const seen = new Set();
            for (const a of L.actions[key]) {
              if (typeof a !== "string" || !allowed.includes(a)) push(`layout.actions.${key} 含该状态不允许的动作：${a}`);
              else if (seen.has(a)) push(`layout.actions.${key} 动作重复：${a}`);
              else seen.add(a);
            }
          }
        }
      }
    }
  }

  // 样式层
  if (raw.palette !== undefined) {
    const P = raw.palette;
    if (!isPlainObject(P)) push("palette 必须是对象");
    else {
      checkUnknownKeys(P, PALETTE_KEYS, "palette.", push);
      for (const mode of PALETTE_KEYS) {
        if (P[mode] === undefined) continue;
        if (!isPlainObject(P[mode])) { push(`palette.${mode} 必须是对象`); continue; }
        checkUnknownKeys(P[mode], TOKEN_KEYS, `palette.${mode}.`, push);
        for (const token of Object.keys(P[mode])) {
          if (!TOKEN_KEYS.includes(token)) continue;
          const v = P[mode][token];
          if (typeof v !== "string" || !COLOR_RE.test(v)) push(`palette.${mode}.${token} 不是合法颜色：${v}`);
        }
      }
    }
  }

  // 尺寸层
  if (raw.metrics !== undefined) {
    const M = raw.metrics;
    if (!isPlainObject(M)) push("metrics 必须是对象");
    else {
      checkUnknownKeys(M, METRIC_KEYS, "metrics.", push);
      if (M.width !== undefined) {
        if (!isFiniteNumber(M.width)) push("metrics.width 必须是数字");
        else if (M.width < 320 || M.width > 720) push(`metrics.width 越界（允许 320~720）：${M.width}`);
      }
      if (M.radius !== undefined && (!isFiniteNumber(M.radius) || M.radius < 0)) push("metrics.radius 必须是不小于 0 的数字");
      if (M.gap !== undefined && (!isFiniteNumber(M.gap) || M.gap < 0)) push("metrics.gap 必须是不小于 0 的数字");
      if (M.fontSize !== undefined && (!isFiniteNumber(M.fontSize) || M.fontSize <= 0)) push("metrics.fontSize 必须是大于 0 的数字");
      if (M.padding !== undefined && (typeof M.padding !== "string" || !PADDING_RE.test(M.padding))) push(`metrics.padding 不是合法 CSS 内边距：${M.padding}`);
    }
  }

  // 越界内容：外部网络资源与可执行内容（方案 §7.1）
  scanForbidden(raw, "", push);

  return { ok: errors.length === 0, errors };
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function checkUnknownKeys(obj, allowed, prefix, push) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) push(`${prefix}未知字段：${key}`);
  }
}

function checkEnum(obj, key, allowed, prefix, push) {
  if (obj[key] === undefined) return;
  if (typeof obj[key] !== "string" || !allowed.includes(obj[key])) {
    push(`${prefix}${key} 取值不在允许集合（${allowed.join(" / ")}）：${obj[key]}`);
  }
}

/** 递归扫全部字符串值：不允许外部 URL、`<script`、`javascript:`、`data:text/html` */
function scanForbidden(value, path, push) {
  if (typeof value === "string") {
    if (/https?:\/\//i.test(value) || /^\/\//.test(value)) push(`${path} 不允许外部网络资源`);
    else if (/<script|javascript:|data:text\/html/i.test(value)) push(`${path} 不允许可执行内容`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbidden(v, `${path}[${i}]`, push));
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) scanForbidden(value[key], path ? `${path}.${key}` : key, push);
  }
}

// ── listThemes ──
/**
 * 从 index.json 的条目数组取清单（供管理器枚举）。
 * @param {Array|{themes:Array}} indexEntries
 * @returns {Array<{id:string,name:string,description:string,author:string}>}
 */
export function listThemes(indexEntries) {
  const list = Array.isArray(indexEntries)
    ? indexEntries
    : isPlainObject(indexEntries) && Array.isArray(indexEntries.themes)
      ? indexEntries.themes
      : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const id = asString(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: asString(entry.name) || id,
      description: asString(entry.description),
      author: asString(entry.author),
    });
  }
  return out;
}
