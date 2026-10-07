// tests/run-tests.mjs — 一键跑全部离线测试（2026-09-20 回仓）
//
// 为什么要有它：这些断言原先漂在 D:\HanakoWorks\_temp 里，靠绝对路径 import 仓库源码，
// 清一次 _temp 就没了。现在它们住在仓库里，这条脚本是唯一的入口，
// 不依赖网络、不依赖宿主、不启动引擎。
//
// 用法（仓库根目录）：
//   node tests/run-tests.mjs
//
// 退出码：全部通过为 0，任一失败为 1（可直接接 CI 或 git hook）。
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ["unit-parsers.mjs", "输出解析器（winget / pip / uv / git / winget search / 退出码表）"],
  ["unit-proxy.mjs", "代理解析（proxy:false 直连 / noProxy 白名单 / 优先级）"],
  ["unit-proxy-control.mjs", "代理控制扫描根（自定义优先 / 去重 / 过滤不存在）"],
  ["unit-probe.mjs", "winget 下载进度探测（本地 HTTP + 伪造下载目录）"],
  ["unit-display.mjs", "展示层单一来源（阶段/单位文案、任务形态判定、进度文案）"],
  ["unit-download.mjs", "下载内核端到端（落盘 / SHA-256 校验 / 限速 / 记录清理）"],
  ["unit-queue.mjs", "并发队列与重试（排队放行 / 失败重跑 / 默认限速）"],
  ["unit-stall.mjs", "卡滞快照的落盘契约（起真引擎，验 sessionPath/stalledAt 带到 App 侧）"],
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

console.log("=== hana-downloader 离线测试 ===");
let failed = 0;
for (const [file, desc] of SUITES) {
  console.log(`\n── ${file} — ${desc}`);
  const code = await run(file);
  if (code !== 0) { failed += 1; console.log(`   ^ 失败（exit ${code}）`); }
}
console.log(`\n=== ${SUITES.length - failed}/${SUITES.length} 套件通过 ===`);
process.exit(failed ? 1 : 0);
