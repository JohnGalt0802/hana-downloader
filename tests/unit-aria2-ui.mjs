// tests/unit-aria2-ui.mjs — aria2 开关的三态文案（2026-10-18 W3）
//
// 只测一件事：ui/shared/display.js 的 aria2StatusText（管理器设置菜单状态行的唯一口径）
// 与 ARIA2_LIMIT_NOTE（显示限制说明）。UI 本身不好单测，但这层文案是 DOM 之外唯一的
// 可测纯函数——文案错了用户直接看到错话，所以必须有网。
//
// 口径（与实现注释、W3 任务书一致）：
//   检测中            → 「检测中…」
//   未启用            → 「未启用」
//   启用且可用        → 「已启用 · aria2 1.37.0 · 端口 6802」
//   启用但不可用      → 「已启用但不可用：<reason>」
//   · 任何输入都不抛，且永远不出现 undefined / null
//   · 只用 enabled=true 算开（"yes" / 1 都不算）
//
// 用法（仓库根目录）：node tests/unit-aria2-ui.mjs
// 退出码：全过 0，有失败 1。
import { aria2StatusText, ARIA2_LIMIT_NOTE, ARIA2_STATUS_TEXT } from "../ui/shared/display.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}
const clean = (x) => typeof x.text === "string" && x.text.length > 0
  && !x.text.includes("undefined") && !x.text.includes("null") && !x.text.includes("NaN");

// ── 1. 检测中优先于一切 ──
check("probing → 检测中…", aria2StatusText({ probing: true }), (x) => x.text === "检测中…" && x.tone === "probing");
check("probing 压过 enabled+cap", aria2StatusText({ probing: true, enabled: true, cap: { available: true, version: "1.37.0", port: 6802 } }),
  (x) => x.text === "检测中…");
check("probing 压过 error", aria2StatusText({ probing: true, enabled: true, error: "boom" }), (x) => x.text === "检测中…");

// ── 2. 未启用 ──
check("enabled=false → 未启用", aria2StatusText({ enabled: false }), (x) => x.text === "未启用" && x.tone === "muted" && x.available === false);
check("enabled 缺省 → 未启用", aria2StatusText({}), (x) => x.text === "未启用");
check("enabled 不是布尔 true 不算开（\"yes\"）", aria2StatusText({ enabled: "yes", cap: { available: true } }), (x) => x.text === "未启用");
check("enabled 不是布尔 true 不算开（1）", aria2StatusText({ enabled: 1 }), (x) => x.text === "未启用");
check("未启用时不看 cap（哪怕 cap 说可用）", aria2StatusText({ enabled: false, cap: { available: true, version: "9.9.9", port: 1234 } }),
  (x) => x.text === "未启用");

// ── 3. 已启用且可用（含 version / port 两个可省段）──
check("可用三要素", aria2StatusText({ enabled: true, cap: { available: true, version: "1.37.0", port: 6802 } }),
  (x) => x.text === "已启用 · aria2 1.37.0 · 端口 6802" && x.tone === "ok" && x.available === true);
check("可用：缺 version 只省该段", aria2StatusText({ enabled: true, cap: { available: true, port: 6802 } }),
  (x) => x.text === "已启用 · 端口 6802");
check("可用：缺 port 只省该段", aria2StatusText({ enabled: true, cap: { available: true, version: "1.37.0" } }),
  (x) => x.text === "已启用 · aria2 1.37.0");
check("可用：两段都缺只剩已启用", aria2StatusText({ enabled: true, cap: { available: true } }), (x) => x.text === "已启用");
check("可用：version 空串不产脏话", aria2StatusText({ enabled: true, cap: { available: true, version: "  ", port: 6802 } }),
  (x) => x.text === "已启用 · 端口 6802");
check("可用：port 非法不产脏话", aria2StatusText({ enabled: true, cap: { available: true, version: "1.37.0", port: 99999 } }),
  (x) => x.text === "已启用 · aria2 1.37.0");
check("可用：port 是字符串数字也认", aria2StatusText({ enabled: true, cap: { available: true, version: "1.37.0", port: "6802" } }),
  (x) => x.text === "已启用 · aria2 1.37.0 · 端口 6802");

// ── 4. 已启用但不可用 ──
check("不可用带 reason", aria2StatusText({ enabled: true, cap: { available: false, reason: "未检测到 aria2c" } }),
  (x) => x.text === "已启用但不可用：未检测到 aria2c" && x.tone === "danger" && x.available === false);
check("不可用：reason 原样透传（端口占用）", aria2StatusText({ enabled: true, cap: { available: false, reason: "端口被占用" } }),
  (x) => x.text === "已启用但不可用：端口被占用");
check("不可用：无 reason 时用 error", aria2StatusText({ enabled: true, cap: { available: false }, error: "探测请求失败（引擎不可达）" }),
  (x) => x.text === "已启用但不可用：探测请求失败（引擎不可达）");
check("不可用：cap 都没有时才看 error", aria2StatusText({ enabled: true, error: "引擎不可达" }),
  (x) => x.text === "已启用但不可用：引擎不可达");
check("不可用：全都缺也有兜底", aria2StatusText({ enabled: true }), (x) => x.text === "已启用但不可用：探测失败，原因未知");
check("不可用：cap 是 null 不崩", aria2StatusText({ enabled: true, cap: null }), clean);
check("不可用：reason 是空白串不产脏话", aria2StatusText({ enabled: true, cap: { available: false, reason: "   " } }),
  (x) => x.text === "已启用但不可用：探测失败，原因未知");
check("不可用：reason 非字符串不产脏话", aria2StatusText({ enabled: true, cap: { available: false, reason: 123 } }),
  (x) => x.text === "已启用但不可用：探测失败，原因未知");

// ── 5. 任何输入都不抛、都不产脏文案 ──
const WEIRD = [
  undefined, null, 0, 1, "", "x", true, false, [], [1],
  {}, { enabled: true }, { enabled: true, cap: [] }, { enabled: true, cap: "x" }, { enabled: true, cap: {} },
  { probing: "true", enabled: true }, { probing: 1, enabled: true },
  { enabled: true, cap: { available: "true" } },
  { enabled: true, cap: { available: true, version: {}, port: {} } },
  { enabled: true, cap: { available: true, version: "1.37.0", port: NaN } },
  { enabled: true, cap: { get available() { throw new Error("boom"); } } },
];
let threw = 0;
const texts = [];
for (const w of WEIRD) {
  try { texts.push(aria2StatusText(w)); } catch { threw++; }
}
check("畸形输入全部不抛", threw, (x) => x === 0);
check("畸形输入全部产出干净文案", texts.every(clean), (x) => x === true);
check("畸形输入 tone 恒在四档内", texts.every((x) => ["muted", "probing", "ok", "danger"].includes(x.tone)), (x) => x === true);
check("畸形输入 available 恒为布尔", texts.every((x) => typeof x.available === "boolean"), (x) => x === true);

// ── 6. 显示限制说明 ──
check("限制说明存在且是字符串", ARIA2_LIMIT_NOTE, (x) => typeof x === "string" && x.length > 0);
check("限制说明点了三类命令型任务", ARIA2_LIMIT_NOTE, (x) => /git clone/.test(x) && /pip/.test(x) && /pnpm/.test(x));
check("限制说明说清只加速普通文件", ARIA2_LIMIT_NOTE, (x) => /只加速普通文件下载/.test(x));
check("固定出口文案", ARIA2_STATUS_TEXT, (x) => x.off === "未启用" && x.probing === "检测中…");

console.log(`\nunit-aria2-ui: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
