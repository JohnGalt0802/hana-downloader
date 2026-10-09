// lib/tasks.js — 下载任务管理器（插件进程内单例）
// 职责：创建/准备下载任务、流式下载 + 进度统计、限速、取消、状态快照、持久化恢复。
// 不依赖任何第三方库，使用 Node 18+ 全局 fetch。

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import { startWingetProbe } from "./download-probe.js";
import { createTunnelAgent } from "./tunnel-agent.js";

const TASKS_FILE = "tasks.json";
const MAX_TASKS = 64;
const DEFAULT_MAX_CONCURRENT = 3; // 同时运行的任务数上限（0=不限）；管理器设置里可改
const SPEED_SAMPLE_MS = 700;   // 测速采样间隔
const SPEED_SAMPLES_MAX = 5;   // 滑动窗口样本数（≈3.5s）
const CHUNK_SLEEP_MIN_MS = 1;  // 限速时 chunk 间最小等待

let _instance = null;
const MGR_VER = 23; // 每次修改管理器逻辑 +1：globalThis 单例按版本换新实例，绕开插件加载器的 lib 模块缓存（v21=加 forget 单条删除；v22=清死代码；v23=并发队列与重试）
// v0.1.7: 下载核心支持断点续传（Range/If-Range/.part 半成品、206/200/416 分支、SHA-256 校验、失败保留 .part、重启恢复 received=statSync(.part).size）
// v0.1.6: 下载核心支持 HTTP CONNECT 代理（环境变量/config.json proxy/Windows 系统代理），
// 代理优先 + 失败自动降级直连；支持 3xx 与文本重定向（"Redirecting to <url>"，如 npmmirror）。

// 真单例：插件加载器按 import 字符串（./lib vs ../lib）缓存模块，可能产生多个模块实例，
// 用 globalThis 兜底保证所有引用方拿到同一个 TaskManager；版本变化时强制重建。
export function getTaskManager(dataDir) {
  const cur = globalThis.__dlTaskMgr;
  if (cur && cur.__ver === MGR_VER) return cur;
  if (_instance && _instance.__ver === MGR_VER) {
    globalThis.__dlTaskMgr = _instance;
    return _instance;
  }
  _instance = new TaskManager(dataDir);
  _instance.__ver = MGR_VER;
  globalThis.__dlTaskMgr = _instance;
  return _instance;
}

/** 主要供测试/重置 */
export function _resetTaskManager() {
  _instance = null;
}

class TaskManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.downloadDir = path.join(dataDir, "downloads");
    this.tasks = new Map();
    this._finalCb = null;
    this._stallCb = null;
    // 运行上限（管理器设置灌入，见 applyConfig）
    this._maxConcurrent = DEFAULT_MAX_CONCURRENT;
    this._defaultSpeedLimit = 0;
  }

  // 注册终态回调（done/failed/canceled）：server.js 用它把终态与停滞落盘到 finished/ 与 stalled/。
  onFinal(cb) { this._finalCb = typeof cb === "function" ? cb : null; }

  _fireFinal(task) {
    if (!task) return;
    const s = task.state;
    if (this._finalCb && (s === "done" || s === "failed" || s === "canceled" || s === "interrupted")) {
      try { this._finalCb(task); } catch { /* 通知失败不影响下载 */ }
    }
    // 终态腾出槽位：放行下一个排队任务（2026-09-20）
    this._pumpQueue();
  }

  // 注册停滞回调：无新数据超过 stallTimeoutMs 时触发一次（进度恢复后可再次触发）。
  // v0.8 支持多监听器：index.js 的 onStall 负责 deferred 占位托管（防丢兜底），
  // dl-nextturn 的 onStall 负责双通道投递（unsettled→steer 同步 / settled→deferred 异步）。
  // 返回退订函数：dev 槽重载/插件卸载时必须退订，否则同一 manager 单例上的
  // 旧回调残留 → 一个 stall 事件被多个 delivery 实例各投一次（双投 bug，见 2026-09-01 实测）。
  onStall(cb) {
    if (typeof cb !== "function") return () => {};
    if (!this._stallCbs) this._stallCbs = [];
    this._stallCbs.push(cb);
    return () => {
      const i = this._stallCbs ? this._stallCbs.indexOf(cb) : -1;
      if (i >= 0) this._stallCbs.splice(i, 1);
    };
  }

  _fireStall(task) {
    if (!task) return;
    const cbs = this._stallCbs || [];
    for (const cb of cbs) {
      try {
        const r = cb(task);
        if (r && typeof r.catch === "function") r.catch(() => {}); // 异步回调异常也不影响下载
      } catch { /* 通知失败不影响下载 */ }
    }
  }

  // ── 创建任务（可能排队，见 applyConfig）──
  create({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind = "url", cmd = null, unit = "bytes", filePath, resumable = true, expectedSha256 = null, stallTaskId = null }) {
    const task = this._createTask({ url, fileName, saveDir, speedLimit: speedLimit || this._defaultSpeedLimit, sessionId, sessionRef, stallTimeoutMs, sessionPath, kind, cmd, unit, filePath, resumable, expectedSha256, stallTaskId });
    this._enqueueOrStart(task);
    return task;
  }

  // ── 运行上限与排队（2026-09-20）──
  // 为什么有队列：maxConcurrent 管的是“同时跑几个”，不是“最多记几条”。
  // 之前 64 只是任务条数上限，同时丢五个大文件下去会互相抢带宽。
  //
  // maxConcurrent：同时处于 running 的任务数上限；0 或非法值 = 不限。
  // speedLimit：任务未显式限速时的默认值（字节/秒）；0 = 不限。
  // 两项由 server.js 在每次发起前从 engine-config.json 灌进来，改设置即时生效。
  applyConfig({ maxConcurrent, speedLimit } = {}) {
    const mc = Number(maxConcurrent);
    this._maxConcurrent = Number.isFinite(mc) && mc > 0 ? Math.floor(mc) : 0;
    const sl = Number(speedLimit);
    this._defaultSpeedLimit = Number.isFinite(sl) && sl > 0 ? sl : 0;
    this._pumpQueue(); // 上限放宽时立刻放行排队中的任务
    return { maxConcurrent: this._maxConcurrent, speedLimit: this._defaultSpeedLimit };
  }

  _runningCount() {
    let n = 0;
    for (const t of this.tasks.values()) if (t.state === "running") n += 1;
    return n;
  }

  // 槽位够就启动，不够就挂成 pending + queued（卡片与管理器显示“排队中”）
  _enqueueOrStart(task) {
    if (this._maxConcurrent > 0 && this._runningCount() >= this._maxConcurrent) {
      task.state = "pending";
      task.queued = true;
      task.queuedAt = Date.now();
      task.startedAt = null;
      task.controller = null;
      this._persist();
      return;
    }
    this._startTask(task);
  }

  _startTask(task) {
    task.queued = false;
    task.queuedAt = null;
    task.state = "running";
    task.startedAt = Date.now();
    task.controller = new AbortController();
    task._lastProgressAt = Date.now();
    this._persist();
    this._run(task); // 后台执行，不等待
  }

  // 队列泵：按排队先后补足槽位。任务终态（_fireFinal）与设置放宽时各调一次。
  _pumpQueue() {
    for (;;) {
      if (this._maxConcurrent > 0 && this._runningCount() >= this._maxConcurrent) return;
      let next = null;
      for (const t of this.tasks.values()) {
        if (t.state !== "pending" || !t.queued) continue;
        if (!next || (t.queuedAt || 0) < (next.queuedAt || 0)) next = t;
      }
      if (!next) return;
      this._startTask(next);
    }
  }

  // ── 重试（管理器按钮，2026-09-20）──
  // 只接终态任务。URL 任务的 .part 与断点信息保留，重跑时按续传处理；命令型重跑原命令。
  // 这是一次全新的运行，所以上一轮的 error / note / 停滞痕迹全部清掉。
  retry(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "任务不存在" };
    if (t.state === "running" || t.state === "pending") return { ok: false, error: "任务仍在进行中" };
    t.error = null;
    t.note = null;
    t.stage = null;
    t.stageDetail = null;
    t.canceledBy = null;
    t.cancelRequested = false;
    t.stalledAt = null;
    t.stallNotified = false;
    t.speed = 0;
    t.elapsed = 0;
    t.finishedAt = null;
    t.startedAt = null;
    t.child = null;
    t.controller = null;
    t._samples = [];
    t._lastPersistAt = 0;
    t._lastProgressAt = Date.now();
    t.state = "pending";
    t.queued = true;
    t.queuedAt = Date.now();
    this._persist();
    this._pumpQueue();
    return { ok: true, taskId: t.taskId, state: t.state, queued: t.queued === true };
  }

  _createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs = 30000, sessionPath = null, kind = "url", cmd = null, unit = "bytes", filePath: explicitPath = null, resumable = true, expectedSha256 = null, stallTaskId = null }) {
    if (this.tasks.size >= MAX_TASKS) {
      // 清理最老的已结束任务
      for (const [id, t] of this.tasks) {
        if (t.state !== "running" && t.state !== "pending") { this.tasks.delete(id); if (this.tasks.size < MAX_TASKS) break; }
      }
      if (this.tasks.size >= MAX_TASKS) throw new Error("下载任务过多，请稍后再试");
    }

    const dir = saveDir || this.downloadDir;
    fs.mkdirSync(dir, { recursive: true });

    const rawName = (fileName && String(fileName).trim()) || fileNameFromUrl(url);
    const name = sanitizeFileName(rawName);
    // 落盘路径：命令型任务（winget/pip）没有磁盘产物，显式路径缺省时保持 null，
    // 不再构造假的“下载目录/名称”路径；URL 与 git/pnpm 的行为不变。
    const filePath = explicitPath ? explicitPath : (kind === "command" ? null : uniquePath(path.join(dir, name)));
    const partPath = filePath ? filePath + ".part" : null;

    const taskId = randomUUID().slice(0, 8) + "-" + Date.now().toString(36);
    const task = {
      taskId,
      url,
      fileName: filePath ? path.basename(filePath) : name,
      filePath,
      saveDir: dir,
      state: "pending", // 中性初值：由 _enqueueOrStart 决定立即开跑还是排队
      queued: false, // 排队中（受 maxConcurrent 限制，尚未开始）；由 _enqueueOrStart 置位
      queuedAt: null,
      total: null,
      received: 0,
      speed: 0,
      startedAt: null, // 由 _startTask 填
      finishedAt: null,
      elapsed: 0,
      error: null,
      cancelRequested: false,
      sessionId: sessionId || null,
      sessionRef: sessionRef || null,
      speedLimit: Number.isFinite(speedLimit) && speedLimit > 0 ? speedLimit : 0,
      controller: null, // 由 _startTask 建
      pendingTimer: null,
      _samples: [],
      stalledAt: null,
      stallNotified: false,
      _lastProgressAt: Date.now(),
      stallTimeoutMs: Number.isFinite(stallTimeoutMs) && stallTimeoutMs > 0 ? stallTimeoutMs : 30000,
      sessionPath: sessionPath || null,
      // 卡滞提醒用的甴主任务 id（app 侧创建、随任务存下，卡滞时由 app 结算它）
      stallTaskId: stallTaskId || null,
      kind,
      cmd,
      unit,
      stage: null,
      note: null,
      child: null,
      partPath,
      etag: null,
      lastModified: null,
      acceptRanges: false,
      expectedSha256: expectedSha256 || null,
      resumable: kind === "command" ? false : (resumable !== false),
      _lastPersistAt: 0,
    };
    this.tasks.set(taskId, task);
    this._persist();
    return task;
  }

  // ── 停滞监视 ──
  // 检查间隔必须是阈值的分数，不能等于阈值：
  // 原来写成 setInterval(fn, stallTimeoutMs)，第一次 tick 时差值是
  // “阈值 − 首包到达耗时”，永远差那么一点点，于是要等第二次 tick——
  // 实测 30s 阈值实际 60s 才报卡滞（2026-09-20 第三方七象限测试的“停滞很久”就是它）。
  _startStallMonitor(task) {
    // 人为限速（speedLimit>0）的任务不报停滞：throttle 主动 pause 流的间歇不是网络异常，
    // 误判会在低速率下必性触发假 stall 通知（v0.13.1，9-08 实测 250B/s 任务 1s 即报）。
    if (task.speedLimit > 0) return;
    // 「第一时间」要求：判定延迟最多一秒（取 1/4 阈值与 1 秒的较小者，下限 500ms）。
    // 卡滞是「要 agent 决策」的事件，晚一分钟通知等于没通知。
    const interval = Math.max(500, Math.min(1000, Math.floor((task.stallTimeoutMs || 30000) / 4)));
    task._stallTimer = setInterval(() => {
      try {
        if (task.state !== "running") return;
        if (Date.now() - task._lastProgressAt >= task.stallTimeoutMs) {
          if (task.stalledAt == null) {
            task.stalledAt = Date.now();
            this._persist(); // 停滞触发即刷盘，避免排查时只能靠内存态
          }
          if (!task.stallNotified) {
            task.stallNotified = true;
            this._fireStall(task);
          }
        } else if (task.stalledAt != null) {
          // 进度恢复：解除停滞，允许再次停滞再通知
          task.stalledAt = null;
          task.stallNotified = false;
        }
      } catch { /* 停滞判定异常不影响下载 */ }
    }, interval);
    if (task._stallTimer?.unref) task._stallTimer.unref();
  }

  _stopStallMonitor(task) {
    if (task._stallTimer) { clearInterval(task._stallTimer); task._stallTimer = null; }
  }

  async _run(task) {
    if (task.kind === "command") { await this._runCommand(task); return; }

    let ws = null;
    let wroteAnyChunk = false;
    const hash = task.expectedSha256 ? createHash("sha256") : null;
    this._startStallMonitor(task);
    const controller = task.controller;
    let req = null;
    // 取消：destroy 底层请求（触发 error → catch 按 canceled 处理）
    const abortListener = () => { try { if (req) req.destroy(new AbortError("canceled by user")); } catch { /* 忽略 */ } };
    controller.signal.addEventListener("abort", abortListener);
    try {
      const targetUrl = new URL(task.url);
      // 本地回环目标永不走代理：回环流量经代理隧道既慢又不稳定（实测被中途掐断）
      const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(targetUrl.hostname)
        || /^127\./.test(targetUrl.hostname);
      const proxy = isLoopback ? "" : resolveProxy(this.dataDir, task.url);
      const mod = targetUrl.protocol === "https:" ? https : http;

      // 请求 + 重定向（3xx 与文本重定向，如 npmmirror 的 "Redirecting to ..."）
      // 代理策略：优先走代理，若代理失败（网络错/HTTP 4xx/5xx）自动降级直连重试一次
      let target = task.url;
      let res = null;
      let preBuffer = null; // 文本重定向检测时缓冲的小 body（非重定向时写回流）
      let lastReqErr = null;
      let startOffset = 0; // 断点续传起始偏移（每轮请求按 received 重新计算）
      const proxyAttempts = proxy ? [proxy, null] : [null];
      for (let pi = 0; pi < proxyAttempts.length && !res; pi++) {
        const useProxy = proxyAttempts[pi];
        const useAgent = useProxy ? createTunnelAgent(useProxy) : undefined;
        let current = target;
        let redirects = 0;
        try {
          while (redirects < 5) {
            startOffset = (task.resumable !== false ? (task.received || 0) : 0);
            const headers = {
              "User-Agent": "HanaAgent/1.0 (hana-downloader)",
              "Accept": "*/*",
              "Accept-Encoding": "identity", // 防 CDN 压缩导致字节偏移错位
              "Range": startOffset > 0 ? `bytes=${startOffset}-` : undefined,
              "If-Range": (task.etag || task.lastModified) || undefined,
            };
            if (headers["Range"] === undefined) delete headers["Range"];
            if (headers["If-Range"] === undefined) delete headers["If-Range"];
            res = await new Promise((resolve, reject) => {
              const r = mod.request(current, {
                agent: useAgent,
                headers,
              }, (resp) => resolve(resp));
              req = r;
              r.on("error", reject);
              r.end();
            });
            const sc = res.statusCode || 0;
            // 标准 3xx 重定向
            if ((sc === 301 || sc === 302 || sc === 303 || sc === 307 || sc === 308) && res.headers.location) {
              res.resume();
              current = new URL(res.headers.location, current).toString();
              redirects++;
              continue;
            }
            // 416：服务器不支持 Range（或 If-Range 校验失败），删 .part 后从头下载
            if (sc === 416 && startOffset > 0) {
              res.resume();
              try { if (fs.existsSync(task.partPath)) fs.unlinkSync(task.partPath); } catch { /* 忽略清理失败 */ }
              task.received = 0;
              continue;
            }
            // 4xx/5xx：代理路径下视为可能被风控，降级直连重试；直连路径直接失败
            if (sc >= 400) {
              res.resume();
              if (useProxy) { res = null; break; }
              throw new Error(`HTTP ${sc} ${res.statusMessage || ""}`);
            }
            // 文本重定向（如 npmmirror 返回 200 + "Redirecting to <url>"）
            const small = await readSmallBody(res);
            if (small) {
              const text = small.toString("utf8");
              const m = /^Redirecting to\s+(\S+)/.exec(text.trim());
              if (m) {
                current = new URL(m[1], current).toString();
                redirects++;
                continue;
              }
              preBuffer = small; // 真小文件：缓冲数据留待写回流
            }
            break; // 正常响应
          }
          if (!res) continue; // 降级直连
        } catch (e) {
          lastReqErr = e;
          res = null;
          // 代理失败降级直连；直连也失败则保留最后错误
        }
      }
      if (!res) throw (lastReqErr || new Error("HTTP 请求失败"));

      if (!res.statusCode || res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode} ${res.statusMessage || ""}`);

      // 记录响应元数据（供断点续传 If-Range 与重启恢复）
      task.etag = res.headers["etag"] || null;
      task.lastModified = res.headers["last-modified"] || null;
      task.acceptRanges = (res.headers["accept-ranges"] || "none") !== "none";

      // 响应分支：206 续传 / 200 从头（416 已在请求循环内处理）
      if (res.statusCode === 206) {
        const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)/.exec(res.headers["content-range"] || "");
        if (!m) throw new Error("HTTP 206 响应缺少有效的 Content-Range 头");
        const crStart = Number(m[1]);
        if (crStart !== startOffset) throw new Error(`断点续传偏移不符：服务器返回 ${crStart}，期望 ${startOffset}`);
        const crTotal = m[3] === "*" ? null : Number(m[3]);
        if (crTotal != null && Number.isFinite(crTotal) && crTotal > 0) {
          task.total = crTotal;
        } else {
          // Content-Range 无总长度：用剩余长度 + 起始偏移还原全量大小
          const cl = parseInt(res.headers["content-length"] || "", 10);
          task.total = Number.isFinite(cl) && cl > 0 ? cl + startOffset : null;
        }
        ws = fs.createWriteStream(task.partPath, { start: startOffset });
      } else {
        // 200：Range 被忽略（或新任务无 Range），从头下载
        if (!fs.existsSync(task.partPath)) fs.writeFileSync(task.partPath, Buffer.alloc(0));
        fs.truncateSync(task.partPath, 0);
        startOffset = 0;
        task.received = 0;
        const cl = parseInt(res.headers["content-length"] || "", 10);
        task.total = Number.isFinite(cl) && cl > 0 ? cl : null;
        ws = fs.createWriteStream(task.partPath, { flags: "w" });
      }

      // 流式接收 + 进度采样 + 限速（与旧 fetch 版逻辑一致）
      await new Promise((resolve, reject) => {
        let lastTick = Date.now();
        let lastBytes = 0;
        let chunkStart = Date.now();
        const speedSample = () => {
          const now = Date.now();
          if (now - lastTick >= SPEED_SAMPLE_MS) {
            const inst = (task.received - lastBytes) / ((now - lastTick) / 1000);
            task._samples.push(inst);
            if (task._samples.length > SPEED_SAMPLES_MAX) task._samples.shift();
            task.speed = task._samples.reduce((a, b) => a + b, 0) / task._samples.length;
            lastTick = now;
            lastBytes = task.received;
          }
        };
        const processChunk = (chunk) => {
          if (task.cancelRequested) { try { if (req) req.destroy(); } catch { /* 忽略 */ } return; }
          wroteAnyChunk = true;
          ws.write(chunk);
          task.received += chunk.length;
          if (hash) hash.update(chunk); // SHA-256 流式累计
          task._lastProgressAt = Date.now();
          if (task.stalledAt != null) {
            task.stalledAt = null;
            task.stallNotified = false;
          }
          // 已知总大小且已收满：提前收尾（与服务端关闭边界一致）
          if (task.total != null && task.received >= task.total) {
            try { if (req) req.destroy(); } catch { /* 忽略 */ }
            return;
          }
          // 进度节流落盘：每 1.5s 持久化一次 received（作为断点续传恢复点）
          if (Date.now() - (task._lastPersistAt || 0) >= 1500) {
            task._lastPersistAt = Date.now();
            this._persist();
          }
          // 限速：暂停流 + 定时恢复
          if (task.speedLimit > 0) {
            const want = (chunk.length / task.speedLimit) * 1000;
            const used = Date.now() - chunkStart;
            if (want > used) {
              res.pause();
              setTimeout(() => { chunkStart = Date.now(); res.resume(); }, want - used + CHUNK_SLEEP_MIN_MS);
            } else { chunkStart = Date.now(); }
          }
          speedSample();
        };
        if (preBuffer && preBuffer.length) processChunk(preBuffer);
        if (preBuffer) {
          // 小文件已由 readSmallBody 完整缓冲（读到 end），直接收尾
          ws.end((err) => (err ? reject(err) : resolve()));
        } else {
          res.on("data", processChunk);
          res.on("end", () => {
            ws.end((err) => (err ? reject(err) : resolve()));
          });
          res.on("error", reject);
          req.on("error", reject);
        }
      });

      // 流正常结束即下载完整：总大小未知（chunked 无 Content-Length）或声明值与实际不符
      // （如 Content-Encoding 自动解压时 received 为解压后字节）时，以实际接收为准兜底。
      // received < total 不拉低（若服务器提前断开会走 error/abort 分支）。
      if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;

      // 终态收尾：SHA-256 校验（若配置 expectedSha256）→ 通过后将 .part 改名为正式文件
      if (task.expectedSha256 && hash) {
        const digest = hash.digest("hex");
        if (digest !== task.expectedSha256) {
          task.state = "failed";
          task.error = `SHA-256 校验失败：期望 ${task.expectedSha256}，实际 ${digest}`;
        } else {
          fs.renameSync(task.partPath, task.filePath);
          task.state = "done";
        }
      } else {
        fs.renameSync(task.partPath, task.filePath);
        task.state = "done";
      }
      task.finishedAt = Date.now();
    } catch (e) {
      const aborted = task.cancelRequested || e?.name === "AbortError" || controller.signal.aborted;
      // 注意：chunked（total=null）半途断连时 complete 恒为 false，会走下方删除分支——
      // body 无长度声明无法验证完整性，failed + 删半成品是保守正确。勿放宽此判定为
      // (total==null || received>=total)：会把残缺文件误判为完成保下来，比删文件更糟。
      // 续传场景 received 从旧偏移起步，额外要求本次写过 chunk，否则请求阶段失败会误判 complete。
      const complete = !aborted && wroteAnyChunk && task.total != null && task.received >= task.total && task.received > 0;
      if (complete) {
        try {
          if (ws) await new Promise((res, rej) => ws.end((err) => (err ? rej(err) : res())));
        } catch { /* 落盘失败则按失败处理 */ }
        // 收满路径同样做 SHA-256 校验：不匹配则不得交付
        if (task.expectedSha256 && hash) {
          const digest = hash.digest("hex");
          if (digest !== task.expectedSha256) {
            task.state = "failed";
            task.error = `SHA-256 校验失败：期望 ${task.expectedSha256}，实际 ${digest}`;
            task.finishedAt = Date.now();
            return; // 已标终态，交给 finally 收尾
          }
        }
        if (fs.existsSync(task.partPath)) {
          try {
            fs.renameSync(task.partPath, task.filePath);
            task.state = "done";
            task.error = null;
          } catch (re) {
            task.state = "failed";
            task.error = friendlyError(e) + "；落盘改名失败：" + friendlyError(re);
          }
        } else {
          task.state = "failed";
          task.error = friendlyError(e);
        }
      } else {
        if (ws) { try { ws.destroy(); } catch { /* 忽略 */ } }
        if (aborted) {
          // canceled：保留 .part 半成品（可续传）
          task.state = "canceled";
          task.error = "已取消";
        } else if (!wroteAnyChunk) {
          // failed 且未写过任何 chunk：仅删空 .part（避免空文件）；非空 .part 保留供续传
          try {
            const st = fs.statSync(task.partPath);
            if (st && st.size === 0) fs.unlinkSync(task.partPath);
          } catch { /* .part 不存在或不可读：跳过清理 */ }
          task.state = "failed";
          task.error = friendlyError(e);
        } else {
          // failed 且写过 chunk：保留 .part，状态置 interrupted（可续传）
          task.state = "interrupted";
          task.error = friendlyError(e);
        }
      }
      task.finishedAt = Date.now();
    } finally {
      try { controller.signal.removeEventListener("abort", abortListener); } catch { /* 忽略 */ }
      this._stopStallMonitor(task);
      task.elapsed = (task.finishedAt || Date.now()) - (task.startedAt || Date.now());
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    }
  }

  // ── 命令型任务（git-clone / pnpm-install / winget-install / pip-install）──
  // 各链路的差异收在 COMMAND_SPECS 里（build / makeParser / classifyExit），这里只跑框架。
  async _runCommand(task) {
    const pp = await import("./progress-parsers.js");
    const spec = COMMAND_SPECS[task?.cmd?.type] || null;
    if (!spec) {
      task.state = "failed";
      task.error = `未知的命令类型：${task?.cmd?.type || "?"}`;
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      this._persist();
      this._fireFinal(task);
      return;
    }
    const parser = spec.makeParser(pp, task.cmd);
    const classifyExit = spec.classifyExit ? spec.classifyExit(pp) : null;

    // 二进制与参数由链路自己的 build 构造；构造失败（如解释器不存在）按启动失败收口
    let resolved;
    try {
      resolved = spec.build(task.cmd);
    } catch (err) {
      task.state = "failed";
      task.error = "命令无法启动：" + (err?.message || String(err));
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      this._persist();
      this._fireFinal(task);
      return;
    }
    const cmdBin = resolved.bin;
    const fullArgs = resolved.args;

    this._startStallMonitor(task);
    task._cmdBuf = ""; // 输出缓冲（截断 4KB 供错误摘要）

    // pnpm 读 HTTP_PROXY/HTTPS_PROXY，但不跟随 Windows 系统代理（2026-09-19 实测：
    // 系统代理开着、env 为空时它走直连并卡死；直连即使通也不稳——并发拉包常报 error(23)，
    // 单请求实测能拖到 70s+，经代理则是秒级）。
    // 其余链路各自有代理通道（winget 跟随系统代理但不读 env；curl/pip/uv/git 读 env 由自身处理；
    // URL 下载走自建隧道），这里只补 pnpm 这一格。
    const childEnv = { ...process.env };
    if (task.cmd?.type === "pnpm-install") {
      const proxy = resolveProxy(this.dataDir);
      if (proxy) {
        childEnv.HTTP_PROXY = proxy; childEnv.HTTPS_PROXY = proxy;
        childEnv.http_proxy = proxy; childEnv.https_proxy = proxy;
      } else {
        // proxy:false（显式直连）时子进程也不该继承代理：清掉可能存在的继承值
        delete childEnv.HTTP_PROXY; delete childEnv.HTTPS_PROXY;
        delete childEnv.http_proxy; delete childEnv.https_proxy;
      }
      // 白名单（config.json 的 noProxy / NO_PROXY）也要带给子进程，否则 pnpm 仍会把它们走代理
      const no = ["localhost", "127.0.0.1", "::1", ...noProxyList(this.dataDir)].join(",");
      childEnv.NO_PROXY = no; childEnv.no_proxy = no;
    }
    let child;
    try {
      child = spawn(cmdBin, fullArgs, {
        cwd: task.cmd.workdir || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // 非 Windows：子进程自成进程组（detached），取消时用 process.kill(-pid) 一次带走整棵树，
        // 等价于 Windows 的 taskkill /T /F（git/pnpm 会再 fork 子进程）。
        detached: process.platform !== "win32",
        env: childEnv,
      });
    } catch (err) {
      this._stopStallMonitor(task);
      task.state = "failed";
      task.error = "命令无法启动：" + (err?.message || String(err));
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
      return;
    }
    task.child = child;

    // winget 下载进度旁路探测（2026-09-18）：CLI 不给下载进度，改为观测它的落盘文件；
    // 失败静默，不影响任务本身。pip / git / pnpm 不走此路。
    let stopProbe = null;
    if (task.cmd?.type === "winget-install") {
      try { stopProbe = startWingetProbe(task, this.dataDir, resolveProxy(this.dataDir)); } catch { /* 探测失败不影响任务 */ }
    }

    const feed = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      task._lastProgressAt = Date.now(); // 喂停滞监视器
      task._cmdBuf = appendBuf(task._cmdBuf, text); // 缓冲截断
      const lines = text.split(/[\r\n]+/); // \r 重绘（git/pnpm 进度刷新）也拆成独立行，parser 每行拿最新值
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const r = parser(line);
        if (!r) continue;
        // 派生信息（pkgName / currentFile / upgrading 等）浅合并进任务；核心字段受保护
        if (r.meta && typeof r.meta === "object") {
          for (const [k, v] of Object.entries(r.meta)) {
            if (v == null || META_PROTECTED.has(k)) continue;
            task[k] = v;
          }
        }
        // 备注（如“PATH 已更新，重启 shell 后生效”）：去重累积，供卡片与结算文案使用
        if (r.note) {
          if (!task.note) task.note = r.note;
          else if (!task.note.includes(r.note)) task.note += `；${r.note}`;
        }
        // 字段各自独立更新（2026-09-19）：进度解析器可能只给真实计数、不给百分比
        // （pnpm 的总包数不可知），旧写法要求 pct/unit 同时存在，会把这种真实计数丢掉。
        if (r.stage) task.stage = r.stage;
        if (r.unit) task.unit = r.unit;
        if (r.detail) task.stageDetail = r.detail;
        if (r.received != null) task.received = r.received;
        if (r.total != null) task.total = r.total;
        // 只给百分比、不给计数的历史路径：按已知 total 反推 received
        if (r.pct != null && r.received == null && task.total) {
          task.received = Math.round(task.total * r.pct / 100);
        }
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);

    child.on("error", (e) => { task._spawnError = e; });

    child.on("close", (code) => {
      if (stopProbe) { try { stopProbe(); } catch { /* 忽略 */ } }
      this._stopStallMonitor(task);
      const aborted = task.cancelRequested;
      if (aborted) {
        task.state = "canceled";
        task.error = "已取消";
        // git clone 半成品目录删；node_modules 半成品保留
        if (task.cmd.type === "git-clone" && task.filePath && fs.existsSync(task.filePath)) {
          try { fs.rmSync(task.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
        }
      } else if (code === 0) {
        task.state = "done";
        // 完成对齐：进度探测可能在最后一块上落后（外部读到的写盘量滞后于实际），完成即全量。
        // URL 下载本就相等，无副作用。
        // 计数型（objects / packages / files）不做对齐：那不是字节量，反推 total 等于编数据（2026-09-19）。
        const countUnit = !!task.unit && task.unit !== "bytes";
        if (!countUnit) {
          if (task.total != null && task.received != null && task.received < task.total) task.received = task.total;
          if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;
        }
      } else {
        // 非零退出码先交给链路的分类器（winget 的 HRESULT 码表）：
        // 分类器可把特定非零码判为 done（如“已安装、无可用更新”）或 canceled。
        const cls = typeof classifyExit === "function" ? classifyExit(code) : null;
        if (cls && cls.state === "done") {
          task.state = "done";
          if (cls.note) {
            if (!task.note) task.note = cls.note;
            else if (!task.note.includes(cls.note)) task.note += `；${cls.note}`;
          }
          if (!(!!task.unit && task.unit !== "bytes")) {
            if (task.total != null && task.received != null && task.received < task.total) task.received = task.total;
            if (task.received > 0 && (task.total == null || task.received > task.total)) task.total = task.received;
          }
        } else if (cls && cls.state === "canceled") {
          task.state = "canceled";
          task.error = cls.error || "已取消";
        } else {
          task.state = "failed";
          const tail = task._cmdBuf ? task._cmdBuf.slice(-4000) : "";
          // HRESULT 风格的大码（winget）附十六进制，方便对照码表排查
          const codeU = Number(code) >>> 0;
          const hexSuffix = codeU >= 0x80000000 ? `（0x${codeU.toString(16).toUpperCase()}）` : "";
          const clsMsg = cls && cls.error ? cls.error + "；" : "";
          task.error = (task._spawnError ? task._spawnError.message + "；" : "") + clsMsg
            + `命令退出码 ${code}` + hexSuffix + (tail ? `：${summarizeCmdTail(tail)}` : "");
        }
      }
      // 完成备注：把“已安装 <包>”放在最前（winget 成功路径的输出没有成句结果行；
      // pip/uv 的结果行自带 note，已安装等场景 cls.note 已填）
      if (task.state === "done") {
        const c = task.cmd || {};
        const nm = task.pkgName || c.pkgName;
        if (nm && (c.type === "winget-install" || c.type === "pip-install")) {
          const vr = task.pkgVersion || c.pkgVersion;
          const head = `已安装 ${nm}${vr ? ` ${vr}` : ""}`;
          if (!task.note) task.note = head;
          else if (!task.note.includes(head)) task.note = `${head}；${task.note}`;
        }
      }
      task.finishedAt = Date.now();
      task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    });
  }

  // ── 取消 ──
  // source: "user"=用户在卡片上手动取消 | "agent"=Agent 调工具取消（默认）| "system"=系统自动
  cancel(taskId, source = "agent") {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "任务不存在" };
    if (t.state === "pending") {
      if (t.pendingTimer) clearTimeout(t.pendingTimer);
      t.queued = false;
      t.state = "canceled";
      t.canceledBy = source;
      t.error = "已取消";
      t.finishedAt = Date.now();
      this._persist();
      this._fireFinal(t);
      return { ok: true };
    }
    if (t.state !== "running") return { ok: false, error: "任务已结束" };
    t.canceledBy = source;
    t.cancelRequested = true;
    if (t.kind === "command" && t.child && t.child.pid) {
      // Windows 杀进程树；非 Windows 信号
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/pid", String(t.child.pid), "/T", "/F"], { windowsHide: true });
        } catch { try { t.child.kill(); } catch { /* 忽略 */ } }
      } else {
        // 非 Windows：子进程自成进程组（spawn 时 detached），负 pid 杀整组。
        // SIGTERM 先礼后兵，5s 不退再 SIGKILL（git/pnpm 偶尔忽略 SIGTERM）。
        const pid = t.child.pid;
        try { process.kill(-pid, "SIGTERM"); } catch { try { t.child.kill(); } catch { /* 忽略 */ } }
        const hardKill = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* 已退出 */ } }, 5000);
        if (typeof hardKill.unref === "function") hardKill.unref();
      }
      return { ok: true };
    }
    t.controller?.abort();
    return { ok: true };
  }

  // ── 状态快照（供 route 返回给卡片）──
  snapshot(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    const percent = t.total ? Math.min(100, (t.received / t.total) * 100) : null;
    return {
      taskId: t.taskId,
      url: t.url,
      fileName: t.fileName,
      filePath: t.filePath,
      state: t.state,
      queued: t.queued === true,
      canceledBy: t.canceledBy || null,
      stalled: t.stalledAt != null,
      stalledAt: t.stalledAt,
      total: t.total,
      received: t.received,
      speed: Math.round(t.speed),
      percent: percent == null ? null : Math.round(percent * 10) / 10,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      elapsed: t.elapsed,
      error: t.error,
      kind: t.kind || "url",
      cmd: t.cmd || null,
      cmdType: t.cmd?.type || null,
      unit: t.unit || "bytes",
      stage: t.stage || null,
      stageDetail: t.stageDetail || null,
      note: t.note || null,
      sessionId: t.sessionId || null,
      sessionPath: t.sessionPath || null,
      saveDir: t.saveDir || null,
      speedLimit: t.speedLimit || 0,
    };
  }

  // ── 全部任务快照（跨会话下载管理器用）：在途优先，终态按结束时间倒序 ──
  list() {
    const all = [...this.tasks.values()];
    const active = all.filter((t) => t.state === "running" || t.state === "pending");
    const final = all.filter((t) => t.state !== "running" && t.state !== "pending")
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
    const ordered = [...active, ...final];
    return ordered.map((t) => this.snapshot(t.taskId)).filter(Boolean);
  }

  // ── 清空分类记录（v0.8.9：仅移除任务记录，不删磁盘文件）──
  // states: 要清空的任务状态集合。只动终态记录；在途（running/pending）不被清空，防幽灵下载。
  // 返回移除的任务 id 列表（供前端刷新计数/日志）。
  clearByStates(states) {
    const set = states && Array.isArray(states) ? new Set(states) : null;
    if (!set || set.size === 0) return { ok: true, removed: [] };
    const removed = [];
    for (const [id, t] of this.tasks) {
      if (t.state === "running" || t.state === "pending") continue; // 在途不动
      if (set.has(t.state)) {
        this.tasks.delete(id);
        removed.push(id);
      }
    }
    this._persist();
    return { ok: true, removed };
  }

  // ── 删除单条记录（v0.90.3：管理器行内菜单「删除记录 / 删除记录及文件」）──
  // opts.deleteFile = true 时连同磁盘产物一起删：
  //   - url 任务删 filePath 与残留的 .part
  //   - git-clone 任务删 targetDir（本次克隆出来的目录树）
  //   - pnpm-install 任务不删任何东西（filePath 就是用户的工作目录，误删不可逆）
  // 在途任务（running/pending）拒绝删除，必须先取消。
  forget(taskId, opts = {}) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: "任务不存在" };
    if (t.state === "running" || t.state === "pending") {
      return { ok: false, error: "任务仍在进行中，请先取消再删除" };
    }
    const wantFile = !!opts.deleteFile;
    let fileDeleted = false;
    let fileSkipped = null;
    let fileError = null;
    if (wantFile) {
      if (t.kind === "command") {
        const dir = t.cmd && t.cmd.targetDir ? t.cmd.targetDir : null;
        if (t.cmd && t.cmd.type === "git-clone" && dir) {
          try {
            if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); fileDeleted = true; }
          } catch (e) { fileError = String(e?.message || e); }
        } else {
          fileSkipped = "该任务没有可删除的磁盘产物（命令型任务只删除记录）";
        }
      } else {
        const targets = [t.filePath, t.partPath || (t.filePath ? t.filePath + ".part" : null)].filter(Boolean);
        for (const p of targets) {
          try {
            if (fs.existsSync(p)) { fs.unlinkSync(p); if (p === t.filePath) fileDeleted = true; }
          } catch (e) { fileError = String(e?.message || e); }
        }
        if (!fileDeleted && !fileError) fileSkipped = "磁盘上没有找到对应的文件";
      }
    }
    this.tasks.delete(taskId);
    this._persist();
    return { ok: true, taskId, fileDeleted, fileSkipped, fileError };
  }

  // ── 全部取消在途（v0.8.9：管理器“全部取消”按钮）──
  // 取消所有 running/pending，归入 canceled。返回取消的任务 id 列表。
  cancelAll(source = "user") {
    const ids = [];
    for (const [id, t] of this.tasks) {
      if (t.state === "running" || t.state === "pending") {
        try { this.cancel(id, source); } catch (e) { /* 单个失败不阻塞 */ }
        ids.push(id);
      }
    }
    return { ok: true, canceled: ids };
  }

  // ── 重启恢复：running → interrupted、pending → interrupted（定时器丢失），删除半成品 ──
  restore() {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.dataDir, TASKS_FILE), "utf-8"));
    } catch { return; }
    if (!meta || !Array.isArray(meta.tasks)) return;
    const now = Date.now();
    for (const m of meta.tasks) {
      const t = this.tasks.get(m.taskId);
      if (t) continue; // 内存中已有（create/prepare 后立即持久化过）
      if (m.state === "running" || m.state === "pending") {
        const isCmd = m.kind === "command" && m.cmd?.type;
        if (isCmd) {
          // 命令型：git-clone 中断删半成品目录；pnpm-install 保留 node_modules 半成品
          if (m.cmd.type === "git-clone" && m.filePath && fs.existsSync(m.filePath)) {
            try { fs.rmSync(m.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
          }
        } else {
          try { if (m.filePath && fs.existsSync(m.filePath)) fs.unlinkSync(m.filePath); } catch { }
        }
        // URL 任务：保留 .part 半成品（不再删除），received 取 .part 实际大小作为续传恢复点
        const partPath = m.partPath || (m.filePath ? m.filePath + ".part" : null);
        let received = m.received || 0;
        if (!isCmd && partPath && fs.existsSync(partPath)) {
          try { received = fs.statSync(partPath).size; } catch { /* statSync 失败则保留 m.received */ }
        }
        this.tasks.set(m.taskId, {
          taskId: m.taskId, url: m.url || "", fileName: m.fileName || "",
          filePath: m.filePath || "", saveDir: m.saveDir || this.downloadDir,
          state: "interrupted", total: m.total || null, received,
          speed: 0, startedAt: m.startedAt || now, finishedAt: now, elapsed: 0,
          error: isCmd ? "命令被中断（应用重启），请重新执行" : "下载被中断（应用重启），请重新发起下载",
          cancelRequested: false, speedLimit: m.speedLimit || 0,
          sessionId: m.sessionId || null, sessionPath: m.sessionPath || null, sessionRef: null, controller: null, pendingTimer: null, _samples: [],
          stalledAt: m.stalledAt || null, stallNotified: false, _lastProgressAt: now,
          kind: m.kind || "url", cmd: m.cmd || null, unit: m.unit || "bytes", child: null, stage: null, note: m.note || null,
          partPath: partPath || "",
          etag: m.etag || null,
          lastModified: m.lastModified || null,
          acceptRanges: m.acceptRanges === true,
          expectedSha256: m.expectedSha256 || null,
          resumable: isCmd ? false : (m.resumable !== false),
        });
      } else {
        // 已完成/失败/取消的旧任务：仅保留 1 天内，用于卡片回放
        const age = now - (m.finishedAt || m.startedAt || 0);
        if (age < 24 * 3600 * 1000) {
          // 历史 done 任务若 total 缺失（chunked 下载时代遗留数据）：用 received 兜底，回放卡片进度/大小正确
          const hisTotal = (m.state === "done" && m.total == null && m.received > 0) ? m.received : (m.total || null);
          this.tasks.set(m.taskId, {
            taskId: m.taskId, url: m.url || "", fileName: m.fileName || "",
            filePath: m.filePath || "", saveDir: m.saveDir || this.downloadDir,
            state: m.state || "interrupted", total: hisTotal, received: m.received || 0,
            speed: 0, startedAt: m.startedAt || now, finishedAt: m.finishedAt || now,
            elapsed: m.elapsed || 0, error: m.error || null, cancelRequested: false, speedLimit: m.speedLimit || 0,
            sessionId: m.sessionId || null, sessionPath: m.sessionPath || null, sessionRef: null, controller: null, pendingTimer: null, _samples: [],
            stalledAt: m.stalledAt || null, stallNotified: false, _lastProgressAt: now,
            kind: m.kind || "url", cmd: m.cmd || null, unit: m.unit || "bytes", child: null, stage: null, note: m.note || null,
            partPath: m.partPath || (m.filePath ? m.filePath + ".part" : null),
            etag: m.etag || null,
            lastModified: m.lastModified || null,
            acceptRanges: m.acceptRanges === true,
            expectedSha256: m.expectedSha256 || null,
            resumable: m.kind === "command" ? false : (m.resumable !== false),
          });
        }
      }
    }
  }

  // ── 持久化（仅状态转换时调用，进度不落盘；终态任务只保留最近 100 条，防文件无限膨胀）──
  _persist() {
    try {
      const KEEP_FINAL = 100;
      const finalList = [];
      for (const t of this.tasks.values()) {
        if (t.state === "running" || t.state === "pending") continue;
        finalList.push(t);
      }
      // 终态按结束时间倒序，保留最近 KEEP_FINAL 条；超出部分从内存删除（防无限增长）
      finalList.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
      const overflow = finalList.slice(KEEP_FINAL);
      for (const t of overflow) this.tasks.delete(t.taskId);

      const meta = {
        version: 3,
        updatedAt: Date.now(),
        tasks: [...this.tasks.values()].map((t) => ({
          taskId: t.taskId, url: t.url, fileName: t.fileName, filePath: t.filePath,
          saveDir: t.saveDir, state: t.state, total: t.total, received: t.received,
          speedLimit: t.speedLimit || 0,
          startedAt: t.startedAt, finishedAt: t.finishedAt, elapsed: t.elapsed,
          error: t.error,
          canceledBy: t.canceledBy || null,
          kind: t.kind || "url",
          cmd: t.cmd || null,
          unit: t.unit || "bytes",
          note: t.note || null,
          stalledAt: t.stalledAt || null,
          sessionId: t.sessionId || null,
          sessionPath: t.sessionPath || null,
          etag: t.etag || null,
          lastModified: t.lastModified || null,
          partPath: t.partPath || null,
          acceptRanges: t.acceptRanges === true,
          expectedSha256: t.expectedSha256 || null,
          resumable: t.resumable !== false,
        })),
      };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, TASKS_FILE), JSON.stringify(meta), "utf-8");
    } catch { /* 持久化失败不阻塞下载 */ }
  }
}

// ── 辅助函数 ──

// 命令输出缓冲：追加文本并截断到 4KB，供失败时错误摘要（最后几行）
function appendBuf(buf, text) {
  const next = buf + text;
  if (next.length <= 4096) return next;
  return next.slice(-4096);
}

// ── 命令链路规格表（winget/pip 链路 2026-09-18 新增）──
// 每条链路独立配置三点：build（二进制与参数构造，可抛错）、makeParser（输出解析器工厂）、
// classifyExit（非零退出码的终态判定，可选）。执行框架（spawn / 进度喂入 / 停滞监视 /
// 取消 / 终态 / 卡片 / 结算）在 _runCommand 中共用，链路之间不互相复制代码。
const COMMAND_SPECS = {
  "git-clone": {
    // git 是真实 exe，直接 spawn，数组传参
    build: (cmd) => ({ bin: "git", args: ["clone", "--progress", ...(cmd.args || [])] }),
    makeParser: (pp) => pp.parseGitLine,
    classifyExit: null,
  },
  "pnpm-install": {
    // npm 全局装的 pnpm 是 .cmd shim，shell:false 的 spawn 执行不了（EINVAL）；
    // 解析真实 JS 入口（pnpm/bin/pnpm.mjs|cjs）用当前 node 运行，保持无 shell、无注入面
    build: () => {
      const entry = findPnpmEntry();
      if (entry) return { bin: process.execPath, args: [entry, "install"] };
      // 退化：直接跑 PATH / 常见目录里的 pnpm（mac 上 Homebrew 的 pnpm 是可执行脚本）
      return { bin: whichBin("pnpm") || "pnpm", args: ["install"] };
    },
    makeParser: (pp) => pp.createPnpmParser(),
    classifyExit: null,
  },
  "winget-install": {
    build: (cmd) => ({ bin: resolveWingetBin(), args: buildWingetArgs(cmd) }),
    makeParser: (pp) => pp.createWingetParser(),
    classifyExit: (pp) => pp.classifyWingetExit,
  },
  "brew-install": {
    // macOS 原生（Windows 上 winget 的对应物）。brew 是带 shebang 的脚本，
    // 解析出绝对路径后直接 spawn 即可（不依赖精简 PATH）。
    build: (cmd) => ({ bin: resolveBrewBin(), args: buildBrewArgs(cmd) }),
    makeParser: (pp) => pp.createBrewParser(),
    classifyExit: null, // brew 退出码没有稳定码表，走通用失败分支
  },
  "pip-install": {
    build: (cmd) => buildPipCommand(cmd),
    makeParser: (pp, cmd) => (cmd.runner === "uv" ? pp.createUvParser() : pp.createPipParser()),
    classifyExit: null,
  },
};

// 解析器 meta 浅合并时的保护键：输出行不允许覆盖任务核心字段
const META_PROTECTED = new Set([
  "taskId", "url", "fileName", "filePath", "saveDir", "state", "controller", "child",
  "pendingTimer", "sessionId", "sessionPath", "kind", "cmd", "cancelRequested", "partPath",
]);

const IS_WIN = process.platform === "win32";

// 通用可执行定位：先问 PATH（win: where.exe / 其它: which），再扫常见安装目录。
// 受管进程的 PATH 往往是精简的（不含 shell rc 里的 ~/.local/bin、Homebrew 等），
// 所以兜底目录清单对 macOS 尤其重要。
export function whichBin(name, extraDirs = []) {
  const names = Array.isArray(name) ? name : [name];
  try {
    const finder = IS_WIN ? "where.exe" : "which";
    const r = spawnSync(finder, names, { encoding: "utf-8", windowsHide: true });
    // 不看退出码：`which a b` 有一个命中就打印一个，但仍可能返回非 0。
    for (const line of String(r.stdout || "").split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch { /* 走兜底 */ }
  const dirs = [
    ...extraDirs,
    ...String(process.env.PATH || "").split(path.delimiter),
    "/opt/homebrew/bin", "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "bin"),
    "/usr/bin", "/bin",
  ].filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return "";
}

// winget 可执行解析：which/where 优先，其次 WindowsApps 别名兜底（受管进程 PATH 不含用户别名时）。
export function resolveWingetBin() {
  const found = whichBin("winget");
  if (found) return found;
  const guess = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "winget.exe");
  if (fs.existsSync(guess)) return guess;
  return "winget"; // 退化：依赖 PATH
}

// Homebrew 可执行解析（macOS；Windows 上 winget 的对应物）。
export function resolveBrewBin() {
  return whichBin("brew", ["/opt/homebrew/bin", "/usr/local/bin"]) || "brew";
}

// winget install 参数（数组传参，无 shell）。--disable-interactivity 禁用交互提示，
// --accept-* 免首次协议阻塞；-e 精确 ID（ID 由 /command 的 search 阶段确定后传入）。
function buildWingetArgs(cmd) {
  const args = [
    "install", "--id", String(cmd.pkgId || cmd.pkg || ""), "-e",
    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
  ];
  if (cmd.scope === "user" || cmd.scope === "machine") args.push("--scope", cmd.scope);
  if (cmd.source) args.push("--source", String(cmd.source));
  return args;
}

// brew install 参数（数组传参，无 shell）。
function buildBrewArgs(cmd) {
  const args = ["install"];
  if (cmd.cask) args.push("--cask");
  args.push(String(cmd.pkg || ""));
  return args;
}

// 系统代理（只读）：Windows 读注册表，macOS 读 `scutil --proxy`。
// 返回 { enabled, server }；读不到一律当没有代理。
export function readSystemProxyInfo() {
  try {
    if (process.platform === "win32") {
      const en = spawnSync("reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
        { encoding: "utf8", windowsHide: true, timeout: 5000 });
      const me = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(en.stdout || "");
      const sv = spawnSync("reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
        { encoding: "utf8", windowsHide: true, timeout: 5000 });
      const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(sv.stdout || "");
      return { enabled: me ? parseInt(me[1], 16) === 1 : false, server: m ? m[1].trim() : "" };
    }
    if (process.platform === "darwin") {
      const out = spawnSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 5000 });
      const txt = String(out.stdout || "");
      const pick = (proto) => {
        const on = new RegExp(`${proto}Enable\\s*:\\s*1`).test(txt);
        const host = (new RegExp(`${proto}Proxy\\s*:\\s*(\\S+)`).exec(txt) || [])[1] || "";
        const port = (new RegExp(`${proto}Port\\s*:\\s*(\\d+)`).exec(txt) || [])[1] || "";
        return on && host ? `http://${host}${port ? ":" + port : ""}` : "";
      };
      const server = pick("HTTPS") || pick("HTTP") || "";
      return { enabled: !!server, server };
    }
  } catch { /* 读不到就算没有 */ }
  return { enabled: false, server: "" };
}

// Python 解释器解析：显式 pythonPath 优先（不存在则抛），否则找 python3/python。
function resolvePythonBin(pythonPath) {
  if (pythonPath) {
    const p = path.resolve(String(pythonPath));
    if (!fs.existsSync(p)) throw new Error(`指定的 Python 解释器不存在：${p}`);
    return p;
  }
  // mac 上系统解释器叫 python3（python 可能不存在），故 mac 优先 python3。
  return whichBin(IS_WIN ? ["python", "python3"] : ["python3", "python"]) || (IS_WIN ? "python" : "python3");
}

// uv 可执行解析：PATH 优先，其次 ~/.local/bin（官方安装器默认位置）。
function resolveUvBin() {
  return whichBin("uv", [path.join(os.homedir(), ".local", "bin")]) || "uv";
}

// pip 安装命令构造（数组传参，无 shell）：
//   python 路线：<python> -m pip install --no-input [--upgrade] <pkg>
//   uv 路线：    uv pip install --python <解释器> | --system [--upgrade] <pkg>
// pkg 以 - 开头会被目标程序当选项，提前拒绝（server 入口亦有一道校验）。
function buildPipCommand(cmd) {
  const pkg = String(cmd.pkg || "").trim();
  if (!pkg) throw new Error("缺少包名（pkg）");
  if (pkg.startsWith("-")) throw new Error(`包名不合法：${pkg}`);
  if (cmd.runner === "uv") {
    const args = ["pip", "install"];
    if (cmd.pythonPath) {
      const py = path.resolve(String(cmd.pythonPath));
      if (!fs.existsSync(py)) throw new Error(`指定的 Python 解释器不存在：${py}`);
      args.push("--python", py);
    } else {
      args.push("--system");
    }
    if (cmd.upgrade) args.push("--upgrade");
    args.push(pkg);
    return { bin: resolveUvBin(), args };
  }
  const py = resolvePythonBin(cmd.pythonPath);
  const args = ["-m", "pip", "install", "--no-input"];
  if (cmd.upgrade) args.push("--upgrade");
  args.push(pkg);
  return { bin: py, args };
}

function findPnpmEntry() {
  // 1) where pnpm → .cmd shim → 读内容找 node_modules/pnpm/bin/pnpm.mjs|cjs
  try {
    const r = spawnSync("where.exe", ["pnpm"], { encoding: "utf-8", windowsHide: true });
    if (r.status === 0) {
      for (const line of String(r.stdout || "").split(/\r?\n/)) {
        const p = line.trim();
        if (!p || !/\.cmd$/i.test(p)) continue;
        const content = fs.readFileSync(p, "utf-8");
        const m = content.match(/node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.(?:mjs|cjs)/);
        if (m) {
          const entry = path.resolve(path.dirname(p), m[0].replace(/\//g, path.sep));
          if (fs.existsSync(entry)) return entry;
        }
      }
    }
  } catch { /* 继续探测 */ }
  // 2) npm root -g 直拼标准结构
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", windowsHide: true });
    if (r.status === 0) {
      const root = String(r.stdout || "").trim();
      for (const f of ["pnpm/bin/pnpm.mjs", "pnpm/bin/pnpm.cjs"]) {
        const entry = path.join(root, f);
        if (fs.existsSync(entry)) return entry;
      }
    }
  } catch { /* 返回 null 走退化 */ }
  return null;
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (name) return name;
  } catch { /* fallthrough */ }
  return "download_" + Date.now();
}

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "download_" + Date.now();
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const dir = path.dirname(p);
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

function friendlyError(e) {
  const msg = e?.message || String(e || "");
  const low = msg.toLowerCase();
  const cause = e?.cause;
  const causeCode = cause && cause.code ? `（${cause.code}）` : "";
  if (low.includes("terminated")) return "连接被中断（terminated）";
  if (low.includes("fetch failed") || low.includes("socket hang up") || low.includes("econnreset")) {
    return "网络请求失败" + causeCode;
  }
  if (low.includes("aborted")) return "请求被中止";
  if (low.includes("content-length") || low.includes("length")) return "响应异常（长度不符）";
  return msg + causeCode;
}

// ── 命令失败摘要（2026-09-19）──
// 优先取带错误码的那一行：pnpm 的 [ERR_PNPM_FETCH_404]、git 的 fatal: 等，
// 它通常比“最后三行”更有信息量。实测样例（装不存在的包）：真正的原因在第一行，
// 而最后两行只有 “No authorization header was set for the request.”，对用户等于没说。
function summarizeCmdTail(tail) {
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errLine = lines.find((l) => /ERR_[A-Z0-9_]+|^fatal:/i.test(l)) || "";
  if (errLine) {
    const hint = cmdErrorHint(tail);
    return hint ? `${errLine}（${hint}）` : errLine;
  }
  return lines.slice(-3).join("\n");
}

// 只对能确定语义的错误码给一句人话，不做过度翻译（2026-09-19）
function cmdErrorHint(tail) {
  if (/ERR_PNPM_FETCH_404/.test(tail)) return "包或版本不存在，检查包名";
  if (/ERR_PNPM_NO_MATCHING_VERSION/.test(tail)) return "该版本不存在";
  if (/ERR_PNPM_(META_)?FETCH|ERR_PNPM_TARBALL/.test(tail)) return "源不可达，检查网络与代理";
  if (/ERR_PNPM_PEER_DEP_ISSUES/.test(tail)) return "peer 依赖冲突";
  if (/fatal: repository .* not found|fatal: could not read from remote/i.test(tail)) return "仓库不存在或无权访问";
  return "";
}

// ── 代理支持（无第三方依赖）──
// 解析顺序（2026-09-23 起，2026-09-24 增加模式与自动路由）：
//   ① 模式 never / config.json 的 proxy === false   → 直连（不再看系统代理）
//   ② 强制直连命中（directHosts / noProxy / NO_PROXY）→ 直连
//   ③ 模式 always / config.json 的 proxy 为字符串    → 使用代理
//   ④ 强制代理命中（proxyHosts）                    → 使用代理
//   ⑤ 内置域名规则（国内源直连、国外源代理）
//   ⑥ 未知域名 → 直连探测一次（HEAD，默认 3s）并缓存结果
// 代理地址来源：config.proxy.url → config.proxy(字符串) → 环境变量 → Windows 注册表（**只读**）
//
// 只读纪律（2026-09-24）：App 只**读取**环境，不修改任何系统级设置——不写系统代理、
// 不启停代理进程、不改防火墙、不申请管理员权限。在别人的机器上尤其如此。
//
// 修订动机（实测）：国内镜像（hf-mirror 等）直连 26MB/s、经代理 0.75MB/s，相差 30 倍；
// 此前只能靠人工把域名填进白名单，否则系统代理一开就被推着走。
function readUserConfig(dataDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8") || "{}");
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch { return {}; } // 无配置 / 解析失败 → 空配置（保持旧行为）
}

// 白名单条目匹配：精确域名、子域（example.com 也命中 a.example.com）、“*.example.com” 写法、IP，
// 以及 “*”（全部直连）。带端口条目（host:port）按 host 比较。
export function hostMatchesNoProxy(host, entry) {
  const h = String(host || "").trim().toLowerCase();
  const raw = String(entry || "").trim().toLowerCase();
  if (!h || !raw) return false;
  if (raw === "*") return true;
  const e = raw.replace(/^\*\./, "").replace(/^\./, "").replace(/:\d+$/, "");
  if (!e) return false;
  return h === e || h.endsWith("." + e);
}

// 白名单来源：config.json 的 noProxy（数组或逗号串）+ 环境变量 NO_PROXY / no_proxy
export function noProxyList(dataDir) {
  const cfg = readUserConfig(dataDir);
  const list = [];
  const push = (v) => {
    for (const x of String(v == null ? "" : v).split(",")) {
      const t = x.trim();
      if (t) list.push(t);
    }
  };
  if (Array.isArray(cfg.noProxy)) push(cfg.noProxy.join(","));
  else if (typeof cfg.noProxy === "string") push(cfg.noProxy);
  if (process.env.NO_PROXY) push(process.env.NO_PROXY);
  if (process.env.no_proxy) push(process.env.no_proxy);
  return list;
}

// 内置规则：国内源 / 镜像默认直连。走代理反而慢（实测 hf-mirror 直连 26MB/s、经代理 0.75MB/s）。
// 规则保持克制：宁可少列，交给 ⑥ 的探测兜底，以免误伤新的国外源。
export const CN_DIRECT = [
  "*.cn",
  "hf-mirror.com",
  "mirrors.tuna.tsinghua.edu.cn",
  "mirrors.aliyun.com",
  "mirrors.cloud.tencent.com",
  "mirrors.ustc.edu.cn",
  "mirrors.huaweicloud.com",
  "repo.huaweicloud.com",
  "registry.npmmirror.com",
  "registry.npm.taobao.org",
  "gitee.com",
  "*.aliyuncs.com",
  "*.myqcloud.com",
  "*.qiniu.com",
  "*.bcebos.com",
];

// 内置规则：国外源默认走代理。同样保持克制，只列“直连大概率不通”的。
export const FOREIGN_PROXY = [
  "github.com",
  "githubusercontent.com",
  "huggingface.co",
  "pypi.org",
  "pythonhosted.org",
  "npmjs.org",
  "npmjs.com",
  "crates.io",
  "nodejs.org",
  "golang.org",
  "proxy.golang.org",
  "download.pytorch.org",
  "developer.download.nvidia.com",
  "docker.com",
  "docker.io",
];

// 兼容三种写法：
//   proxy: false                      → never（显式直连）
//   proxy: "http://127.0.0.1:7890"     → always + 指定地址
//   proxy: { mode, url, directHosts, proxyHosts, probeTimeoutMs } → 新结构
export function readProxyConfig(dataDir) {
  const cfg = readUserConfig(dataDir);
  const p = cfg.proxy;
  const out = { mode: "auto", url: "", directHosts: [], proxyHosts: [], probeTimeoutMs: 3000 };
  if (p === false) { out.mode = "never"; return out; }
  if (typeof p === "string" && p.trim()) { out.mode = "always"; out.url = p.trim(); return out; }
  if (p && typeof p === "object") {
    if (["auto", "always", "never"].includes(p.mode)) out.mode = p.mode;
    if (typeof p.url === "string") out.url = p.url.trim();
    if (Array.isArray(p.directHosts)) out.directHosts = p.directHosts.filter(Boolean).map(String);
    if (Array.isArray(p.proxyHosts)) out.proxyHosts = p.proxyHosts.filter(Boolean).map(String);
    if (Number.isFinite(p.probeTimeoutMs) && p.probeTimeoutMs > 0) out.probeTimeoutMs = Math.min(p.probeTimeoutMs, 10000);
  }
  return out;
}

// 代理地址来源（按优先级）：显式参数 → config.proxy.url/字符串 → 环境变量 → Windows 注册表（只读）
export function resolveProxyUrl(dataDir, explicit = "") {
  if (explicit) return explicit;
  const p = readUserConfig(dataDir).proxy;
  if (typeof p === "string" && p.trim()) return p.trim();
  if (p && typeof p === "object" && typeof p.url === "string" && p.url.trim()) return p.url.trim();
  const envP = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (envP) return envP;
  try {
    const out = spawnSync(
      "reg",
      ["query", 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', "/v", "ProxyServer"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 }
    );
    const m = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(out.stdout || "");
    if (m && m[1].trim()) {
      const v = m[1].trim();
      if (v.startsWith("http://") || v.startsWith("https://")) return v;
      return "http://" + v;
    }
  } catch { /* 读不到就算没有 */ }
  return "";
}

// 直连探测：只在「未知域名 + auto 模式」时发生，结果按域名缓存在进程内存里。
// 用 curl 发一个 HEAD；退出码 0 视为直连可用。**只读探测，不修改环境。**
const probeCache = new Map();
export function probeDirect(host, timeoutMs = 3000) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  if (probeCache.has(h)) return probeCache.get(h);
  let ok = false;
  try {
    const sec = String(Math.max(1, Math.round(timeoutMs / 1000)));
    const r = spawnSync(
      "curl",
      ["-sI", "--max-time", sec, "-o", process.platform === "win32" ? "NUL" : "/dev/null", `https://${h}/`],
      { windowsHide: true, timeout: timeoutMs + 2000 }
    );
    ok = !!(r && r.status === 0);
  } catch { ok = false; }
  probeCache.set(h, ok);
  return ok;
}

export function resolveProxy(dataDir, targetUrl = "") {
  const rc = readProxyConfig(dataDir);
  if (rc.mode === "never") return "";                 // ① 显式直连
  const url = resolveProxyUrl(dataDir, rc.url);
  if (!url) return "";                                 // 没有可用代理地址 → 只能直连

  let host = "";
  if (targetUrl) { try { host = new URL(targetUrl).hostname.toLowerCase(); } catch { host = ""; } }
  if (!host) return url;                               // 不知道目标 → 保守走代理

  // ② 强制直连
  if (rc.directHosts.some((e) => hostMatchesNoProxy(host, e))) return "";
  if (noProxyList(dataDir).some((e) => hostMatchesNoProxy(host, e))) return "";
  if (rc.mode === "always") return url;               // ③
  // ④ 强制代理
  if (rc.proxyHosts.some((e) => hostMatchesNoProxy(host, e))) return url;
  // ⑤ 内置规则（国外先判，避免被 "*.cn" 之类误伤）
  if (FOREIGN_PROXY.some((e) => hostMatchesNoProxy(host, e))) return url;
  if (CN_DIRECT.some((e) => hostMatchesNoProxy(host, e))) return "";
  // ⑥ 未知域名 → 直连探测一次
  return probeDirect(host, rc.probeTimeoutMs) ? "" : url;
}

// 小响应缓冲：Content-Length < 4KB 时读完整 body，用于检测文本重定向
// （npmmirror 等返回 200 + "Redirecting to <url>" 的非标准重定向）。
// 非重定向时返回 Buffer（由调用方写回流），重定向/异常返回 null 由上层处理。
function readSmallBody(res) {
  const cl = parseInt(res.headers["content-length"] || "", 10);
  if (!(Number.isFinite(cl) && cl >= 0 && cl < 4096)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onErr);
      resolve(v);
    };
    const onData = (c) => {
      chunks.push(c);
      const total = chunks.reduce((a, b) => a + b.length, 0);
      if (total > 8192) finish(null);
    };
    const onEnd = () => finish(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0));
    const onErr = () => finish(null);
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onErr);
    setTimeout(() => finish(null), 3000);
  });
}

// 手写 HTTP CONNECT 隧道 Agent 已抽到 ./tunnel-agent.js（URL 下载与 winget 探测共用）
// 原实现（https.Agent + createConnection 手写 CONNECT）见该文件。

class AbortError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "AbortError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
