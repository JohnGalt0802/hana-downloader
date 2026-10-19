// engine/platform/darwin.mjs — 平台适配层的 macOS 实现（骨架，P1-1 只给签名）
//
// **P1-1 不写实现，函数体一律抛「尚未实现」。** 这是刻意为之：
// 写一个半吊子实现（比如 which 里 return ""，或 capabilities 里猜 brew 存在）
// 会让 P1-2 分不清哪些是真做过的、哪些是假的，比直接抛更危险。
//
// P1-2 要填的实现要点见 docs/跨平台适配层重构方案-20261019.md §3.2 与派工计划 P1-2：
//   which            → which <cmd>（成功后取第一行且 existsSync 通过）
//   reveal           → open -R <path>（select）/ open <path>（open），同样必须挂 'error'
//   readSystemProxy  → scutil --proxy，plist 文本解析，容三种形态：有/无/命令不存在
//   isRunning        → pgrep -x <name>
//   homeDir          → os.homedir()；tempDir → TMPDIR → os.tmpdir()
//   killTree         → process.kill(-pid, SIGTERM)；要求 spawnOpts 给 detached:true
//   capabilities.pkgManager → 真调一次 `brew --version`（不许看路径上有没有文件）
//
// ★ 顺序纪律：spawnOpts 与 killTree 必须相邻（方案 §3.3 原则一）。这里的
//   detached:true 与 kill(-pid) 是同一枚硬币的两面，拆开就会重现 dlcore.js 的老缺陷。

export const name = "darwin";

const NOT_IMPL = "尚未实现（P1-2 交付）";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
export function which(cmd) {
  throw new Error(`darwin.which: ${NOT_IMPL}`);
}

// ── ② 可执行文件名 ──────────────────────────────────────────────────────────
export function exe(n) {
  throw new Error(`darwin.exe: ${NOT_IMPL}`);
}

// ── ③④ 起子进程的默认选项 + 杀进程树 ★ 必须相邻 ────────────────────────────
export function spawnOpts(extra) {
  throw new Error(`darwin.spawnOpts: ${NOT_IMPL}`);
}

export function killTree(pid) {
  throw new Error(`darwin.killTree: ${NOT_IMPL}`);
}

// ── ⑤ 进程是否在跑（按名字）─────────────────────────────────────────────────
export function isRunning(nm) {
  throw new Error(`darwin.isRunning: ${NOT_IMPL}`);
}

// ── ⑥ 打开文件所在位置 ──────────────────────────────────────────────────────
export function reveal(p, mode) {
  throw new Error(`darwin.reveal: ${NOT_IMPL}`);
}

// ── ⑦ 读系统代理 ────────────────────────────────────────────────────────────
export function readSystemProxy() {
  throw new Error(`darwin.readSystemProxy: ${NOT_IMPL}`);
}

// ── ⑧ 用户目录 / 临时目录 ───────────────────────────────────────────────────
export function homeDir() {
  throw new Error(`darwin.homeDir: ${NOT_IMPL}`);
}

export function tempDir() {
  throw new Error(`darwin.tempDir: ${NOT_IMPL}`);
}

// ── ⑩ 路径规范化 ────────────────────────────────────────────────────────────
export function normalizePath(p) {
  throw new Error(`darwin.normalizePath: ${NOT_IMPL}`);
}

// ── ⑨ 能力表 ────────────────────────────────────────────────────────────────
// 占位对象：三键齐全但全部标 null，且带 implemented:false 明示未实现。
// 不要把它写成看起来能用的值 —— 上层看到 implemented:false 就该报「当前平台未支持」，
// 而不是拿一个猜出来的能力去跑。
export const capabilities = Object.freeze({
  implemented: false,
  pkgManager: null,
  proxyControl: null,
  reveal: null,
});
