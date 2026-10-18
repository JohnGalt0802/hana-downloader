// tests/tools/aria2-bin-cache-evidence.mjs — 复现「bin 探测失败被缓存 30 秒，用户装完必须重启引擎」
//
// 复现步骤（与验收单一致）：
//   1. 隔离环境里启动引擎：PATH 与 LOCALAPPDATA 都指向没有 aria2c 的临时目录
//   2. 调 /aria2/status → available:false（合理：确实没有）
//   3. **不重启引擎**，把 aria2c 放进探测会看的常见位置
//   4. 再调 /aria2/status → 期望 available:true + 真实 version
//
// 修复前：第 3 步放进去了，第 4 步仍是 available:false —— 因为 binCache 把 "" 也缓存了 30 秒，
//         叠加 state.detection 的 5 秒，用户装完只能重启引擎。
// 修复后：下一次探测就能找到，立即可用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = path.join(os.tmpdir(), "hd-aria2-bincache");
fs.rmSync(BASE, { recursive: true, force: true });
const DATA_DIR = path.join(BASE, "data");
// 隔离的「用户目录」：放 aria2c 的常见位置就在它下面
const FAKE_LOCALAPPDATA = path.join(BASE, "localappdata");
const LINKS_DIR = path.join(FAKE_LOCALAPPDATA, "Microsoft", "WinGet", "Links");
// 隔离的 PATH：只留系统目录（where.exe 要用），确保找不到 aria2c
const SAFE_PATH = process.platform === "win32"
  ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
     path.join(process.env.SystemRoot || "C:\\Windows")]
    .join(path.delimiter)
  : "/usr/bin:/bin";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FAKE_LOCALAPPDATA, { recursive: true });

// 找到真实 aria2c 用作「待安装」的样本（本机没有就只放空文件，只测探测本身）
const realBin = (() => {
  const guesses = [
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "aria2c.exe"),
    path.join(process.env.USERPROFILE || "", "scoop", "shims", "aria2c.exe"),
    "C:\\ProgramData\\chocolatey\\bin\\aria2c.exe",
    path.join(process.env.ProgramFiles || "", "aria2", "aria2c.exe"),
  ];
  for (const g of guesses) if (g && fs.existsSync(g)) return g;
  return "";
})();
console.log("真实 aria2c =", realBin || "（本机没有，仅验探测缓存）");

fs.writeFileSync(path.join(DATA_DIR, "engine-config.json"), JSON.stringify({
  aria2: { enabled: true, bin: "", port: 6884 },
}, null, 2));

const PORT = 18989;
const engine = spawn(process.execPath, [path.join(appRoot, "engine", "server.js"), DATA_DIR], {
  env: {
    ...process.env,
    HD_ENGINE_PORT: String(PORT),
    PATH: SAFE_PATH,
    LOCALAPPDATA: FAKE_LOCALAPPDATA,
    USERPROFILE: path.join(BASE, "userprofile"),
    ProgramFiles: path.join(BASE, "programfiles"),
  },
  stdio: "ignore",
});

const api = async (p) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return r.json();
};
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  await sleep(100);
  try { ready = (await api("/ping"))?.ok === true; } catch { /* 等 */ }
}
console.log("引擎已启动（隔离 PATH，无 aria2c）:", ready);

const before = await api("/aria2/status");
console.log("\n[第 2 步] 装之前  →", JSON.stringify({
  available: before.available, reason: before.reason, version: before.version ?? null,
}));

// 第 3 步：把 aria2c「装上」——放进 WinGet Links（探测的第二条路）
fs.mkdirSync(LINKS_DIR, { recursive: true });
const target = path.join(LINKS_DIR, "aria2c.exe");
if (realBin) fs.copyFileSync(realBin, target);
else fs.writeFileSync(target, "");
console.log(`\n[第 3 步] 已放入 ${target}`);

// 第 4 步：不重启引擎，直接再问。
// state.detection 有 5 秒缓存（用户认可），所以等 5.2 秒后再问，模拟「用户过一会儿看状态」。
await sleep(5200);
const after = await api("/aria2/status");
console.log("[第 4 步] 装之后  →", JSON.stringify({
  available: after.available, reason: after.reason, version: after.version ?? null,
}));

const ok = after.available === true && typeof after.version === "string" && /^\d+\.\d+\.\d+/.test(after.version);
console.log(`\n判定：装完不重启即可用（available:true 且 version 真实）→ ${ok ? "PASS" : "FAIL"}`);

// 收尾：只关自己起的引擎与实例
try { await fetch(`http://127.0.0.1:${PORT}/aria2/shutdown`, { method: "POST" }); } catch { /* 没这端点 */ }
engine.kill();
await sleep(1200);
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 引擎可能还在刷盘 */ }
process.exitCode = ok ? 0 : 1;
