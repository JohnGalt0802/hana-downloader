// engine/platform/linux.mjs — 平台适配层的 Linux 实现（骨架，P1-1 只给签名）
//
// **P1-1 不写实现，函数体一律抛「尚未实现」。** 理由同 darwin.mjs：假实现会让 P1-2
// 分不清哪些真做过。这里一个 return 都不给，只有 throw。
//
// P1-2 要填的实现要点（派工计划 P1-2）：
//   which            → which <cmd>（成功后取第一行且 existsSync 通过）
//   reveal           → xdg-open "$(dirname <path>)"，同样必须挂 'error'
//   readSystemProxy  → gsettings get org.gnome.system.proxy，拿不到回退环境变量，
//                      都没有给 {enabled:false, server:"", source:"none"}
//   isRunning        → pgrep -x <name>
//   homeDir          → os.homedir()；tempDir → TMPDIR → os.tmpdir()
//   killTree         → process.kill(-pid, SIGTERM)；要求 spawnOpts 给 detached:true
//   capabilities.pkgManager → 依次真调 `apt --version` / `dnf` / `pacman`，不许看路径
//
// ★ 顺序纪律：spawnOpts 与 killTree 必须相邻（方案 §3.3 原则一）。

export const name = "linux";

const NOT_IMPL = "尚未实现（P1-2 交付）";

// ── ① 查找可执行文件 ────────────────────────────────────────────────────────
export function which(cmd) {
  throw new Error(`linux.which: ${NOT_IMPL}`);
}

// ── ② 可执行文件名 ──────────────────────────────────────────────────────────
export function exe(n) {
  throw new Error(`linux.exe: ${NOT_IMPL}`);
}

// ── ③④ 起子进程的默认选项 + 杀进程树 ★ 必须相邻 ────────────────────────────
export function spawnOpts(extra) {
  throw new Error(`linux.spawnOpts: ${NOT_IMPL}`);
}

export function killTree(pid) {
  throw new Error(`linux.killTree: ${NOT_IMPL}`);
}

// ── ⑤ 进程是否在跑（按名字）─────────────────────────────────────────────────
export function isRunning(nm) {
  throw new Error(`linux.isRunning: ${NOT_IMPL}`);
}

// ── ⑥ 打开文件所在位置 ──────────────────────────────────────────────────────
export function reveal(p, mode) {
  throw new Error(`linux.reveal: ${NOT_IMPL}`);
}

// ── ⑦ 读系统代理 ────────────────────────────────────────────────────────────
export function readSystemProxy() {
  throw new Error(`linux.readSystemProxy: ${NOT_IMPL}`);
}

// ── ⑧ 用户目录 / 临时目录 ───────────────────────────────────────────────────
export function homeDir() {
  throw new Error(`linux.homeDir: ${NOT_IMPL}`);
}

export function tempDir() {
  throw new Error(`linux.tempDir: ${NOT_IMPL}`);
}

// ── ⑩ 路径规范化 ────────────────────────────────────────────────────────────
export function normalizePath(p) {
  throw new Error(`linux.normalizePath: ${NOT_IMPL}`);
}

// ── ⑨ 能力表 ────────────────────────────────────────────────────────────────
// 占位对象：三键齐全但全部标 null，implemented:false 明示未实现。
export const capabilities = Object.freeze({
  implemented: false,
  pkgManager: null,
  proxyControl: null,
  reveal: null,
});
