// engine/proxy-control.js
// ─────────────────────────────────────────────────────────────────────────────
// 代理（梯子）启停控制（2026-10-04）
//
// 定位与纪律（重要）：
//  1. 「使用代理」不归这里管。那是 dlcore.resolveProxy 的职责，行为对齐裸 curl 的
//     隐式继承（环境变量 + 系统代理）。机器本来起着代理，正常用，没有问题。
//  2. 「启停梯子」是改环境的高风险动作，默认禁止；只有用户在设置页显式开启
//     config.json 的 proxyControl.enabled 之后，start/stop 才放行。
//  3. 扫描与状态查询永远只读，不看开关。
//  4. 所有启停动作写审计（config.json 的 proxyControl.audit，最多留 200 条），
//     让「谁在什么时候动了梯子」随时可回看——dsh 那种「没注意就烧了」最怕无感。
//  5. 实测（verify）在梯子已运行时绝不启停，只报告「运行中」，不打断用户网络。
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

const AUDIT_MAX = 200;
const SCAN_BUDGET_MS = 8000; // 扫描时间预算，防止深目录卡死

// ── 已知配方库 ──────────────────────────────────────────────────────────────
// 每条配方回答三个问题：怎么启、怎么停、探哪个端口。
// 匹配靠 exe 文件名；找不到已知配方时用户仍可手工保存路径（降级为通用 GUI 启动）。
export const KNOWN_LAUNCHERS = [
  {
    id: "clash-for-windows",
    name: "Clash for Windows",
    exeRe: /^clash for windows\.exe$/i,
    processName: "Clash for Windows",
    // 停止要清全套：GUI + 独立内核（实测 2026-10-04：只杀 GUI 时 clash-win64 仍占着 7890）
    processNames: ["Clash for Windows", "clash-win64", "clash-core-service"],
    port: 7890,
    note: "GUI 应用 + 独立内核；启动只拉 GUI（会接管或拉起内核），停止时 GUI 与内核都清。",
  },
  {
    id: "clash-verge",
    name: "Clash Verge / Verge Rev",
    exeRe: /^(clash[- ]?verge|verge)[^/\\]*\.exe$/i,
    processName: "clash-verge",
    processNames: ["clash-verge", "verge-mihomo", "clash-verge-service"],
    port: 7897,
    note: "GUI 应用；Verge 默认混合端口 7897，内核为 verge-mihomo。",
  },
  {
    id: "mihomo",
    name: "Mihomo (Clash.Meta)",
    exeRe: /^(mihomo|clash[.-]meta|clash-meta)[^/\\]*\.exe$/i,
    processName: "mihomo",
    processNames: ["mihomo"],
    port: 7890,
    note: "CLI 内核，需要配置目录；默认混合端口 7890。",
  },
  {
    id: "v2rayn",
    name: "v2rayN",
    exeRe: /^v2rayn\.exe$/i,
    processName: "v2rayN",
    processNames: ["v2rayN", "xray", "v2ray"],
    port: 10809,
    note: "GUI 应用；默认 HTTP 端口 10809，内核可能为 xray/v2ray。",
  },
  {
    id: "sing-box",
    name: "sing-box",
    exeRe: /^sing-box[^/\\]*\.exe$/i,
    processName: "sing-box",
    processNames: ["sing-box"],
    port: 2080,
    note: "CLI 内核；默认混合端口 2080。",
  },
];

// ── 用户配置（config.json 的 proxyControl 一节，不碰 proxy 那节）────────────
export function readControlConfig(dataDir) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8") || "{}");
  } catch { cfg = {}; }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const pc = cfg.proxyControl && typeof cfg.proxyControl === "object" ? cfg.proxyControl : {};
  return {
    enabled: pc.enabled === true,
    launcher: normalizeLauncher(pc.launcher),
    audit: Array.isArray(pc.audit) ? pc.audit.slice(-AUDIT_MAX) : [],
    // 自定义扫描根（「扫描代理软件」用）：机器私有的软件存放目录放这里，不写进代码——
    // 代码里的默认列表只含通用位置。
    scanRoots: Array.isArray(pc.scanRoots)
      ? pc.scanRoots.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean)
      : [],
  };
}

export function writeControlConfig(dataDir, patch) {
  const file = path.join(dataDir, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, "utf-8") || "{}"); } catch { cfg = {}; }
  if (!cfg || typeof cfg !== "object") cfg = {};
  const prev = cfg.proxyControl && typeof cfg.proxyControl === "object" ? cfg.proxyControl : {};
  const next = { ...prev, ...patch };
  if ("launcher" in patch) next.launcher = normalizeLauncher(patch.launcher);
  cfg.proxyControl = next;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
  return readControlConfig(dataDir);
}

function normalizeLauncher(L) {
  if (!L || typeof L !== "object") return null;
  const exe = typeof L.exe === "string" ? L.exe.trim() : "";
  if (!exe) return null;
  const processName = typeof L.processName === "string" && L.processName ? L.processName : "";
  const processNames = Array.isArray(L.processNames) && L.processNames.length
    ? L.processNames.map(String).filter(Boolean)
    : (processName ? [processName] : []);
  return {
    id: typeof L.id === "string" && L.id ? L.id : "custom",
    name: typeof L.name === "string" && L.name.trim() ? L.name.trim() : path.basename(exe),
    exe,
    workDir: typeof L.workDir === "string" && L.workDir ? L.workDir : path.dirname(exe),
    processName,
    processNames,
    port: Number.isFinite(L.port) && L.port > 0 ? L.port : 7890,
    startArgs: Array.isArray(L.startArgs) ? L.startArgs.map(String) : [],
    verifiedAt: typeof L.verifiedAt === "string" ? L.verifiedAt : null,
    note: typeof L.note === "string" ? L.note : "",
  };
}

function appendAudit(dataDir, entry) {
  try {
    const cur = readControlConfig(dataDir);
    const audit = [...cur.audit, { ts: new Date().toISOString(), ...entry }].slice(-AUDIT_MAX);
    writeControlConfig(dataDir, { audit });
  } catch { /* 审计失败不阻断动作 */ }
}

// ── 端口探测（只读）─────────────────────────────────────────────────────────
export function probePort(port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

async function waitPort(port, totalMs = 12000, stepMs = 500) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return probePort(port);
}

async function waitPortGone(port, totalMs = 8000, stepMs = 500) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return !(await probePort(port));
}

// ── 系统代理状态（只读，给状态卡展示用）────────────────────────────────────
export function readSystemProxy() {
  try {
    const r1 = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    const m1 = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(r1.stdout || "");
    const r2 = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    const m2 = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(r2.stdout || "");
    return {
      enabled: m1 ? parseInt(m1[1], 16) === 1 : false,
      server: m2 ? m2[1].trim() : "",
    };
  } catch {
    return { enabled: false, server: "" };
  }
}

// ── 扫描（只读）：找已知梯子的可执行文件 ─────────────────────────────────────
const SKIP_DIR_RE = /^(node_modules|\.git|Windows|System32|SysWOW64|WinSxS|Installer|\$Recycle\.Bin)$/i;

// 默认扫描根：只放通用位置。机器私有的软件存放目录不写死在代码里——
// 需要时在 config.json 的 proxyControl.scanRoots 里加（自定义目录优先扫描，
// 时间预算内先命中）。
function defaultScanRoots(home) {
  return [
    "D:\\Downloads",
    "D:\\",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
    path.join(home, "AppData", "Local", "Programs"),
  ];
}

// 扫描根组装（纯逻辑，可测）：自定义优先 + 默认跟随；去重；过滤不存在。
export function buildScanRoots({ home = os.homedir(), custom = [], isDir = null } = {}) {
  const existsFn = typeof isDir === "function"
    ? isDir
    : (r) => { try { return fs.existsSync(r); } catch { return false; } };
  return [...custom, ...defaultScanRoots(home)]
    .map((s) => String(s || "").trim())
    .filter((r, i, a) => r && a.indexOf(r) === i)
    .filter((r) => existsFn(r));
}

export function scanCandidates({ maxDepth = 3, maxFound = 60, dataDir = "" } = {}) {
  let custom = [];
  if (dataDir) {
    try { custom = readControlConfig(String(dataDir)).scanRoots; } catch { custom = []; }
  }
  const roots = buildScanRoots({ custom });

  const deadline = Date.now() + SCAN_BUDGET_MS;
  const found = [];
  const seen = new Set();

  const walk = (dir, depth) => {
    if (found.length >= maxFound || Date.now() > deadline) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= maxFound || Date.now() > deadline) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIR_RE.test(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && /\.exe$/i.test(e.name) && e.name.length < 80) {
        for (const k of KNOWN_LAUNCHERS) {
          if (k.exeRe.test(e.name)) {
            const key = full.toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              found.push({
                id: k.id,
                name: k.name,
                exe: full,
                workDir: path.dirname(full),
                processName: k.processName,
                processNames: Array.isArray(k.processNames) ? k.processNames : [k.processName],
                port: k.port,
                note: k.note,
                matched: true,
              });
            }
          }
        }
      }
    }
  };

  for (const root of roots) walk(root, 0);
  return found;
}

// ── 启停原子操作 ────────────────────────────────────────────────────────────
function startByLauncher(L) {
  try {
    const child = spawn(L.exe, L.startArgs || [], {
      cwd: L.workDir || path.dirname(L.exe),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return Promise.resolve({ ok: true, pid: child.pid });
  } catch (e) {
    return Promise.resolve({ ok: false, error: String(e?.message || e) });
  }
}

// 进程是否在跑：靠 tasklist 事实，不靠 taskkill 的输出文本
//（中文 Windows 下 taskkill 的报错会因编码不匹配失效，2026-10-04 实测）
function isProcessRunning(name) {
  try {
    const r = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${name}.exe`, "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const out = String(r.stdout || "").toLowerCase();
    if (!out) return false;
    return out.includes(`${name.toLowerCase()}.exe`);
  } catch { return false; }
}

async function stopByLauncher(L) {
  // 全套清理：GUI 与独立内核都试（实测 2026-10-04：只杀 GUI 时内核仍占端口；
  // 且内核常以管理员权限运行，普通权限杀不掉——那就如实报告，不假装成功、不自行提权）。
  const names = (Array.isArray(L.processNames) && L.processNames.length)
    ? L.processNames
    : [L.processName || path.basename(L.exe || "", ".exe")].filter(Boolean);
  const killed = [];
  const stillRunning = [];
  for (const n of names) {
    if (!isProcessRunning(n)) continue;
    await new Promise((resolve) => {
      const p = spawn("taskkill", ["/IM", `${n}.exe`, "/F"], { windowsHide: true, stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 300));
    if (isProcessRunning(n)) stillRunning.push(n); else killed.push(n);
  }
  return { ok: killed.length > 0, killed, stillRunning };
}

// ── 对外 API ────────────────────────────────────────────────────────────────
export async function getStatus(dataDir) {
  const cfg = readControlConfig(dataDir);
  const port = cfg.launcher?.port || 7890;
  const running = await probePort(port);
  return {
    enabled: cfg.enabled,
    launcher: cfg.launcher,
    port,
    running,
    systemProxy: readSystemProxy(),
    audit: cfg.audit.slice(-20),
  };
}

export async function startProxy(dataDir) {
  const cfg = readControlConfig(dataDir);
  if (!cfg.enabled) {
    return { ok: false, error: "UNAUTHORIZED", message: "启停代理未授权：请在「设置 → 代理启停」里开启「允许 Agent 启停代理」。" };
  }
  const L = cfg.launcher;
  if (!L) {
    return { ok: false, error: "NO_LAUNCHER", message: "未配置梯子路径：请在「设置 → 代理启停」里扫描并保存。" };
  }
  if (await probePort(L.port)) return { ok: true, alreadyRunning: true, port: L.port, message: `梯子已在运行（端口 ${L.port}）。` };

  const r = await startByLauncher(L);
  appendAudit(dataDir, { action: "start", launcher: L.id, ok: r.ok, pid: r.pid ?? null, error: r.error ?? null });
  if (!r.ok) return { ok: false, error: "START_FAILED", message: r.error || "启动失败。" };

  const up = await waitPort(L.port, 15000);
  appendAudit(dataDir, { action: "start-wait", port: L.port, up });
  return {
    ok: up,
    port: L.port,
    started: true,
    portReady: up,
    message: up ? `已启动，端口 ${L.port} 就绪。` : `进程已拉起，但端口 ${L.port} 在 15 秒内未就绪（可能端口不同或启动方式需调整）。`,
  };
}

export async function stopProxy(dataDir) {
  const cfg = readControlConfig(dataDir);
  if (!cfg.enabled) {
    return { ok: false, error: "UNAUTHORIZED", message: "启停代理未授权：请在「设置 → 代理启停」里开启「允许 Agent 启停代理」。" };
  }
  const L = cfg.launcher;
  if (!L) {
    return { ok: false, error: "NO_LAUNCHER", message: "未配置梯子路径：请在「设置 → 代理启停」里扫描并保存。" };
  }
  if (!(await probePort(L.port))) return { ok: true, alreadyStopped: true, port: L.port, message: `梯子未在运行（端口 ${L.port} 不通）。` };

  const r = await stopByLauncher(L);
  appendAudit(dataDir, { action: "stop", launcher: L.id, ok: r.ok, killed: r.killed, stillRunning: r.stillRunning });
  const gone = await waitPortGone(L.port, 6000);
  let message;
  if (gone) {
    message = `已停止，端口 ${L.port} 已关闭。`;
  } else if (r.stillRunning.length) {
    const killedPart = r.killed.length ? `${r.killed.join("、")} 已退出；` : "无进程被结束；";
    message = `未完全停止：${killedPart}${r.stillRunning.join("、")} 仍在运行（多为管理员权限或守护进程，App 不自行提权）。端口 ${L.port} 仍开着——如需完全停止，请用梯子界面退出，或以管理员身份操作。`;
  } else {
    message = `已发出结束命令，但端口 ${L.port} 仍开着（可能有守护进程或端口被其他程序占用）。`;
  }
  return {
    ok: gone,
    port: L.port,
    stopped: gone,
    killed: r.killed,
    stillRunning: r.stillRunning,
    message,
  };
}

// 实测配方：起 → 探端口 → 停（恢复原状）。
// 梯子已运行时绝不启停，只报告「运行中」——不打断用户的网络。
export async function verifyLauncher(dataDir, launcher) {
  const L = normalizeLauncher(launcher);
  if (!L) return { ok: false, error: "NO_LAUNCHER", message: "没有可验证的梯子配置。" };
  if (!fs.existsSync(L.exe)) return { ok: false, error: "EXE_NOT_FOUND", message: `路径不存在：${L.exe}` };

  if (await probePort(L.port)) {
    return {
      ok: false,
      error: "ALREADY_RUNNING",
      message: `梯子正在运行（端口 ${L.port} 通），没有做启停实测——不打断你的网络。配方已保存，可直接使用。`,
    };
  }

  const started = await startByLauncher(L);
  if (!started.ok) return { ok: false, error: "START_FAILED", message: started.error || "启动失败。" };
  const up = await waitPort(L.port, 15000);
  await stopByLauncher(L); // 无论成败都停掉，恢复原状
  const gone = await waitPortGone(L.port, 8000);

  appendAudit(dataDir, { action: "verify", launcher: L.id, up, restored: gone });
  if (!up) return { ok: false, error: "PORT_NOT_UP", message: `已经尝试启动，但 ${L.port} 端口在 15 秒内未就绪。可能启动方式或端口与实际不同。` };
  return { ok: true, verifiedAt: new Date().toISOString(), restored: gone, message: `实测通过：启动后 ${L.port} 端口就绪，随后已恢复原状。` };
}
