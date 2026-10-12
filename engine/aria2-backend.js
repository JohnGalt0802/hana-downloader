// hana-downloader-app/engine/aria2-backend.js
// aria2 传输后端：专属实例管理 + JSON-RPC 客户端 + 状态映射。
//
// 设计边界（按评审结论定档）：
//   - 引擎管任务与交付，aria2 只管传输与分段。两者不能同时决定任务生命周期。
//   - 只使用、只管理、只关闭「本 App 自己启动的」aria2 实例；绝不全局杀 aria2c.exe，
//     也不复用其它扩展（如 github-download skill）的 6801 实例。
//   - 异常时停住：提交结果不明 / RPC 失联 / 取消未确认，一律保持待处理状态，
//     不自动降级、不假报成功。由上层（dlcore）决定如何呈现与让用户重试。
//
// 不做的事（明确记录，避免后续误加）：
//   - 不做全自动崩溃对账，不引入 daemon 身份体系与多层持久化 phase。
//   - 不用 .part 文件长度当进度（多段下载会预分配完整长度）。
//   - 不把 aria2 的 complete 直接映射为业务 done（交付由上层完成校验后决定）。

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// 专属实例默认端口：刻意避开 github-download skill 的 6801，避免撞车。
const DEFAULT_PORT = 6802;
const READY_WAIT_MS = 8000;
const RPC_TIMEOUT_MS = 8000;

// ── 配置 ────────────────────────────────────────────────────────────
// 读取顺序：engine-config.json 的 aria2 段（管理器设置写入）→ 默认值。
// bin 允许用户指定已有 aria2c 可执行文件（首版不捆绑二进制）。
function loadAria2Config(dataDir) {
  const out = {
    enabled: false,
    bin: "",
    port: DEFAULT_PORT,
    secret: "",
    // 分段参数：minSplitSize 默认调小到 1MB（aria2 原生默认 20MB，
    // 小于该值的文件不分段——实测 5.4MB 文件 numPieces=6、单连接）。
    minSplitSize: 1 << 20,
    split: 16,
    maxConnectionPerServer: 16,
    // gh-proxy 加速前缀（仅用于可识别的 GitHub 直链；空串表示不启用）
    ghProxy: "",
  };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "engine-config.json"), "utf8")) || {};
    const a = raw.aria2 && typeof raw.aria2 === "object" ? raw.aria2 : {};
    if (typeof a.enabled === "boolean") out.enabled = a.enabled;
    if (typeof a.bin === "string" && a.bin.trim()) out.bin = a.bin.trim();
    const p = Number(a.port);
    if (Number.isFinite(p) && p > 0 && p < 65536) out.port = Math.floor(p);
    if (typeof a.secret === "string") out.secret = a.secret;
    const ms = Number(a.minSplitSize);
    if (Number.isFinite(ms) && ms > 0) out.minSplitSize = Math.floor(ms);
    const sp = Number(a.split);
    if (Number.isFinite(sp) && sp > 0) out.split = Math.floor(sp);
    const mc = Number(a.maxConnectionPerServer);
    if (Number.isFinite(mc) && mc > 0) out.maxConnectionPerServer = Math.floor(mc);
    if (typeof a.ghProxy === "string") out.ghProxy = a.ghProxy.trim();
  } catch { /* 配置缺失/损坏都用默认值 */ }
  return out;
}

// 专属实例的运行目录（配置、密钥、会话、日志都在 App 数据目录下，与 skill 完全隔离）
function instanceDir(dataDir) {
  return path.join(dataDir, "aria2");
}

// 密钥：首次生成并落盘，之后稳定复用（RPC 鉴权用，只监听回环）
function ensureSecret(dataDir) {
  const dir = instanceDir(dataDir);
  const f = path.join(dir, "secret.txt");
  try {
    const s = fs.readFileSync(f, "utf8").trim();
    if (s) return s;
  } catch { /* 首次无文件 */ }
  const s = randomBytes(24).toString("hex");
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, s, "utf8"); } catch { /* 落盘失败则用内存值 */ }
  return s;
}

// 定位 aria2c：显式配置 → PATH。
// 刻意不内置本机私有路径：那会把某台机器的目录结构写进源码，对其它用户是无效的，
// 也与「不让 hana-downloader 耦合到其它扩展的安装位置」这一边界相背。
// 首版由用户在 engine-config.json 里指定 aria2.bin；未指定时看 PATH。
function resolveAria2Bin(cfg) {
  if (cfg.bin) {
    try { if (fs.existsSync(cfg.bin)) return cfg.bin; } catch { /* 路径非法则继续 */ }
    return ""; // 显式指定了但不存在：不动回落到 PATH（避免“配错了却偷偷用别的”）
  }
  try {
    const r = spawnSync("aria2c", ["--version"], { windowsHide: true, timeout: 4000 });
    if (r.status === 0) return "aria2c";
  } catch { /* 未安装 */ }
  return "";
}

// ── 单例状态（按 dataDir 键，避免多实例串扰）────────────────────────
const STATES = new Map(); // dataDir -> { proc, port, secret, starting }
function stateOf(dataDir) {
  let s = STATES.get(dataDir);
  if (!s) { s = { proc: null, port: 0, secret: "", starting: null }; STATES.set(dataDir, s); }
  return s;
}

async function rpcCall(dataDir, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  const st = stateOf(dataDir);
  const cfg = loadAria2Config(dataDir);
  const port = st.port || cfg.port;
  const secret = st.secret || ensureSecret(dataDir);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "hd-" + Date.now(),
    method,
    params: [`token:${secret}`, ...params],
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) {
      const e = new Error(`aria2 ${method} 失败：${j.error.message || JSON.stringify(j.error)}`);
      e.rpcCode = j.error.code;
      throw e;
    }
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

// 探活：getVersion 能通即视为可用。失败一律返回 false，不外抛。
async function ping(dataDir) {
  try { await rpcCall(dataDir, "aria2.getVersion", [], 3000); return true; } catch { return false; }
}

// ── 专属实例启停 ─────────────────────────────────────────────────────
// 只在「本 App 尚无活实例」时启动。启动后记录 pid，停止时只作用于该 pid / 该实例。
async function ensureDaemon(dataDir, { log } = {}) {
  const st = stateOf(dataDir);
  if (await ping(dataDir)) return { ok: true, reused: true, port: st.port || loadAria2Config(dataDir).port };

  if (st.starting) { await st.starting; return { ok: await ping(dataDir), port: st.port || loadAria2Config(dataDir).port }; }

  const cfg = loadAria2Config(dataDir);
  const bin = resolveAria2Bin(cfg);
  if (!bin) return { ok: false, error: "未找到 aria2c 可执行文件（可在设置里指定路径）" };

  const dir = instanceDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const secret = ensureSecret(dataDir);
  st.secret = secret;
  const port = cfg.port;
  st.port = port;

  const args = [
    "--enable-rpc",
    `--rpc-listen-port=${port}`,
    "--rpc-listen-all=false",          // 只监听回环，不对外
    `--rpc-secret=${secret}`,
    "--rpc-allow-origin-all=false",
    "--continue=true",
    "--allow-overwrite=true",          // 交付路径由本 App 定，禁用 aria2 自动改名策略
    "--auto-file-renaming=false",
    "--check-certificate=false",
    `--max-connection-per-server=${cfg.maxConnectionPerServer}`,
    `--split=${cfg.split}`,
    `--min-split-size=${cfg.minSplitSize}`,
    "--console-log-level=warn",
    "--summary-interval=0",
    `--save-session=${path.join(dir, "session.txt")}`,
    "--save-session-interval=30",
    "--auto-save-interval=30",
  ];

  st.starting = (async () => {
    const child = spawn(bin, args, { windowsHide: true, detached: false, stdio: "ignore" });
    st.proc = child;
    child.on("exit", () => { st.proc = null; });
    const t0 = Date.now();
    while (Date.now() - t0 < READY_WAIT_MS) {
      if (await ping(dataDir)) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`aria2 启动后 ${READY_WAIT_MS}ms 内未就绪（端口 ${port}）`);
  })();

  try {
    await st.starting;
    st.starting = null;
    if (log) log(`aria2 daemon ready | port=${port} bin=${bin}`);
    return { ok: true, port, started: true };
  } catch (e) {
    st.starting = null;
    try { if (st.proc && st.proc.pid) st.proc.kill(); } catch { /* 忽略 */ }
    st.proc = null;
    return { ok: false, error: String(e?.message || e) };
  }
}

// 关闭「本 App 自己启动的」实例。绝不按进程名全局杀。
// 优先走 RPC shutdown（优雅落 session）；失败再按记下的 pid 结束。
async function shutdownDaemon(dataDir, { log } = {}) {
  const st = stateOf(dataDir);
  if (!st.proc) return { ok: true, skipped: "本 App 未启动过实例" };
  try { await rpcCall(dataDir, "aria2.shutdown", [], 3000); } catch { /* 可能已退出 */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 3000 && st.proc) await new Promise((r) => setTimeout(r, 200));
  if (st.proc && st.proc.pid) {
    try { spawnSync("taskkill", ["/pid", String(st.proc.pid), "/T", "/F"], { windowsHide: true, timeout: 4000 }); } catch { /* 忽略 */ }
  }
  st.proc = null;
  if (log) log("aria2 daemon shutdown");
  return { ok: true };
}

// ── 状态映射 ────────────────────────────────────────────────────────
// aria2 传输状态 → 引擎任务状态。注意 complete 只代表「传输完成」，
// 业务 done 由上层在校验与改名之后决定，这里不产出 done。
function mapTransferState(s) {
  switch (String(s || "").toLowerCase()) {
    case "active": return "running";
    case "waiting": return "running";   // 已提交、等 aria2 调度；对引擎而言仍在途
    case "paused": return "running";    // 暂停仍在途，卡片语义不变
    case "complete": return "transfer-complete";
    case "error": return "failed";
    case "removed": return "canceled";
    default: return "running";
  }
}

// tellStatus 原始结果 → 引擎可用的最小字段集。
function mapStatus(raw) {
  if (!raw) return null;
  const total = Number(raw.totalLength) || 0;
  const received = Number(raw.completedLength) || 0;
  const speed = Number(raw.downloadSpeed) || 0;
  // 注意：errorCode 是字符串 "0"（truthy），必须按数值/字符串语义判断，不能用普通真值判断。
  const errCode = raw.errorCode == null ? 0 : Number(raw.errorCode);
  return {
    transferState: mapTransferState(raw.status),
    rawStatus: String(raw.status || ""),
    total: total > 0 ? total : null,
    received,
    speed,
    errorCode: Number.isFinite(errCode) ? errCode : 0,
    errorMessage: raw.errorMessage || "",
    connections: Number(raw.connections) || 0,
  };
}

// ── 对外接口 ────────────────────────────────────────────────────────
export const aria2 = {
  config: loadAria2Config,
  instanceDir,
  resolveBin: resolveAria2Bin,
  ensureDaemon,
  shutdownDaemon,
  ping,
  mapStatus,
  rpc: rpcCall,

  // 提交下载。返回 gid。out 由上层指定（形如 "<name>.part"），保证临时文件与最终文件分离。
  // 指定 gid 必须放在 options 里（key: gid）——实测传位置参数会报 “The parameter at 2 has wrong type”。
  async addUri(dataDir, { url, dir, out, split, maxConn, minSplit, gid, proxy, extra } = {}) {
    const cfg = loadAria2Config(dataDir);
    const opts = {
      dir,
      out,
      split: String(split || cfg.split),
      "max-connection-per-server": String(maxConn || cfg.maxConnectionPerServer),
      "min-split-size": String(minSplit || cfg.minSplitSize),
      "check-certificate": "false",
      "allow-overwrite": "true",
      "auto-file-renaming": "false",
      // HTTP/HTTPS 代理（engine 按目标域名解析后传入）。aria2 是独立进程，
      // 不继承引擎的进程代理，不显式传它就会裸直连——国外源会 SSL 握手失败。
      ...(proxy ? { "all-proxy": String(proxy) } : {}),
      ...(gid ? { gid: String(gid) } : {}), // 预分配 gid：便于提交结果不明时按 gid 对账
      ...(extra || {}),
    };
    return rpcCall(dataDir, "aria2.addUri", [[url], opts]);
  },

  async tellStatus(dataDir, gid, keys) {
    const k = keys || ["status", "totalLength", "completedLength", "downloadSpeed", "errorCode", "errorMessage", "connections", "files"];
    return rpcCall(dataDir, "aria2.tellStatus", [gid, k]);
  },

  async remove(dataDir, gid) {
    try { return await rpcCall(dataDir, "aria2.remove", [gid]); } catch (e) { throw e; }
  },
  async forceRemove(dataDir, gid) {
    try { return await rpcCall(dataDir, "aria2.forceRemove", [gid]); } catch (e) { throw e; }
  },
  // gid 是否仍在 aria2 视野**且仍活跃**（用于取消/提交歧义对账）。
  // 注意：返回 true 的含义是「仍会写文件」，不是「存在」——
  // aria2 的 tellStatus 对已终态（complete/error/removed）的 gid 依然可查，
  // 若把「存在」当「仍在跑」，失败任务的重试会被自己永远挡住（实测踩过）。
  async hasGid(dataDir, gid) {
    try {
      const r = await rpcCall(dataDir, "aria2.tellStatus", [gid, ["gid", "status"]], 5000);
      const st = String(r?.status || "").toLowerCase();
      return ["active", "waiting", "paused"].includes(st);
    } catch (e) {
      if (/not found|is not found/i.test(String(e?.message || ""))) return false;
      return null; // null = 无法判定
    }
  },
};

export { loadAria2Config };
