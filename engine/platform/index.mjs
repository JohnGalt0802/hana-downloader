// engine/platform/index.mjs — 平台适配层入口（P1-1，2026-10-20）
//
// 唯一允许出现 process.platform 的地方（方案 §3.1）。业务代码只 import { platform }。
//
// 两个导出：
//   platform              生产用：按 process.platform 选实现
//   createPlatform(name)  测试用：按名字注入，一套断言就能验三条分支，不依赖本机平台
//
// 平台名只接受 win32 / darwin / linux。别的名字直接抛 —— 静默回落到某个实现比崩更危险
// （在 freebsd 上悄悄按 linux 跑，出错的地方离原因有十万八千里）。
//
// 依赖方向：index → {win32,darwin,linux}，三个实现**不许** import 本文件（会成环）。
import * as win32 from "./win32.mjs";
import * as darwin from "./darwin.mjs";
import * as linux from "./linux.mjs";

const IMPLS = { win32, darwin, linux };
const NAMES = Object.keys(IMPLS);

// 十组接口的方法清单。加接口时改这里一处，缺实现的平台会在创建时就暴露。
const METHODS = [
  "which",        // ① cmd → string | ""
  "exe",          // ② name → 可执行文件名
  "spawnOpts",    // ③ extra → 起子进程的默认选项（与 ④ 必须同一文件相邻）
  "killTree",     // ④ pid → boolean（杀整棵进程树）
  "isRunning",    // ⑤ name → boolean
  "reveal",       // ⑥ (path, mode) → {ok, error?}
  "readSystemProxy", // ⑦ → {enabled, server, source}
  "homeDir",      // ⑧ → string
  "tempDir",      // ⑧ → string
  "nullDevice",   // ⑧ → 丢弃输出的设备名（curl -o / 重定向用）
  "pidAlive",     // ⑧ → pid → boolean（只探活，不发信号）
  "processNameOf",// ⑧ → pid → 进程名（拿不到给 ""）
  "normalizePath",// ⑩ path → 比较键
];

export function createPlatform(platformName) {
  const key = String(platformName ?? "");
  if (!NAMES.includes(key)) {
    throw new Error(`createPlatform: 不支持的平台名 "${key}"（只接受 ${NAMES.join(" / ")}）`);
  }
  const impl = IMPLS[key];
  const out = { name: impl.name ?? key };
  for (const m of METHODS) {
    const fn = impl[m];
    if (typeof fn !== "function") {
      throw new Error(`createPlatform: ${key} 缺少接口 ${m}()`);
    }
    out[m] = fn;
  }
  // capabilities 是数据不是函数；缺了也算实现不完整
  if (!impl.capabilities || typeof impl.capabilities !== "object") {
    throw new Error(`createPlatform: ${key} 缺少 capabilities`);
  }
  out.capabilities = impl.capabilities;
  return Object.freeze(out);
}

export const platform = createPlatform(process.platform);
