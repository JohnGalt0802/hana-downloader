// tests/unit-platform-runtime.mjs — 平台能力在真实引擎里的行为（2026-10-20 新增）
//
// 与 unit-capabilities 的分工：
//   unit-capabilities  只读源码与纯函数，验「代码结构上有没有这道门」
//   unit-platform-runtime  真起引擎，验「门关不关得上」——HTTP 状态码、回包形状、拒绝文案
//
// 为什么必须真起引擎：proxy-control 的 unsupported 回包要经过 readBody / send 才成型，
// 而 /command 的 winget 守卫夹在一长串 if-else 里，静态断言看不出它会不会被前面的分支吃掉。
//
// 不联网、不启 aria2；端口与临时目录都走系统分配 / mkdtemp（可并行跑）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { platform } from "../engine/platform/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "hd-platformrt-"));
const DATA_DIR = path.join(BASE, "data");
process.on("exit", () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ } });
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch { ok = false; }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

const engine = spawn(process.execPath, [path.join(appRoot, "engine", "server.js"), DATA_DIR], {
  env: { ...process.env, HD_ENGINE_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let ready = false, errBuf = "";
engine.stdout.on("data", (c) => { if (String(c).includes("HD_ENGINE_READY")) ready = true; });
engine.stderr.on("data", (c) => { errBuf += String(c); });
for (let i = 0; i < 120 && !ready; i++) await sleep(100);
if (!ready) console.log("engine stderr:", errBuf.slice(0, 400) || "(空)");
check("引擎起得来", ready, (x) => x === true);

// 直接拿原始响应，才能看到状态码（fetch 的 json() 会把 400/200 抹平）
const apiRaw = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
};

// ══ 一、/settings 带 platform（UI 的唯一来源）══════════════════════════════
console.log("── /settings 的 platform ──");
{
  const r = await apiRaw("/settings");
  check("GET /settings 200", r.status, (x) => x === 200);
  check("回包带 platform 对象", r.json?.platform, (x) => x && typeof x === "object");
  check("platform.name 与引擎进程平台一致", r.json?.platform?.name, (x) => x === platform.name);
  check("platform.proxyControl 是布尔", r.json?.platform?.proxyControl, (x) => typeof x === "boolean");
  check("platform.reveal 是 true（三平台都支持定位）", r.json?.platform?.reveal, (x) => x === true);
  check("platform.pkgManager 与能力表一致", r.json?.platform?.pkgManager,
    (x) => x === (platform.capabilities.pkgManager || null));
  check("settings 本体仍在（没被 platform 覆盖）", r.json?.settings, (x) => x && typeof x === "object");
}

// ══ 二、proxy-control：非 Windows 回 200 + unsupported ═════════════════════
console.log("\n── proxy-control 按平台 ──");
{
  const endpoints = [
    ["GET", "/proxy-control/status"],
    ["GET", "/proxy-control/scan"],
    ["POST", "/proxy-control/config", { enabled: false }],
    ["POST", "/proxy-control/verify", {}],
    ["POST", "/proxy-control/start", {}],
    ["POST", "/proxy-control/stop", {}],
  ];
  for (const [method, p, body] of endpoints) {
    const r = await apiRaw(p, method === "GET" ? undefined : (body || {}));
    if (platform.capabilities.proxyControl) {
      // Windows：端点必须活着（200 或 500 都算「真在干活」，但绝不能是 404 / unsupported）
      check(`${p} 在 Windows 上未被裁掉`, r.status !== 404 && r.json?.unsupported !== true,
        (x) => x === true);
    } else {
      check(`${p} 回 200（不报错）`, r.status, (x) => x === 200);
      check(`${p} 带 unsupported:true`, r.json?.unsupported, (x) => x === true);
      check(`${p} 文案说清是平台原因`, r.json?.error, (x) => typeof x === "string" && /不支持代理启停控制/.test(x));
    }
  }
}

// ══ 三、/command 的 winget 守卫 ════════════════════════════════════════════
console.log("\n── /command 的 winget 守卫 ──");
{
  const r = await apiRaw("/command", { kind: "winget-install", pkg: "jq" });
  if (platform.capabilities.pkgManager === "winget") {
    // Windows：应当真的走 search 流程，不该被守卫误伤
    check("Windows 上 winget-install 不被守卫拦住", r.json?.unsupported !== true, (x) => x === true);
  } else {
    check("非 Windows：winget-install 被拒（400）", r.status, (x) => x === 400);
    check("带 unsupported:true", r.json?.unsupported, (x) => x === true);
    check("文案给出可用类型", r.json?.error,
      (x) => typeof x === "string" && /git-clone \/ pnpm-install \/ pip-install/.test(x));
    check("文案点明缺的是 winget", r.json?.error, (x) => typeof x === "string" && /没有 winget/.test(x));
  }

  // 未知类型：与平台无关，必须一直被拒且列出全部可用类型
  const bad = await apiRaw("/command", { kind: "rm-rf-everything" });
  check("未知 kind 一律被拒（400）", bad.status, (x) => x === 400);
  check("未知 kind 的文案列出可用类型", bad.json?.error,
    (x) => typeof x === "string" && /支持 git-clone \/ pnpm-install/.test(x));
}

// ══ 四、/reveal：失败要给 {ok:false}，不能把进程带走 ═══════════════════════
console.log("\n── /reveal 的失败路径 ──");
{
  // 不存在的路径：必须明确失败，而不是悄悄 spawn 一个 GUI 错误框
  const r = await apiRaw("/reveal", { filePath: path.join(BASE, "no-such-file-xyz.bin"), mode: "select" });
  check("不存在的路径 → 非 200", r.status, (x) => x !== 200);
  check("带错误文案", r.json?.error, (x) => typeof x === "string" && x.length > 0);
  // ★ 关键：这条请求之后引擎必须还活着（旧代码在这里因未捕获 'error' 直接退出）
  const ping = await apiRaw("/ping");
  check("**reveal 失败后引擎仍活着**（旧代码在这里会整个进程退出）", ping.json?.ok, (x) => x === true);

  const empty = await apiRaw("/reveal", {});
  check("空路径 → 400", empty.status, (x) => x === 400);
}

// ══ 五、/aria2/status 仍可读（能力端点不受裁剪影响）════════════════════════
console.log("\n── 其它能力端点未被误伤 ──");
{
  const r = await apiRaw("/aria2/status");
  check("/aria2/status 可用", r.status, (x) => x === 200);
  check("/aria2/status 回 capabilities 形状", r.json?.capabilities,
    (x) => x === undefined || (x && typeof x === "object"));
}

console.log(`\n=== platform-runtime: ${pass} passed, ${fail} failed ===`);
try { engine.kill(); } catch { /* 已退出 */ }
await sleep(400);
try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
