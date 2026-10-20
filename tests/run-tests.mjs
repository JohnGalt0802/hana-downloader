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
  ["unit-stall-notify.mjs", "卡滞提醒的投递通道（不建宿主任务 / triggerTurn=true / 同轮合并 / 重试仍 false）"],
  ["unit-restore.mjs", "重启恢复的终态补写（running/pending → interrupted 落 finished / 幂等 / 孤儿回收）"],
  ["unit-restore-aria2.mjs", "重启后 aria2 活实例接回（实例还在→继续跟踪到 done；实例已没→仍 interrupted；已下完→正确收尾）"],
  ["unit-atomic-final.mjs", "终态记录的原子写（写入中断不出半截 JSON / 内容与改动前一致 / 失败不留 .tmp）"],
  ["unit-theme.mjs", "声明式主题数据层（继承合并 / 校验拒收 / 默认值填满 / schema 口径）"],
  ["unit-contract.mjs", "IPC 与展示契约兜底（/list 字段齐全 / 非 JSON 回包 / displayName / stateBadge / /cancel 形状）"],
  ["unit-cardview.mjs", "卡片渲染纯函数（minimal 逐字节回归 + golden 基准 + 缺省第三腿一致性）"],
  ["unit-aria2.mjs", "aria2 backend（契约/状态与进度映射纯函数 + 真链路 SHA-256 对拍；未装 aria2 则 skip）"],
  ["unit-aria2-cache.mjs", "aria2 探测缓存（成功结果长缓存不重测 / 负结果 5s 重测 / 配置变更与手动刷新失效）"],
  ["unit-aria2-config.mjs", "aria2 配置归一（缺段/脏类型/边界端口/畸形输入不抛）"],
  ["unit-aria2-ui.mjs", "aria2 开关三态文案（未启用 / 已启用可用 / 已启用不可用 / 检测中）"],
  ["unit-aria2-persist.mjs", "aria2 进度节流落盘（运行中 ≥2s 后磁盘 received>0 / 写盘频率受控 / 不用 .part 大小当进度）"],
  ["unit-backend-switch.mjs", ".part 归属与换后端（aria2 稀疏半成品切 node-http 必须从头下，不交付带洞文件）"],
  ["unit-platform.mjs", "平台适配层（十三组接口契约 / 参数注入三平台 / 探测类失败给空不抛）"],
  ["unit-processtree.mjs", "进程树（spawnOpts与killTree成对 / 真起进程杀孙进程 / 孤儿收尾原语 / engine 下 process.platform 归零）"],
  ["unit-orphan-reap.mjs", "孤儿收尾（探活口径必须与杀的对象一致：pidAlive=false 但 treeAlive=true 的现场不再空转）"],
  ["unit-capabilities.mjs", "平台能力裁剪（proxyControl 非win关闭且UI不渲染 / winget不注册且硬传被拒 / PEP668 给venv出路）"],
  ["unit-platform-runtime.mjs", "平台能力在真引擎里的行为（/settings 带 platform / proxy-control unsupported / winget 守卫 / reveal 失败不带走进程）"],
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
