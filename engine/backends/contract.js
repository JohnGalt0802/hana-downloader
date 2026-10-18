// engine/backends/contract.js — backend 契约（唯一真相源）
//
// 边界（2026-10-18 定）：**生命周期归 dlcore，传输归 backend。**
//   · dlcore 负责：建任务、排队、并发、停滞监视、elapsed、刷盘、终态回调、快照与摘要
//   · backend 负责：把字节弄到磁盘，并更新 task 上的传输相关字段
//
// ───────────────────────────────────────────────────────────────
// ctx（dlcore._run 传给 backend.run(ctx) 的对象）
// ───────────────────────────────────────────────────────────────
//   ctx.task            任务对象（dlcore._createTask 产出）。字段见下方 REQUIRED/OPTIONAL
//   ctx.dataDir         数据目录（绝对路径）。backend 只允许在这里放自己的实例记录/临时文件
//   ctx.resolveProxy(dataDir, url) → string
//                       返回代理 URL；空串 = 直连。回环目标由 backend 自行跳过代理
//   ctx.friendlyError(err) → string
//                       错误归一为一句人话
//   ctx.persist()       请求 dlcore 刷盘（进度节流用，1.5s 一次即可；不要每条 chunk 都调）
//
// ───────────────────────────────────────────────────────────────
// 必须更新的 task 字段（backend 返回前）
// ───────────────────────────────────────────────────────────────
//   task.state      终态或未完成态：done / failed / canceled / interrupted
//                   （running/pending 是 dlcore 的语义，backend 运行中可以改成 pending
//                     表示「还没真正开始传」，但不得把未完成写成 done）
//   task.received   已完成字节数（进度口径，必须是「内容已落盘的字节」，不是预分配长度）
//   task.total      总字节数；未知给 null（不得给 0 或猜测值）
//   task.error      失败/取消时的人话原因；成功时 null
//
// 可选字段（有就更新，没有 dlcore 也能工作）
//   speed  stage  stageDetail  unit  etag  lastModified  acceptRanges  finishedAt
//
// ───────────────────────────────────────────────────────────────
// 禁止
// ───────────────────────────────────────────────────────────────
//   · 不得调用 dlcore 的内部方法（除 ctx.persist()）：不碰 _fireFinal / _pumpQueue / _persist
//   · 不碰 UI / 会话 / 卡片 / 通知：那是 dlcore 与 App 侧的事
//   · 不得把「传输结束」当成「文件正确」：state=done 必须建立在内容级校验通过之上
//     （有 expectedSha256 就比对 SHA-256；没有摘要时至少保证字节数与落盘一致）
//   · 不得谎报成功：RPC 失联、提交结果不明、取消未确认 —— 一律保持「未完成」并写 error
//
// ───────────────────────────────────────────────────────────────
// 错误语义
// ───────────────────────────────────────────────────────────────
//   backend 可以 throw，也可以自己写 task.state/task.error 后正常返回。
//   throw 的情况下 dlcore 不会再补终态（它会照常 finally 收尾），所以 backend 必须自己
//   把 task.state 写成 failed/interrupted 之后再返回/抛出——见各 backend 的 catch 分支。
import fs from "node:fs";
import { createHash } from "node:crypto";

/** capabilities() 回包必须包含的字段 */
export const REQUIRED_CAPABILITIES = Object.freeze(["available", "name", "features", "reason"]);

// ── aria2 配置形状（唯一归一入口，2026-10-18 W2 补测）────────────────
// 形状：{ enabled: false, bin: "", port: 6802 }
// 归一的全部意义：**任何脏输入都不抛异常，且不会把「没配」误读成「开着」**。
export const DEFAULT_ARIA2_PORT = 6802;
export const ARIA2_PORT_MIN = 1;
export const ARIA2_PORT_MAX = 65535;
export const DEFAULT_ARIA2_CONFIG = Object.freeze({ enabled: false, bin: "", port: DEFAULT_ARIA2_PORT });

/** backend 对象必须实现的成员 */
export const REQUIRED_BACKEND_MEMBERS = Object.freeze(["name", "capabilities", "run"]);

/** ctx 必须提供的字段 */
export const REQUIRED_CTX_FIELDS = Object.freeze(["task", "dataDir", "resolveProxy", "friendlyError", "persist"]);

/** backend 返回前必须写好的 task 字段 */
export const REQUIRED_TASK_FIELDS = Object.freeze(["state", "received", "total", "error"]);

/** 可选字段（能算就算；算不出保持 null/原值） */
export const OPTIONAL_TASK_FIELDS = Object.freeze([
  "speed", "stage", "stageDetail", "unit", "etag", "lastModified", "acceptRanges", "finishedAt",
]);

/**
 * 把 engine-config.json 的 aria2 段归一成合法配置。**任何输入都不抛。**
 *
 * 入参是「整份 engine-config 对象」，不是 aria2 段本身——两者容易混，所以只认一种：
 *   normalizeAria2Config(parsedConfigFile) → parsedConfigFile.aria2 被归一
 * 调用方（dlcore._readAria2Config / server 的 /settings）传整份配置即可，避免各自判形状。
 *
 * 容错口径：
 *   · 整份不是对象 / 没有 aria2 段 / 段是 null·数组·字符串 → 默认值（enabled:false）
 *   · enabled：只有布尔 true 算开；"yes"/1/"true" 一律 false（宁可不启用，不可误启用）
 *   · port：接受整数与纯数字字符串，且必须落在 1..65535；其余（0/负数/小数/越界/NaN）→ 6802
 *   · bin：非字符串 → ""（空串 = 自动探测 PATH 里的 aria2c）
 *
 * @param {any} raw 整份 engine-config 对象（可以缺失、可以是垃圾）
 * @returns {{enabled:boolean, bin:string, port:number}} 新对象，不引用入参
 */
export function normalizeAria2Config(raw) {
  const fallback = { enabled: false, bin: "", port: DEFAULT_ARIA2_PORT };
  let a;
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
    a = raw.aria2;
  } catch { return fallback; }
  if (!a || typeof a !== "object" || Array.isArray(a)) return fallback;

  let enabled = false;
  try { enabled = a.enabled === true; } catch { enabled = false; }

  let bin = "";
  try { bin = typeof a.bin === "string" ? a.bin : ""; } catch { bin = ""; }

  let port = DEFAULT_ARIA2_PORT;
  try {
    const n = typeof a.port === "number" ? a.port
      : (typeof a.port === "string" && a.port.trim() !== "" ? Number(a.port.trim()) : NaN);
    if (Number.isInteger(n) && n >= ARIA2_PORT_MIN && n <= ARIA2_PORT_MAX) port = n;
  } catch { port = DEFAULT_ARIA2_PORT; }

  return { enabled, bin, port };
}

/**
 * 校验一个 backend 对象是否满足契约。
 * @param {object} backend
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateBackend(backend) {
  const errors = [];
  if (!backend || typeof backend !== "object") {
    return { ok: false, errors: ["backend 不是对象"] };
  }
  for (const m of REQUIRED_BACKEND_MEMBERS) {
    if (m === "name") {
      if (typeof backend.name !== "string" || !backend.name.trim()) errors.push("缺少 name（非空字符串）");
    } else if (typeof backend[m] !== "function") {
      errors.push(`缺少方法 ${m}()`);
    }
  }
  // capabilities()：同步返回对象或返回 Promise 都可（aria2 需要探测端口，天然异步）
  if (typeof backend.capabilities === "function") {
    let cap;
    try { cap = backend.capabilities(); } catch (e) { errors.push(`capabilities() 抛错：${e?.message || e}`); cap = null; }
    if (cap && typeof cap.then === "function") {
      // Promise 形态：这里只验形状能在 settle 之后成立，不能在 validate 里 await（保持同步契约）
      cap.catch(() => {});
    } else if (cap) {
      errors.push(...validateCapabilities(cap));
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 capabilities() 回包。
 * @param {object} cap
 * @returns {string[]} 错误列表（空 = 合法）
 */
export function validateCapabilities(cap) {
  const errors = [];
  if (!cap || typeof cap !== "object") return ["capabilities() 未返回对象"];
  for (const k of REQUIRED_CAPABILITIES) {
    if (!(k in cap)) errors.push(`capabilities 缺少字段 ${k}`);
  }
  if ("available" in cap && typeof cap.available !== "boolean") errors.push("capabilities.available 必须是布尔");
  if ("features" in cap && !Array.isArray(cap.features)) errors.push("capabilities.features 必须是数组");
  if ("name" in cap && typeof cap.name !== "string") errors.push("capabilities.name 必须是字符串");
  return errors;
}

/**
 * 取 backend 的能力（兼容同步与 Promise 两种 capabilities 实现）。
 * dlcore 选择 backend 时用它，避免为异步探测在调用方各写一遍 then。
 * @param {object} backend
 * @param {...any} args 透传给 capabilities()
 * @returns {Promise<object>}
 */
export async function capabilitiesOf(backend, ...args) {
  if (!backend || typeof backend.capabilities !== "function") {
    return { available: false, name: backend?.name || "?", features: [], reason: "缺少 capabilities()" };
  }
  try {
    const cap = await backend.capabilities(...args);
    const errors = validateCapabilities(cap);
    if (errors.length) return { available: false, name: backend.name, features: [], reason: errors.join("；") };
    return cap;
  } catch (e) {
    return { available: false, name: backend.name, features: [], reason: `capabilities() 失败：${e?.message || e}` };
  }
}

/**
 * 校验 ctx 形状（backend 入口处防御性调用；缺字段直接抛，不要带着残缺 ctx 往下跑）。
 * @param {object} ctx
 */
export function validateContext(ctx) {
  const errors = [];
  if (!ctx || typeof ctx !== "object") throw new Error("backend ctx 缺失");
  for (const f of REQUIRED_CTX_FIELDS) {
    if (f === "persist") {
      if (typeof ctx.persist !== "function") errors.push("ctx.persist 不是函数");
      continue;
    }
    if (f === "task") {
      if (!ctx.task || typeof ctx.task !== "object") errors.push("ctx.task 缺失");
      continue;
    }
    if (f === "dataDir") {
      if (typeof ctx.dataDir !== "string" || !ctx.dataDir) errors.push("ctx.dataDir 缺失");
      continue;
    }
    if (typeof ctx[f] !== "function") errors.push(`ctx.${f} 不是函数`);
  }
  if (errors.length) throw new Error("backend ctx 不合法：" + errors.join("；"));
  return ctx;
}

// ── 公共工具（两个 backend 都要做、且最容易做错的两件事）──

/**
 * 流式计算文件 SHA-256（1MB 分块，不把整文件读进内存）。
 * @param {string} filePath
 * @returns {string} 小写 hex
 */
export function sha256File(filePath) {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
  }
  return hash.digest("hex");
}

/**
 * 交付：把 .part 改名成正式文件。有 expectedSha256 时必须先比对内容，
 * 不一致就**不交付**（保留 .part 供排查/重试），绝不让「下完就算成功」蒙混过去。
 *
 * 这是 aria2 backend 用的收尾函数（2026-10-18）。node-http.js 里是流式累计哈希的等价实现，
 * 刻意没有抽过来共用——那需要改动已稳定的 node-http 逻辑，收益不抵风险。
 *
 * @param {object} task 必须带 partPath / filePath / expectedSha256
 * @returns {{ok:boolean, error?:string, digest?:string, shaMismatch?:boolean}}
 */
export function deliverPartFile(task) {
  const partPath = task?.partPath;
  const filePath = task?.filePath;
  if (!partPath || !filePath) return { ok: false, error: "缺少 partPath/filePath，无法交付" };
  if (!fs.existsSync(partPath)) return { ok: false, error: `半成品文件不存在：${partPath}` };

  const want = task.expectedSha256 ? String(task.expectedSha256).trim().toLowerCase() : "";
  let digest = null;
  if (want) {
    digest = sha256File(partPath);
    if (digest !== want) {
      return {
        ok: false,
        shaMismatch: true,
        digest,
        error: `SHA-256 校验失败：期望 ${want}，实际 ${digest}`,
      };
    }
  }
  try {
    fs.renameSync(partPath, filePath);
  } catch (e) {
    return { ok: false, digest, error: `落盘改名失败：${e?.message || e}` };
  }
  return { ok: true, digest };
}
