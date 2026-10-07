// hana-downloader-app/engine/server.js — 受管下载引擎（完整版）
// 复用插件时代的下载内核 lib/dlcore.js（纯 Node，无宿主依赖），对外提供 HTTP 服务：
//   GET  /ping                        健康检查
//   POST /download                    发起 URL 下载 { url, fileName?, saveDir?, speedLimit?, expectedSha256?, stallTimeoutMs?, sessionPath? }
//   POST /command                     发起命令型下载 { kind: "git-clone"|"pnpm-install", repo?, targetDir?, workdir?, label? }
//   GET  /wait?taskId=xxx             进度快照
//   POST /cancel  { taskId, source? } 取消
//   GET  /list                        全部任务
//   POST /retry   { taskId }          重试一个终态任务（管理器按钮；URL 任务按断点续传）
// 由 app 经 ctx.runtime.fetch(runtimeId, path) 访问，服务注册见 manifest 的 service 参数。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getTaskManager, resolveWingetBin } from "./dlcore.js";
import { parseWingetSearch } from "./progress-parsers.js";
import { ENGINE_PORT } from "./engine-port.js";
import {
  scanCandidates,
  getStatus as getProxyControlStatus,
  startProxy,
  stopProxy,
  verifyLauncher,
  writeControlConfig,
} from "./proxy-control.js";

// 端口来源唯一：engine-port.js（index.js 与引擎共用一个常量）。
// HD_ENGINE_PORT 只作本机调试覆盖；默认值不再在这里重复写一个数字。
const PORT = Number(process.env.HD_ENGINE_PORT || ENGINE_PORT);
const READY_MARKER = "HD_ENGINE_READY";
// dataDir 由 app 经 args 传入（受管程序的 cwd 不保证指向 app 数据目录）
const DATA_DIR = process.argv[2] || process.env.HD_ENGINE_DATA_DIR || process.cwd();
const CFG_FILE = path.join(DATA_DIR, "engine-config.json");
// 用户配置（config.json）：目前只放 proxy（代理模式与自定义名单），由 dlcore.js 读取。
// 与 engine-config.json 分开：前者是「运行行为」的开关（管理器设置菜单写），
// 后者是「下载策略」的长期配置（可手工编辑，不至于被设置菜单覆盖掉）。
const USER_CFG_FILE = path.join(DATA_DIR, "config.json");

const log = (s) => { try { console.log(`[hd-engine] ${s}`); } catch {} };

// 全局设置（engine-config.json）：defaultSaveDir / agentChooses / stallTimeoutMs。
// 由管理器的设置菜单经 POST /settings 写入，下载时作为缺省值生效。
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) || {}; } catch { return {}; }
}

function loadUserCfg() {
  try { return JSON.parse(fs.readFileSync(USER_CFG_FILE, "utf8")) || {}; } catch { return {}; }
}

// 把 config.json 的 proxy 字段归一到三档给 UI 展示
//   false → never；字符串 → always；对象 → 取其 mode；其它 → auto
function normalizeProxyMode(p) {
  if (p === false) return "never";
  if (typeof p === "string" && p.trim()) return "always";
  if (p && typeof p === "object" && ["auto", "always", "never"].includes(p.mode)) return p.mode;
  return "auto";
}

const mgr = getTaskManager(DATA_DIR);
try { mgr.restore(); } catch (e) { log(`restore ERR ${e?.message || e}`); }
// 启动即灌一次运行上限（并发与默认限速），改设置后每次发起前再灌一次
try { mgr.applyConfig(loadCfg()); } catch (e) { log(`applyConfig ERR ${e?.message || e}`); }

// ── 卡片绑定表（bindings.json）──
// 见下方 /bind、/register-card 两个端点。
const BIND_FILE = path.join(DATA_DIR, "bindings.json");
function loadBind() {
  try {
    const j = JSON.parse(fs.readFileSync(BIND_FILE, "utf8"));
    const db = {
      pending: j.pending || {},
      bind: j.bind || {},
      assigned: j.assigned || {},
      rounds: j.rounds || {},
      stable: j.stable || {},
    };
    // 迁移：早期版本只有 bind 表、没有 assigned 标记。不补的话，升级后第一次认领
    // 会把一个已经发过卡的老任务当成“新任务”再发一遍（实测过）。
    if (!Object.keys(db.assigned).length && Object.keys(db.bind).length) {
      for (const tid of Object.values(db.bind)) db.assigned[tid] = true;
    }
    return db;
  } catch { return { pending: {}, bind: {}, assigned: {}, rounds: {}, stable: {} }; }
}
function saveBind(db) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BIND_FILE, JSON.stringify(db), "utf8");
  } catch (e) { log(`saveBind ERR ${e?.message || e}`); }
}

// ── 事件落盘（终态 / 停滞）──
// app 侧不吃 RPC：轮询会产生持续挂起的连接，把工具回程前的 drain() 堵死。
// 所以引擎把事件写成文件，app 用 fs 轮询。
//
// 字段说明（2026-09-20 补）：sessionPath / sessionId 必须带上——app 侧收到卡滞快照后
// 要靠它把「任务停滞，需要决策」投回原会话（卡滞发生在工具 execute 早已结束之后，
// 那条宿主任务通道要 callToken，用不了）。stalledAt 用于 app 侧去重（同一任务两次卡滞是两件事）。
const summarize = (t) => t ? ({
  taskId: t.taskId, state: t.state || t.status, fileName: t.fileName, url: t.url,
  total: t.total ?? null, received: t.received ?? 0, filePath: t.filePath || null,
  error: t.error || null, canceledBy: t.canceledBy || null,
  cmdType: t.cmd?.type || null, note: t.note || null,
  sessionPath: t.sessionPath || null, sessionId: t.sessionId || null,
  stallTaskId: t.stallTaskId || null,
  stalledAt: t.stalledAt || null,
}) : null;

try { mgr.onFinal((t) => {
    log(`final ${t?.taskId} ${t?.state}`);
    // 落一个结果文件：app 侧用 fs 轮询它（不走 RPC，避免堵住工具回程的 rpc2.drain()）
    try {
      const dir = path.join(DATA_DIR, "finished");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${t.taskId}.json`), JSON.stringify(summarize(t)), "utf8");
    } catch (e) { log(`write finished ERR ${e?.message || e}`); }
  }); } catch (e) { log(`onFinal ERR ${e?.message || e}`); }
try { mgr.onStall((t) => {
  log(`stall ${t?.taskId}`);
  // 与 finished 同一机制：落盘让 app 侧用 fs 轮询到（不占 RPC，不堵工具回包）
  try {
    const dir = path.join(DATA_DIR, "stalled");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${t.taskId}.json`), JSON.stringify(summarize(t)), "utf8");
  } catch (e) { log(`write stalled ERR ${e?.message || e}`); }
}); } catch (e) { log(`onStall ERR ${e?.message || e}`); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = async () => { let raw = ""; for await (const c of req) raw += c; try { return JSON.parse(raw || "{}"); } catch { return {}; } };

  if (req.method === "GET" && u.pathname === "/ping") return send(200, { ok: true, pid: process.pid, ts: Date.now() });

  // ── 卡片绑定 ─────────────────────────────────────────────────
  // 聊天流卡由宿主的 messageRenderers 通道投影出来，卡片 iframe 拿不到投递消息的
  // payload，也就不知道自己是哪个任务。所以绑定关系由本引擎维护：
  //   pending  taskId -> { sessionId, title, seq }   已投递、等卡片来认领的任务
  //   bind     cardInstanceId -> taskId              已经认领过的卡片
  // cardInstanceId 由宿主铸造、重新投影后不变，所以会话重载不会串任务。
  if (req.method === "POST" && u.pathname === "/register-card") {
    const b = await readBody();
    if (!b.taskId) return send(400, { error: "taskId required" });
    const db = loadBind();
    db.pending[String(b.taskId)] = {
      sessionId: b.sessionId ? String(b.sessionId) : null,
      title: b.title ? String(b.title) : null,
      seq: Number(b.seq) || Date.now(),
    };
    // 投递时指定的稳定卡片实例 id：卡片跨会话重载后靠它直接认人，不依赖顺序推断。
    if (b.cardInstanceId) db.stable[String(b.cardInstanceId)] = String(b.taskId);
    saveBind(db);
    log(`register-card ${b.taskId} | session=${b.sessionId || "-"} | card=${b.cardInstanceId || "-"}`);
    return send(200, { ok: true });
  }

  if (req.method === "POST" && u.pathname === "/bind") {
    const b = await readBody();
    const cardId = String(b.cardInstanceId || "").trim();
    const sessionId = b.sessionId ? String(b.sessionId) : null;
    const sidKey = sessionId || "__global__";
    if (!cardId) return send(400, { error: "cardInstanceId required" });

    const db = loadBind();
    // 0) 投递时指定的稳定实例 id：最确定的一条路（跨重载不变）
    if (db.stable[cardId]) {
      const tid = db.stable[cardId];
      db.bind[cardId] = tid;
      db.assigned[tid] = true;
      saveBind(db);
      log(`bind ${cardId} -> ${tid} (stable)`);
      return send(200, { ok: true, taskId: tid, matched: "stable" });
    }
    // 1) 已经认领过：幂等返回（同一次 iframe 生命周期内重复请求走这里）
    if (db.bind[cardId]) return send(200, { ok: true, taskId: db.bind[cardId], matched: "cache" });

    // 本会话的任务序列，按投递先后排
    const all = Object.entries(db.pending)
      .filter(([, v]) => !sessionId || v.sessionId === sessionId)
      .map(([tid, v]) => ({ taskId: tid, ...v }))
      .sort((a, z) => (a.seq || 0) - (z.seq || 0));

    if (!all.length) {
      // 池子空（手工打开卡片 / 本会话没有待认领任务）：退回“在途优先、否则最近一条”
      try {
        const list = mgr.list() || [];
        const active = list.filter((t) => t && (t.state === "running" || t.state === "pending"));
        const pick = active[0] || list[list.length - 1];
        if (pick?.taskId) return send(200, { ok: true, taskId: pick.taskId, matched: "fallback" });
      } catch (e) { log(`bind fallback ERR ${e?.message || e}`); }
      return send(404, { error: "no task to bind", cardInstanceId: cardId });
    }

    // 2) 优先分配“从未被分配过”的任务——增量场景（刚发起的新下载就是这种）
    let hit = all.find((p) => !db.assigned[p.taskId]);
    let matched = "new";

    // 3) 所有任务都分配过了：说明卡片在会话重载后重新加载了。
    //    注意：cardInstanceId 在实时投影与历史投影下并不相同，所以不能靠它跨重载认人。
    //    这里改成按顺序轮转：重载时所有卡片几乎同时请求，先到的拿更老的任务，
    //    而 iframe 的加载顺序就是消息顺序，所以能对上。
    if (!hit) {
      const now = Date.now();
      let round = db.rounds[sidKey];
      if (!round || now - (round.at || 0) > 8000) round = db.rounds[sidKey] = { at: now, i: 0 };
      round.at = now;
      hit = all[round.i % all.length];
      round.i += 1;
      matched = "rotate";
    }

    db.bind[cardId] = hit.taskId;
    db.assigned[hit.taskId] = true;
    saveBind(db);
    log(`bind ${cardId} -> ${hit.taskId} (${matched})`);
    return send(200, { ok: true, taskId: hit.taskId, matched });
  }

  if (req.method === "GET" && u.pathname === "/list") {
    let tasks = [];
    try { tasks = mgr.list() || []; } catch (e) { return send(500, { error: String(e?.message || e) }); }
    return send(200, { ok: true, tasks: tasks.map(summarize) });
  }

  if (req.method === "POST" && u.pathname === "/wait") {
    const b = await readBody();
    let taskId = b.taskId || u.searchParams.get("taskId");
    // 卡片中心 / 黑板用静态 route 打开时没有 taskId：回退到最近任务
    // （running/pending 优先，无在途任务时取最新一条），与旧插件服务端行为一致。
    if (!taskId) {
      try {
        const all = mgr.tasks && typeof mgr.tasks.values === "function" ? [...mgr.tasks.values()] : [];
        const active = all.filter((t) => t && (t.state === "running" || t.state === "pending"));
        const pick = active.length > 0 ? active[0] : all[all.length - 1];
        if (pick?.taskId) taskId = pick.taskId;
      } catch (e) { log(`wait fallback ERR ${e?.message || e}`); }
    }
    if (!taskId) return send(404, { error: "no task", taskId: null });
    const snap = mgr.snapshot(taskId);
    if (!snap) return send(404, { error: "not found", taskId });
    // 同时给 snap 和 task 两个键：前者是本引擎的命名，后者是卡片前端（自插件时代沿用）读的字段
    return send(200, { ok: true, snap, task: snap });
  }

  // 兼容旧式 query 调用（宿主导由对带 query 的路径支持不稳定，故主用 POST）
  if (req.method === "GET" && u.pathname === "/wait") {
    const taskId = u.searchParams.get("taskId");
    if (!taskId) return send(400, { error: "taskId required" });
    const snap = mgr.snapshot(taskId);
    if (!snap) return send(404, { error: "not found", taskId });
    return send(200, { ok: true, snap });
  }

  if (req.method === "POST" && u.pathname === "/download") {
    const b = await readBody();
    if (!b.url) return send(400, { error: "url required" });
    try {
      const cfg = loadCfg();
      mgr.applyConfig(cfg); // 并发上限与默认限速（管理器设置，2026-09-20）
      // 默认保存目录：任务未显式指定时套用全局设置。
      // agentChooses=true 表示“由助手每次决定”，此时不套用固定目录。
      const cfgSaveDir = (!b.saveDir && !cfg.agentChooses && cfg.defaultSaveDir) ? String(cfg.defaultSaveDir) : null;
      const t = await mgr.create({
        url: b.url,
        fileName: b.fileName || undefined,
        saveDir: b.saveDir || cfgSaveDir || undefined,
        speedLimit: b.speedLimit || undefined,
        // 期望摘要：统一小写后交给内核比对（内核算出来的是小写 hex）
        expectedSha256: b.expectedSha256 ? String(b.expectedSha256).trim().toLowerCase() : undefined,
        stallTimeoutMs: b.stallTimeoutMs || cfg.stallTimeoutMs || undefined,
        sessionPath: b.sessionPath || null,
        sessionId: b.sessionId || null,
        stallTaskId: b.stallTaskId || null,
        kind: "url",
      });
      log(`created ${t?.taskId} | ${b.url}`);
      return send(200, { ok: true, taskId: t?.taskId, state: t?.state || t?.status });
    } catch (e) {
      log(`create ERR ${e?.message || e}`);
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/command") {
    const b = await readBody();
    const kind = String(b.kind || "").trim();
    const workdir = b.workdir ? path.resolve(String(b.workdir).trim()) : process.cwd();
    let cmd = null, fileName = "", filePath = "", unit = "bytes", taskUrl = null;
    try {
      if (kind === "git-clone") {
        const repo = String(b.repo || "").trim();
        if (!repo) return send(400, { error: "git-clone 需要仓库地址（repo）" });
        if (!fs.existsSync(workdir)) return send(400, { error: `工作目录不存在：${workdir}` });
        const repoName = repoNameOf(repo);
        const targetDir = b.targetDir ? path.resolve(String(b.targetDir).trim()) : path.join(workdir, repoName);
        if (fs.existsSync(targetDir)) return send(409, { error: `目标目录已存在，为避免覆盖：${targetDir}` });
        filePath = targetDir;
        fileName = b.label ? String(b.label).trim() : repoName;
        unit = "objects";
        cmd = { type: "git-clone", args: [repo, targetDir], workdir, targetDir };
      } else if (kind === "pnpm-install") {
        if (!fs.existsSync(workdir)) return send(400, { error: `工作目录不存在：${workdir}` });
        filePath = workdir;
        fileName = b.label ? String(b.label).trim() : path.basename(workdir) + "（依赖安装）";
        unit = "packages";
        cmd = { type: "pnpm-install", args: [], workdir };
      } else if (kind === "winget-install") {
        const pkg = String(b.pkg || "").trim();
        if (!pkg) return send(400, { error: "winget-install 需要包名或 ID（pkg）" });
        if (pkg.startsWith("-")) return send(400, { error: "包名不能以 - 开头" });
        // 先搜后装：search 在本端点同步完成（1~3 秒）；多候选时不创建任务，把候选列表交给工具侧。
        const cap = await runCapture(resolveWingetBin(),
          ["search", "--query", pkg, "--accept-source-agreements", "--disable-interactivity"], 30000);
        if (cap.spawnError) return send(500, { error: `winget 无法启动：${cap.spawnError.message || cap.spawnError}` });
        const rows = parseWingetSearch(cap.out);
        if (!rows.length) {
          return send(200, { ok: false, error: `winget 未找到与「${pkg}」匹配的包（可换关键词或直接给完整 ID）` });
        }
        const exact = rows.find((r) => r.id.toLowerCase() === pkg.toLowerCase());
        const pick = exact || (rows.length === 1 ? rows[0] : null);
        if (!pick) {
          return send(200, { ok: false, multiple: true, query: pkg, candidates: rows.slice(0, 10) });
        }
        fileName = `${pick.name || pick.id}${pick.version ? " " + pick.version : ""}`;
        filePath = "";
        unit = "steps";
        taskUrl = `winget:${pick.id}`;
        cmd = {
          type: "winget-install",
          pkgId: pick.id,
          pkgName: pick.name || "",
          pkgVersion: pick.version || "",
          scope: b.scope === "user" || b.scope === "machine" ? b.scope : null,
          source: b.source ? String(b.source).trim() : null,
        };
      } else if (kind === "pip-install") {
        const pkg = String(b.pkg || "").trim();
        if (!pkg) return send(400, { error: "pip-install 需要包名（pkg）" });
        if (pkg.startsWith("-")) return send(400, { error: "包名不能以 - 开头" });
        fileName = b.label ? String(b.label).trim() : pkg;
        filePath = "";
        unit = "packages";
        taskUrl = `pip:${pkg}`;
        cmd = {
          type: "pip-install",
          pkg,
          runner: b.runner === "uv" ? "uv" : "python",
          pythonPath: b.pythonPath ? path.resolve(String(b.pythonPath).trim()) : null,
          upgrade: !!b.upgrade,
        };
      } else {
        return send(400, { error: `不支持的命令类型：${kind}（支持 git-clone / pnpm-install / winget-install / pip-install）` });
      }
      mgr.applyConfig(loadCfg()); // 并发上限对命令型同样生效（2026-09-20）
      const t = await mgr.create({
        kind: "command",
        cmd,
        unit,
        fileName,
        filePath: filePath || null,
        url: taskUrl || undefined,
        saveDir: filePath ? path.dirname(filePath) : undefined,
        stallTimeoutMs: b.stallTimeoutMs || loadCfg().stallTimeoutMs || undefined,
        sessionPath: b.sessionPath || null,
        sessionId: b.sessionId || null,
        stallTaskId: b.stallTaskId || null,
      });
      log(`created command ${t?.taskId} | ${kind} ${fileName}`);
      return send(200, { ok: true, taskId: t?.taskId, state: t?.state || t?.status, kind: "command", fileName, filePath: filePath || null });
    } catch (e) {
      log(`command ERR ${e?.message || e}`);
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/retry") {
    const b = await readBody();
    if (!b.taskId) return send(400, { error: "taskId required" });
    try {
      // 先清上一轮的终态痕迹再重跑：否则 app 侧的轮询会先读到旧快照，把这一次当成“已完成”
      for (const d of ["finished", "stalled"]) {
        try { fs.unlinkSync(path.join(DATA_DIR, d, `${b.taskId}.json`)); } catch { /* 本来就没有 */ }
      }
      mgr.applyConfig(loadCfg());
      const r = mgr.retry(b.taskId);
      if (!r.ok) return send(400, r);
      const snap = mgr.snapshot(b.taskId);
      log(`retry ${b.taskId} | state=${snap?.state}`);
      return send(200, {
        ok: true,
        taskId: b.taskId,
        state: snap?.state || null,
        queued: snap?.queued === true,
        sessionPath: snap?.sessionPath || null,
        sessionId: snap?.sessionId || null,
        fileName: snap?.fileName || null,
      });
    } catch (e) {
      log(`retry ERR ${e?.message || e}`);
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/cancel") {
    const b = await readBody();
    if (!b.taskId) return send(400, { error: "taskId required" });
    try {
      const r = mgr.cancel(b.taskId, b.source || "agent");
      log(`cancel ${b.taskId} -> ${JSON.stringify(r)}`);
      return send(200, { ok: true, result: r ?? null });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  }

  // 在系统文件管理器中定位（local-machine 下可 spawn 本机程序）
  if (req.method === "POST" && u.pathname === "/reveal") {
    const b = await readBody();
    const p = b.filePath || b.path;
    if (!p) return send(400, { error: "filePath required" });
    try {
      const { spawn } = await import("node:child_process");
      spawn("explorer.exe", ["/select,", p], { detached: true, stdio: "ignore" }).unref();
      log(`reveal ${p}`);
      return send(200, { ok: true });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  }

  if (req.method === "POST" && u.pathname === "/clear") {
    const b = await readBody();
    try {
      const r = mgr.clearByStates(b.states || ["done", "failed", "canceled", "interrupted"]);
      return send(200, { ok: true, ...r });
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  // 删除单条记录（deleteFile=true 时连同磁盘产物一起删；详见 TaskManager.forget）
  if (req.method === "POST" && u.pathname === "/forget") {
    const b = await readBody();
    if (!b.taskId) return send(400, { error: "taskId required" });
    try {
      const r = mgr.forget(b.taskId, { deleteFile: !!b.deleteFile });
      if (!r.ok) return send(400, { error: r.error || "删除失败" });
      log(`forget ${b.taskId} | deleteFile=${!!b.deleteFile} | fileDeleted=${r.fileDeleted}`);
      return send(200, r);
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (req.method === "POST" && u.pathname === "/cancel-all") {
    try {
      const r = mgr.cancelAll("user");
      return send(200, { ok: true, ...r });
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/settings") {
    if (req.method === "GET") {
      // proxyMode 由 config.json 归一而来（dlcore.js 读的是那个文件，不是 engine-config.json）
      const s = { ...loadCfg(), proxyMode: normalizeProxyMode(loadUserCfg().proxy) };
      return send(200, { ok: true, settings: s });
    }
    if (req.method === "POST") {
      const b = await readBody();
      try {
        const body = (b && typeof b === "object") ? { ...b } : {};
        // proxyMode 落到 config.json，其余字段照旧落到 engine-config.json
        // （不把 proxyMode 混写进 engine-config.json，两个文件的职责别串）
        if ("proxyMode" in body) {
          const raw = body.proxyMode;
          delete body.proxyMode;
          const mode = ["auto", "always", "never"].includes(raw) ? raw : "auto";
          const uc = loadUserCfg();
          const prevUrl = typeof uc.proxy === "object" && uc.proxy && typeof uc.proxy.url === "string"
            ? uc.proxy.url
            : (typeof uc.proxy === "string" ? uc.proxy : "");
          uc.proxy = mode === "never" ? false : { mode, url: prevUrl };
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(USER_CFG_FILE, JSON.stringify(uc, null, 2), "utf8");
          log(`proxyMode set | ${mode}`);
        }
        const next = { ...loadCfg(), ...body };
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2), "utf8");
        // 改设置即时生效：把新的并发上限与默认限速灌进任务管理器，不等下一次发起
        try { mgr.applyConfig(next); } catch (e2) { log(`applyConfig ERR ${e2?.message || e2}`); }
        return send(200, { ok: true, settings: { ...next, proxyMode: normalizeProxyMode(loadUserCfg().proxy) } });
      } catch (e) { return send(500, { error: String(e?.message || e) }); }
    }
  }

  // ── 代理启停控制（2026-10-04）─────────────────────────────────
  // 纪律：扫描/状态只读；start/stop 需 config.json 里 proxyControl.enabled=true。
  // 「使用代理」不在这里管——那是 dlcore.resolveProxy 的事（对齐裸 curl 的隐式继承）。
  if (u.pathname === "/proxy-control/status" && req.method === "GET") {
    try { return send(200, { ok: true, ...(await getProxyControlStatus(DATA_DIR)) }); }
    catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/proxy-control/scan" && req.method === "GET") {
    try { return send(200, { ok: true, candidates: scanCandidates({ dataDir: DATA_DIR }) }); }
    catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/proxy-control/config" && req.method === "POST") {
    const b = await readBody();
    try {
      const body = (b && typeof b === "object") ? b : {};
      const patch = {};
      if ("enabled" in body) patch.enabled = body.enabled === true;
      if ("launcher" in body) patch.launcher = body.launcher;
      writeControlConfig(DATA_DIR, patch);
      return send(200, { ok: true, ...(await getProxyControlStatus(DATA_DIR)) });
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/proxy-control/verify" && req.method === "POST") {
    const b = await readBody();
    try {
      const body = (b && typeof b === "object") ? b : {};
      const r = await verifyLauncher(DATA_DIR, body.launcher);
      return send(200, { ...r });
    } catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/proxy-control/start" && req.method === "POST") {
    try { return send(200, { ...(await startProxy(DATA_DIR)) }); }
    catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  if (u.pathname === "/proxy-control/stop" && req.method === "POST") {
    try { return send(200, { ...(await stopProxy(DATA_DIR)) }); }
    catch (e) { return send(500, { error: String(e?.message || e) }); }
  }

  // 注意：不能使用 /download/* 前缀（“download” 会被宿主的运行时路由当成保留段，路径被截断）。
  return send(404, { error: "not found", path: u.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`listening 127.0.0.1:${PORT} | dataDir=${DATA_DIR}`);
  // 就绪标记必须独占一行且与 service.readyMarker 精确匹配
  console.log(READY_MARKER);
});

// ── 通用子进程捕获（同步查询用：winget search）──
// 收 stdout/stderr 全文；超时杀进程（kill 后 close 会照常回来）。
function runCapture(bin, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e?.message || e), spawnError: e });
      return;
    }
    let out = "", errText = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.stdout.on("data", (c) => { out += c.toString("utf-8"); });
    child.stderr.on("data", (c) => { errText += c.toString("utf-8"); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e?.message || e), spawnError: e }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err: errText }); });
  });
}

// ── 命令型辅助：仓库名提取与安全化 ──
function repoNameOf(repo) {
  const cleaned = repo.replace(/\.git(?:\/)?$/, "");
  const seg = cleaned.split(/[/\\]+/).filter(Boolean).pop() || "repo";
  return sanitizeName(seg);
}

function sanitizeName(name) {
  const s = String(name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return s || "repo";
}
