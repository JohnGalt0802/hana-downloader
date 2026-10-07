// tests/unit-proxy-control.mjs — 代理控制：扫描根组装（自定义优先 / 去重 / 过滤不存在）
// 覆盖 2026-10-07 修订：扫描根从硬编码改为「config.json 自定义优先 + 通用默认」——
// 机器私有目录不再写进代码，改由 proxyControl.scanRoots 提供。
import { buildScanRoots } from "../engine/proxy-control.js";

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const ALL = () => true;
const HOME = "H:\\home";

console.log("── buildScanRoots ──");

// ① 自定义目录排在最前（时间预算内优先扫描），默认根跟随
const r1 = buildScanRoots({ home: HOME, custom: ["X:\\tools\\proxy"], isDir: ALL });
check("自定义目录在首位", r1[0], "X:\\tools\\proxy");
check("默认根含 D:\\Downloads", r1.includes("D:\\Downloads"), true);
check("默认根含 Program Files", r1.includes("C:\\Program Files"), true);
check("默认根含 home 桌面", r1.includes("H:\\home\\Desktop"), true);
check("默认根含 home Programs", r1.includes("H:\\home\\AppData\\Local\\Programs"), true);

// ② 去重：自定义与默认重复时只保留一次，且在前
const r2 = buildScanRoots({ home: HOME, custom: ["D:\\"], isDir: ALL });
check("重复项只出现一次", r2.filter((x) => x === "D:\\").length, 1);
check("去重后位于首位（自定义语义优先）", r2[0], "D:\\");

// ③ 不存在的目录被过滤
const r3 = buildScanRoots({ home: HOME, custom: ["X:\\nope"], isDir: (r) => r !== "X:\\nope" });
check("不存在的自定义目录被过滤", r3.includes("X:\\nope"), false);

// ④ 空白 / 非字符串安全
const r4 = buildScanRoots({ home: HOME, custom: ["  ", null, "  X:\\ok  "], isDir: ALL });
check("空白项被过滤", r4.some((x) => !String(x).trim()), false);
check("首尾空白被裁剪", r4.includes("X:\\ok"), true);

// ⑤ 无自定义时 = 默认列表（7 条通用位置）
const r5 = buildScanRoots({ home: HOME, custom: [], isDir: ALL });
check("默认列表 7 条", r5.length, 7);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
