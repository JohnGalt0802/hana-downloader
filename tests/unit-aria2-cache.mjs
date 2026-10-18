// tests/unit-aria2-cache.mjs — capabilities() 探测缓存的持久化（2026-10-19）
//
// 背景：缓存原本只有 5s，导致每次打开管理器都要完整重跑一遍探测（找 exe → 起实例 → RPC 握手），
// 用户实测反馈「点一次开关就够了，不该每次都重测」。
//
// 本轮断言：
//   A. 成功结果：连续两次 capabilities()，第二次**不触发探测**（probes 计数不增、detection.at 不变），
//      并且过了原来 5s 窗口仍不重测
//   B. 失败结果：仍会重测（不能被长缓存；踩坑 49：用户刚装好 aria2 必须马上能识别）
//   C. 配置变更：缓存失效，重新探测
//   D. 手动刷新：force / refreshCapabilities() 跳过缓存
//   E. 实例消失：成功缓存作废
//
// 全程用本机真实 aria2c（未安装则整体 skip，不算失败）。端口与临时目录都向系统要，可并行跑。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { aria2Backend, resolveAria2Bin, shutdownInstance } from "../engine/backends/aria2.js";
import { capabilitiesOf } from "../engine/backends/contract.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

const TMP_DIRS = [];
const tmpDir = (prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(d);
  return d;
};
process.on("exit", () => {
  for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }
});

const BIN = resolveAria2Bin("");
if (!BIN) {
  console.log("跳过 aria2 探测缓存测试（未检测到 aria2c）");
  console.log("\n=== aria2 缓存: 0 passed, 0 failed（已跳过）===");
  process.exit(0);
}

// 本进程独占的基端口：portCandidates 会从基端口往后连试 8 个，这 8 个都要空着
const BASE_PORT = 20000 + (process.pid % 200) * 8;
const DATA = path.join(tmpDir("hd-aria2-cache-"), "data");
fs.mkdirSync(DATA, { recursive: true });

const probes = () => aria2Backend.instanceInfo().probes;
const detAt = () => aria2Backend.instanceInfo().detectionAt;

try {
  // ── A. 成功结果不重测 ──────────────────────────────────────
  aria2Backend.setOptions({ bin: BIN, port: BASE_PORT });
  const cap1 = await capabilitiesOf(aria2Backend, { dataDir: DATA });
  if (!cap1.available) {
    // 端口全占等环境问题：skip 而不是失败（真实链路测试同样是这个口径）
    console.log(`跳过 aria2 探测缓存测试（${cap1.reason || "不可用"}）`);
    console.log("\n=== aria2 缓存: 0 passed, 0 failed（已跳过）===");
    process.exit(0);
  }
  const p1 = probes();
  const t1 = detAt();
  check("A: 首次探测真的跑过", p1, (x) => x >= 1);
  check("A: 首次探测 available", cap1.available, (x) => x === true);
  check("A: 首次探测带真实版本号（握手铁律不变）", cap1.version, (x) => typeof x === "string" && /^\d+\.\d+\.\d+/.test(x));

  const before = aria2Backend.instanceInfo();
  const cap2 = await capabilitiesOf(aria2Backend, { dataDir: DATA });
  check("A: 第二次 available 一致", cap2.available, (x) => x === true);
  check("A: 第二次**没有**重新探测（probes 不增）", probes(), (x) => x === p1);
  check("A: 第二次 detection.at 未更新", detAt(), (x) => x === t1);
  check("A: 第二次仍是同一个结果（端口/版本一致）",
    [cap2.port, cap2.version].join("|"), (x) => x === [cap1.port, cap1.version].join("|"));
  check("A: 实例确实在跑（不是缓存假象）", before.ready, (x) => x === true);

  // 关键：过了原来的 5s 窗口仍然不重测（修复前这里会重跑整条探测链）
  await new Promise((r) => setTimeout(r, 5300));
  const cap3 = await capabilitiesOf(aria2Backend, { dataDir: DATA });
  check("A: 过 5s 后仍不重测（probes 不增）", probes(), (x) => x === p1);
  check("A: 过 5s 后 detection.at 仍未更新", detAt(), (x) => x === t1);
  check("A: 过 5s 后结果仍可用", cap3.available, (x) => x === true);

  // ── B. 失败结果仍然重测（不能被长缓存）────────────────────
  {
    const dir = tmpDir("hd-aria2-cache-neg-");
    // 用一个空 bin 指向不存在的路径 → 必然 available:false（走「未检测到 aria2c」分支）
    aria2Backend.setOptions({ bin: path.join(dir, "no-such-aria2c.exe"), port: BASE_PORT + 1 });
    const n1 = await capabilitiesOf(aria2Backend, { dataDir: dir });
    check("B: 负结果 available=false", n1.available, (x) => x === false);
    const pn1 = probes();

    // 5s 内重复调用 → 走缓存（不重测）
    const n2 = await capabilitiesOf(aria2Backend, { dataDir: dir });
    check("B: 5s 内负结果走缓存（probes 不增）", probes(), (x) => x === pn1);
    check("B: 5s 内负结果内容一致", n2.reason, (x) => x === n1.reason);

    // 等过 5s 短缓存窗口（负结果不能长留）→ 必须重测
    const d = aria2Backend.instanceInfo();
    check("B: 负结果 ok 标记为 false", d.detectionOk, (x) => x === false);
    await new Promise((r) => setTimeout(r, 5300));
    const n3 = await capabilitiesOf(aria2Backend, { dataDir: dir });
    check("B: 过了 5s 负结果会重测（probes 增加）", probes(), (x) => x === pn1 + 1);
    check("B: 重测后仍是负结果", n3.available, (x) => x === false);

    // 对照：把 aria2 放回原位（配置变更）→ 立刻可用，不用等、不用重启（踩坑 49 的现场）
    aria2Backend.setOptions({ bin: BIN, port: BASE_PORT });
    const back = await capabilitiesOf(aria2Backend, { dataDir: DATA });
    check("B: 配回真 aria2 立即恢复可用（不等缓存过期）", back.available, (x) => x === true);
  }

  // ── C. 配置变更使缓存失效 ──────────────────────────────────
  {
    const pc = probes();
    const tc = detAt();
    // 端口变了 → setOptions 内部 invalidateDetection()
    aria2Backend.setOptions({ bin: BIN, port: BASE_PORT + 3 });
    const c1 = await capabilitiesOf(aria2Backend, { dataDir: DATA });
    check("C: 配置变更后重新探测（probes 增加）", probes(), (x) => x === pc + 1);
    check("C: 配置变更后 detection.at 前进", detAt(), (x) => x > tc);
    check("C: 配置变更后仍可用", c1.available, (x) => x === true);
  }

  // ── D. 手动刷新跳过缓存 ────────────────────────────────────
  {
    const pd = probes();
    const d1 = await aria2Backend.refreshCapabilities({ dataDir: DATA });
    check("D: refreshCapabilities 强制重测（probes 增加）", probes(), (x) => x === pd + 1);
    check("D: 刷新后仍可用", d1.available, (x) => x === true);

    const pd2 = probes();
    const d2 = await capabilitiesOf(aria2Backend, { dataDir: DATA, force: true });
    check("D: capabilities({force:true}) 也强制重测", probes(), (x) => x === pd2 + 1);
    check("D: force 探测结果可用", d2.available, (x) => x === true);
  }

  // ── E. 实例消失 → 成功缓存作废 ────────────────────────────
  {
    const pe = probes();
    await shutdownInstance();
    const e1 = await capabilitiesOf(aria2Backend, { dataDir: DATA });
    check("E: 实例关闭后成功缓存失效，会重新探测", probes(), (x) => x > pe);
    check("E: 重新探测把实例拉回来（available 仍为 true）", e1.available, (x) => x === true);
    check("E: 重新探测仍带真实版本号", e1.version, (x) => typeof x === "string" && /^\d+\.\d+\.\d+/.test(x));
  }
} finally {
  await shutdownInstance();
}

console.log(`\n=== aria2 缓存: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail ? 1 : 0;
