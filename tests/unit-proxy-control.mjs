// tests/unit-proxy-control.mjs — 代理控制：扫描根组装（自定义优先 / 去重 / 过滤不存在）
// 覆盖 2026-10-07 修订：扫描根从硬编码改为「config.json 自定义优先 + 通用默认」——
// 机器私有目录不再写进代码，改由 proxyControl.scanRoots 提供。
// 2026-10-08：默认根按平台给（Windows 的 D:\ / Program Files 在 macOS 上无意义），
// 断言随平台走。
import path from "node:path";
import { buildScanRoots } from "../engine/proxy-control.js";

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const ALL = () => true;
const IS_MAC = process.platform === "darwin";
const HOME = IS_MAC ? "/Users/test" : "H:\\home";

// 平台默认根（与 engine/proxy-control.js 的 defaultScanRoots 对齐）
const DEFAULT_ROOTS = IS_MAC
  ? ["/Applications", path.join(HOME, "Applications"), path.join(HOME, "Downloads"), path.join(HOME, "Desktop")]
  : [
      "D:\\Downloads", "D:\\", "C:\\Program Files", "C:\\Program Files (x86)",
      path.join(HOME, "Desktop"), path.join(HOME, "Downloads"),
      path.join(HOME, "AppData", "Local", "Programs"),
    ];
const FIRST = DEFAULT_ROOTS[0];
const LAST = DEFAULT_ROOTS[DEFAULT_ROOTS.length - 1];
const CUSTOM = IS_MAC ? "/opt/proxy" : "X:\\tools\\proxy";

console.log(`── buildScanRoots（${process.platform}）──`);

// ① 自定义目录排在最前（时间预算内优先扫描），默认根跟随
const r1 = buildScanRoots({ home: HOME, custom: [CUSTOM], isDir: ALL });
check("自定义目录在首位", r1[0], CUSTOM);
check("默认根含首个默认位置", r1.includes(FIRST), true);
check("默认根含末个默认位置", r1.includes(LAST), true);
check("默认根含 home 桌面", r1.includes(path.join(HOME, "Desktop")), true);

// ② 去重：自定义与默认重复时只保留一次，且在前
const r2 = buildScanRoots({ home: HOME, custom: [FIRST], isDir: ALL });
check("重复项只出现一次", r2.filter((x) => x === FIRST).length, 1);
check("去重后位于首位（自定义语义优先）", r2[0], FIRST);

// ③ 不存在的目录被过滤
const GONE = IS_MAC ? "/nope" : "X:\\nope";
const r3 = buildScanRoots({ home: HOME, custom: [GONE], isDir: (r) => r !== GONE });
check("不存在的自定义目录被过滤", r3.includes(GONE), false);

// ④ 空白 / 非字符串安全
const OK_DIR = IS_MAC ? "/opt/ok" : "X:\\ok";
const r4 = buildScanRoots({ home: HOME, custom: ["  ", null, `  ${OK_DIR}  `], isDir: ALL });
check("空白项被过滤", r4.some((x) => !String(x).trim()), false);
check("首尾空白被裁剪", r4.includes(OK_DIR), true);

// ⑤ 无自定义时 = 平台默认列表
const r5 = buildScanRoots({ home: HOME, custom: [], isDir: ALL });
check(`默认列表 ${DEFAULT_ROOTS.length} 条`, r5.length, DEFAULT_ROOTS.length);
check("默认列表与引擎一致", r5, DEFAULT_ROOTS);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
