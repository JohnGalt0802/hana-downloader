// tests/unit-theme.mjs — ui/shared/theme.js 的离线单测（P0 · W1，2026-10-15 新增）
//
// 为什么要有它：theme.js 里的 DEFAULTS 与 ui/themes/minimal/theme.json 是同一批取值的
// 两份副本（一份给运行时兜底，一份给审核与人读）。没有这份断言，两边漂走了也没人知道，
// 而 minimal 是 P0 的回归基准，漂一点下游全错。
//
// 覆盖：合并继承正确 / 默认值填满无 undefined / 未知字段与越界取值被 validateTheme 拒收 /
//      listThemes 输出形态 / schema 与 minimal 的字段集对齐。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveTheme, validateTheme, listThemes, DEFAULT_THEME_ID, DEFAULTS,
} from "../ui/shared/theme.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const readJSON = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"));

const minimal = readJSON("ui/themes/minimal/theme.json");
const indexJson = readJSON("ui/themes/index.json");
const schema = readJSON("ui/themes/schema/theme.schema.json");

// 方案 §4.1 的 detail 示例（规范表达力的试金石）
const SPEC_DETAIL = {
  id: "detail",
  name: "详细",
  description: "信息常驻，一眼看全；适合文件管理场景",
  author: "onceblue59",
  version: 1,
  basedOn: "minimal",
  layout: {
    fold: false,
    icon: "badge",
    primary: "name",
    fields: ["size", "speed", "eta", "host"],
    fieldSep: " · ",
    progress: "row",
    progressWhenDone: false,
    density: "comfortable",
    actions: { done: ["open", "folder"], failed: ["retry"], active: ["cancel"] },
  },
  metrics: { width: 560, radius: 9, padding: "12px 14px", gap: 12, fontSize: 12 },
};

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const eq = (expect) => (actual) => JSON.stringify(actual) === JSON.stringify(expect);
const isTrue = (x) => x === true;
const isFalse = (x) => x === false;

// ── 0. DEFAULTS 必须逐字段等于内置基线 minimal ──
check("DEFAULTS.layout == minimal.layout", DEFAULTS.layout, eq(minimal.layout));
check("DEFAULTS.palette == minimal.palette", DEFAULTS.palette, eq(minimal.palette));
check("DEFAULTS.metrics == minimal.metrics", DEFAULTS.metrics, eq(minimal.metrics));
check("基线本身通过校验", validateTheme(minimal).ok, isTrue);

// ── 1. resolveTheme(基线自身) ──
const rMin = resolveTheme(minimal, [minimal]);
check("minimal: id/name/author/version", [rMin.id, rMin.name, rMin.author, rMin.version], eq(["minimal", "极简", "内置", 1]));
check("minimal: layout 原样", rMin.layout, eq(minimal.layout));
check("minimal: palette 原样", rMin.palette, eq(minimal.palette));
check("minimal: metrics 原样", rMin.metrics, eq(minimal.metrics));

// ── 2. 继承合并（detail 只写 layout + metrics.width）──
const detailRaw = {
  id: "detail", name: "详细", basedOn: "minimal",
  layout: { fold: false, icon: "badge", primary: "name", fields: ["size", "speed", "eta", "host"] },
  metrics: { width: 560 },
};
const rDetail = resolveTheme(detailRaw, [minimal, detailRaw]);
check("继承: 覆盖生效 fold=false", rDetail.layout.fold, isFalse);
check("继承: 覆盖生效 icon", rDetail.layout.icon, eq("badge"));
check("继承: 未覆盖 progress 从基线拿", rDetail.layout.progress, eq("row"));
check("继承: 未覆盖 fieldSep 从基线拿", rDetail.layout.fieldSep, eq(" · "));
check("继承: 未覆盖 density 从基线拿", rDetail.layout.density, eq("compact"));
check("继承: 未覆盖 actions 从基线拿", rDetail.layout.actions, eq(minimal.layout.actions));
check("继承: 数组整体替换 fields", rDetail.layout.fields, eq(["size", "speed", "eta", "host"]));
check("继承: metrics.width 覆盖", rDetail.metrics.width, eq(560));
check("继承: metrics.radius 从基线拿", rDetail.metrics.radius, eq(0));
check("继承: metrics.padding 从基线拿", rDetail.metrics.padding, eq("0 10px"));
check("继承: palette.light.text 从基线拿", rDetail.palette.light.text, eq("#101012"));
check("继承: palette.dark.track 从基线拿", rDetail.palette.dark.track, eq("rgba(255, 255, 255, 0.1)"));
check("不继承: id 用自己的", rDetail.id, eq("detail"));
check("不继承: name 用自己的", rDetail.name, eq("详细"));
check("不继承: description 不继承基线的描述", rDetail.description, eq(""));
check("不继承: author 不继承", rDetail.author, eq(""));
check("不继承: version 缺省为 1", rDetail.version, eq(1));

// ── 3. 三级继承链（a → b → c）──
const A = { id: "a", name: "A", metrics: { gap: 10, width: 480 }, layout: { density: "comfortable" }, palette: { light: { accent: "#111111" } } };
const B = { id: "b", name: "B", basedOn: "a", layout: { icon: "dot" } };
const C = { id: "c", name: "C", basedOn: "b", palette: { dark: { accent: "#222222" } } };
const rC = resolveTheme(C, [A, B, C]);
check("链: c 覆盖 dark.accent", rC.palette.dark.accent, eq("#222222"));
check("链: c 继承 b.icon", rC.layout.icon, eq("dot"));
check("链: c 隔代继承 a.density", rC.layout.density, eq("comfortable"));
check("链: c 隔代继承 a.metrics.gap", rC.metrics.gap, eq(10));
check("链: c 继承 a.light.accent", rC.palette.light.accent, eq("#111111"));
check("链: c 未覆盖项落默认", rC.layout.fold, isTrue);
check("链: c 未覆盖的 light.green 落默认", rC.palette.light.green, eq("#22C55E"));
check("链: 数组形态与 Map 形态一致", resolveTheme(C, new Map([["a", A], ["b", B], ["c", C]])).layout.icon, eq("dot"));

// ── 4. 默认值填满，不允许 undefined ──
const bare = resolveTheme({ id: "bare", name: "裸主题" }, []);
const undefPath = findUndefinedPath(bare);
check("裸主题: 无 undefined 叶子", undefPath, eq(null));
check("裸主题: fields 落默认", bare.layout.fields, eq(["eta", "stage", "note"]));
check("裸主题: actions 落默认", bare.layout.actions, eq({ active: ["cancel"], done: ["open", "folder"], failed: ["retry"] }));
check("裸主题: metrics 落默认", bare.metrics, eq(DEFAULTS.metrics));
check("裸主题: palette 落默认", bare.palette, eq(DEFAULTS.palette));
check("裸主题: 无 basedOn 时同样填满", Object.keys(bare.layout).length, eq(9));
check("resolveTheme 容错: null 输入不抛", (() => { try { return resolveTheme(null, null).id === ""; } catch { return false; } })(), isTrue);

// ── 5. 基线缺失 / 自指 / 环 回落内置默认，不抛 ──
const rMissing = resolveTheme({ id: "x", name: "X", basedOn: "nope" }, []);
check("缺基线: 回落内置默认 layout", rMissing.layout, eq(DEFAULTS.layout));
check("缺基线: 自身覆盖仍生效", resolveTheme({ id: "x", name: "X", basedOn: "nope", metrics: { width: 600 } }, []).metrics.width, eq(600));
check("自指: 不抛且落默认", resolveTheme({ id: "a", name: "A", basedOn: "a" }, [{ id: "a", name: "A", basedOn: "a" }]).layout, eq(DEFAULTS.layout));
const cyc = [{ id: "p", name: "P", basedOn: "q" }, { id: "q", name: "Q", basedOn: "p" }];
check("环: p 不抛", resolveTheme(cyc[0], cyc).layout, eq(DEFAULTS.layout));
check("环: q 不抛", resolveTheme(cyc[1], cyc).id, eq("q"));

// ── 6. 克隆隔离：返回对象改动不得污染 DEFAULTS ──
const rIso = resolveTheme({ id: "iso", name: "ISO" }, []);
rIso.layout.fields.push("host");
rIso.layout.actions.done.push("copy");
check("隔离: DEFAULTS.layout.fields 未被污染", DEFAULTS.layout.fields, eq(["eta", "stage", "note"]));
check("隔离: DEFAULTS.layout.actions.done 未被污染", DEFAULTS.layout.actions.done, eq(["open", "folder"]));
check("隔离: 两次 resolve 互不影响", resolveTheme({ id: "iso2", name: "ISO2" }, []).layout.fields, eq(["eta", "stage", "note"]));

// ── 7. validateTheme 收 ──
check("validate: minimal 通过", validateTheme(minimal).errors, eq([]));
const specRes = validateTheme(SPEC_DETAIL);
check("validate: 方案 §4.1 的 detail 示例通过", specRes.errors, eq([]));
check("validate: 只写必填字段的最小主题通过", validateTheme({ id: "tiny", name: "小" }).ok, isTrue);

// ── 8. validateTheme 拒收（未知字段 / 越界取值 / 违规内容）──
const rejects = [
  ["顶层未知字段", { ...minimal, foo: 1 }, "未知字段：foo"],
  ["layout 未知字段", withLayout(minimal, { whatever: true }), "layout.未知字段：whatever"],
  ["metrics 未知字段", withMetrics(minimal, { height: 10 }), "metrics.未知字段：height"],
  ["palette 未知字段", withPalette("light", { glow: "#fff" }), "palette.light.未知字段：glow"],
  ["palette 未知模式", withPalette("neon", { text: "#fff" }), "palette.未知字段：neon"],
  ["actions 未知状态", withLayout(minimal, { actions: { running: ["cancel"] } }), "layout.actions 未知状态：running"],
  ["actions 越权动作", withLayout(minimal, { actions: { active: ["open"] } }), "layout.actions.active 含该状态不允许的动作：open"],
  ["actions 造新动作", withLayout(minimal, { actions: { done: ["delete"] } }), "layout.actions.done 含该状态不允许的动作：delete"],
  ["fields 未知值", withLayout(minimal, { fields: ["size", "extra"] }), "layout.fields 含未知字段：extra"],
  ["fields 重复", withLayout(minimal, { fields: ["eta", "eta"] }), "layout.fields 字段重复：eta"],
  ["icon 越集", withLayout(minimal, { icon: "big" }), "layout.icon 取值不在允许集合"],
  ["progress 越集", withLayout(minimal, { progress: "bottom" }), "layout.progress 取值不在允许集合"],
  ["density 越集", withLayout(minimal, { density: "dense" }), "layout.density 取值不在允许集合"],
  ["primary 越集", withLayout(minimal, { primary: "size" }), "layout.primary 取值不在允许集合"],
  ["width 越界（大）", withMetrics(minimal, { width: 999 }), "metrics.width 越界"],
  ["width 越界（小）", withMetrics(minimal, { width: 100 }), "metrics.width 越界"],
  ["padding 非法", withMetrics(minimal, { padding: "12px 14px 3px 4px 5px" }), "metrics.padding 不是合法 CSS 内边距"],
  ["fontSize 非正", withMetrics(minimal, { fontSize: 0 }), "metrics.fontSize 必须是大于 0 的数字"],
  ["颜色非法", withPalette("light", { accent: "red" }), "palette.light.accent 不是合法颜色：red"],
  ["外部 URL", withLayout(minimal, { fieldSep: "https://evil.example/x" }), "不允许外部网络资源"],
  ["内联脚本", withLayout(minimal, { fieldSep: "<script>x</script>" }), "不允许可执行内容"],
  ["javascript: 协议", withLayout(minimal, { fieldSep: "javascript:alert(1)" }), "不允许可执行内容"],
  ["缺 id", { name: "无 id" }, "缺少必填字段 id"],
  ["缺 name", { id: "no-name" }, "缺少必填字段 name"],
  ["id 非 kebab-case", { ...minimal, id: "My_Theme" }, "id 必须是 kebab-case"],
  ["version 非正整数", { ...minimal, version: 0 }, "version 必须是从 1 起的整数"],
  ["basedOn 指向自身", { ...minimal, basedOn: "minimal" }, "basedOn 不能指向自身"],
  ["非对象", "not-an-object", "主题必须是 JSON 对象"],
];
for (const [name, raw, needle] of rejects) {
  const res = validateTheme(raw);
  check(`拒收: ${name}`, res, (r) => r.ok === false && r.errors.some((e) => e.includes(needle)));
}

function withLayout(base, patch) {
  return { ...base, layout: { ...base.layout, ...patch } };
}
function withMetrics(base, patch) {
  return { ...base, metrics: { ...base.metrics, ...patch } };
}
function withPalette(mode, tokens) {
  return { ...minimal, palette: { ...minimal.palette, [mode]: tokens } };
}

// ── 9. listThemes ──
const listed = listThemes(indexJson);
check("list: 条目数", listed.length, eq(2));
check("list: 首项 minimal", listed[0], eq({ id: "minimal", name: "极简", description: "默认主题。默认收起详情，信息行 + 一条进度，适合聊天流内快速扫读", author: "内置" }));
check("list: 每项恰好四个键", listed.every((t) => JSON.stringify(Object.keys(t)) === JSON.stringify(["id", "name", "description", "author"])), isTrue);
check("list: detail 占位条目在列", listed[1].id, eq("detail"));
check("list: detail 作者", listed[1].author, eq("onceblue59"));
check("list: 缺 name 回落 id", listThemes([{ id: "solo" }]), eq([{ id: "solo", name: "solo", description: "", author: "" }]));
check("list: 重复 id 去重", listThemes([{ id: "a", name: "A" }, { id: "a", name: "A2" }]).length, eq(1));
check("list: 无 id 条目丢弃", listThemes([{ name: "无名" }]).length, eq(0));
check("list: 非数组输入返回空", listThemes(null), eq([]));
check("list: {themes:[]} 形态同样可用", listThemes({ themes: [{ id: "a", name: "A" }] }).length, eq(1));
check("list: 接受 index.json 全量（含 planned 标记不泄漏）", Object.keys(listed[1]).includes("planned"), isFalse);

// ── 10. 常量与 schema 口径 ──
check("DEFAULT_THEME_ID", DEFAULT_THEME_ID, eq("minimal"));
check("DEFAULT_THEME_ID 在清单里", listed.some((t) => t.id === DEFAULT_THEME_ID), isTrue);
// schema 的三层用 $ref 指到 definitions（避免把字段表在顶层抄两遍），这里顺着 $ref 取
const DEF = schema.definitions;
const defOf = (name) => { const r = schema.properties[name]; return r && r.$ref ? DEF[r.$ref.split("/").pop()] : r; };

check("schema: 顶层 additionalProperties=false", schema.additionalProperties, isFalse);
check("schema: 必填 id/name", schema.required, eq(["id", "name"]));
check("schema: 顶层字段集与 minimal 对齐", Object.keys(schema.properties).sort(), eq(["author", "basedOn", "description", "id", "layout", "metrics", "name", "palette", "version"]));
check("schema: layout 字段集与 minimal 对齐", Object.keys(defOf("layout").properties).sort(), eq(Object.keys(minimal.layout).sort()));
check("schema: metrics 字段集与 minimal 对齐", Object.keys(defOf("metrics").properties).sort(), eq(Object.keys(minimal.metrics).sort()));
check("schema: token 字段集与 minimal 对齐", Object.keys(DEF.tokens.properties).sort(), eq(Object.keys(minimal.palette.light).sort()));
check("schema: fields 取值集", defOf("layout").properties.fields.items.enum, eq(["size", "speed", "eta", "stage", "host", "note", "error"]));
check("schema: icon 取值集", defOf("layout").properties.icon.enum, eq(["badge", "dot", "none"]));
check("schema: actions 三个状态组", Object.keys(defOf("layout").properties.actions.properties).sort(), eq(["active", "done", "failed"]));
check("schema: metrics.width 上下界", [defOf("metrics").properties.width.minimum, defOf("metrics").properties.width.maximum], eq([320, 720]));
check("schema: 每层 additionalProperties=false", [defOf("layout"), defOf("metrics"), defOf("palette"), DEF.tokens].every((s) => s.additionalProperties === false), isTrue);

function findUndefinedPath(v, p = "") {
  if (v === undefined) return p || "(root)";
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const r = findUndefinedPath(v[i], `${p}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const r = findUndefinedPath(v[k], p ? `${p}.${k}` : k);
      if (r) return r;
    }
    return null;
  }
  return null;
}

console.log(`\n=== theme: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
