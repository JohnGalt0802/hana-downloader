// tests/unit-aria2-config.mjs — aria2 配置读取与归一（2026-10-18）
//
// 只测一件事：normalizeAria2Config（engine/backends/contract.js）面对任何脏输入
// 都返回合法配置、且不抛。这是「配置读错 → 误启用 aria2 或引擎崩」的唯一防线。
//
// 口径（与实现注释一致）：
//   · 传「整份 engine-config 对象」，函数自己取 .aria2
//   · 没有 aria2 段 / 段是 null·数组·字符串 → 默认值 enabled:false
//   · enabled 只有布尔 true 算开（"yes" / 1 / "true" 都是 false）
//   · port 必须是 1..65535 的整数，纯数字字符串可接受；其余 → 6802
//   · bin 非字符串 → ""
//
// 用法（仓库根目录）：node tests/unit-aria2-config.mjs
// 退出码：全过 0，有失败 1。
import { normalizeAria2Config, DEFAULT_ARIA2_PORT } from "../engine/backends/contract.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

const isDefault = (x) => x && x.enabled === false && x.bin === "" && x.port === 6802;

// ── 1. 缺失 / 空 / 无段 → 默认值，不报错 ──
check("undefined → 默认值", normalizeAria2Config(undefined), isDefault);
check("{} → 默认值", normalizeAria2Config({}), isDefault);
check("null → 默认值", normalizeAria2Config(null), isDefault);
check("{ aria2: null } → 默认值", normalizeAria2Config({ aria2: null }), isDefault);

// ── 2. 段本身是脏类型 → 默认值 ──
check("{ aria2: [] } → 默认值", normalizeAria2Config({ aria2: [] }), isDefault);
check('{ aria2: "on" } → 默认值', normalizeAria2Config({ aria2: "on" }), isDefault);
check("{ aria2: 0 } → 默认值", normalizeAria2Config({ aria2: 0 }), isDefault);

// ── 3. enabled 只认布尔 true ──
check('enabled:"yes" → false', normalizeAria2Config({ aria2: { enabled: "yes" } }), (x) => x.enabled === false);
check('enabled:"true" → false', normalizeAria2Config({ aria2: { enabled: "true" } }), (x) => x.enabled === false);
check("enabled:1 → false", normalizeAria2Config({ aria2: { enabled: 1 } }), (x) => x.enabled === false);
check("enabled:true → true", normalizeAria2Config({ aria2: { enabled: true } }), (x) => x.enabled === true);
check("enabled:false → false", normalizeAria2Config({ aria2: { enabled: false } }), (x) => x.enabled === false);

// ── 4. port 范围与类型 ──
check("port:0 → 6802", normalizeAria2Config({ aria2: { port: 0 } }), (x) => x.port === 6802);
check("port:99999 → 6802", normalizeAria2Config({ aria2: { port: 99999 } }), (x) => x.port === 6802);
check("port:-1 → 6802", normalizeAria2Config({ aria2: { port: -1 } }), (x) => x.port === 6802);
check("port:1.5 → 6802", normalizeAria2Config({ aria2: { port: 1.5 } }), (x) => x.port === 6802);
check('port:"6803" → 6803', normalizeAria2Config({ aria2: { port: "6803" } }), (x) => x.port === 6803);
check('port:"abc" → 6802', normalizeAria2Config({ aria2: { port: "abc" } }), (x) => x.port === 6802);
check('port:"" → 6802', normalizeAria2Config({ aria2: { port: "" } }), (x) => x.port === 6802);
check("port:65535 → 65535", normalizeAria2Config({ aria2: { port: 65535 } }), (x) => x.port === 65535);
check("port:65536 → 6802", normalizeAria2Config({ aria2: { port: 65536 } }), (x) => x.port === 6802);
check("port:6802（显式）→ 6802", normalizeAria2Config({ aria2: { port: 6802 } }), (x) => x.port === 6802);

// ── 5. bin 类型 ──
check("bin:123 → \"\"", normalizeAria2Config({ aria2: { bin: 123 } }), (x) => x.bin === "");
check("bin:null → \"\"", normalizeAria2Config({ aria2: { bin: null } }), (x) => x.bin === "");
check("bin:{} → \"\"", normalizeAria2Config({ aria2: { bin: {} } }), (x) => x.bin === "");
check('bin:"C:\\\\aria2c.exe" 保留', normalizeAria2Config({ aria2: { bin: "C:\\aria2c.exe" } }), (x) => x.bin === "C:\\aria2c.exe");

// ── 6. 组合：全字段合法 ──
{
  const r = normalizeAria2Config({ aria2: { enabled: true, bin: "aria2c", port: 7000 } });
  check("合法组合整体保留", r, (x) => x.enabled === true && x.bin === "aria2c" && x.port === 7000);
}

// ── 7. 返回值形状契约 ──
check("返回值只有三个键", normalizeAria2Config({ aria2: { enabled: true, extra: 1 } }),
  (x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(["bin", "enabled", "port"]));
check("返回值不引用入参（改入参不影响结果）", (() => {
  const raw = { aria2: { enabled: true, port: 7000 } };
  const out = normalizeAria2Config(raw);
  raw.aria2.enabled = false; raw.aria2.port = 1;
  return out.enabled === true && out.port === 7000;
})(), (x) => x === true);
check("默认端口常量与字面值一致", DEFAULT_ARIA2_PORT, (x) => x === 6802);

// ── 8. 任何输入都不抛（畸形输入扫一遍）──
{
  const weird = [
    undefined, null, 0, 1, -1, NaN, "", "aria2", true, false,
    [], [1, 2], [{}], { aria2: undefined }, { aria2: [] }, { aria2: [null] },
    { aria2: "" }, { aria2: 0 }, { aria2: false }, { aria2: () => {} },
    { aria2: { enabled: {}, bin: [], port: {} } },
    { aria2: { enabled: null, bin: null, port: null } },
    { get aria2() { throw new Error("boom"); } },
    Object.create(null),
  ];
  let threw = 0, bad = 0;
  for (const w of weird) {
    try {
      const r = normalizeAria2Config(w);
      if (!r || typeof r.enabled !== "boolean" || typeof r.bin !== "string"
          || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) bad++;
    } catch { threw++; }
  }
  check("畸形输入全部不抛", threw, (x) => x === 0);
  check("畸形输入全部产出合法形状", bad, (x) => x === 0);
}

console.log(`\nunit-aria2-config: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
