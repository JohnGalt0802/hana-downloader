// lib/tasks.js — 下载任务管理器（插件进程内单例）
// 职责：创建/准备下载任务、流式下载 + 进度统计、限速、取消、状态快照、持久化恢复。
// 不依赖任何第三方库，使用 Node 18+ 全局 fetch。

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startWingetProbe } from "./download-probe.js";
import { nodeHttpBackend } from "./backends/node-http.js";
import { platform } from "./platform/index.mjs";
import { aria2Backend, recordedInstanceAlive } from "./backends/aria2.js";
import { capabilitiesOf, normalizeAria2Config } from "./backends/contract.js";
// 摘要口径全仓唯一一份（snapshot 与 /list、finished/、stalled/ 共用，见 engine/summary.js）
import { percentOf, summarizeTask } from "./summary.js";
// 终态记录的原子写（2026-10-19）：finished/*.json 不能出现半截，见 atomic-write.js
import { writeJsonAtomic, finishedPathOf } from "./atomic-write.js";

const TASKS_FILE = "tasks.json";
// restore 时的孤儿终态回收阈值（见 _pruneOrphanFinished）：
// 正常路径是等待方「读走即删」，最长等待方 settleWhenDone 是 30 分钟（900×2s），
// 超过 1 小时还没人读的终态文件就是没人等了。
const RESTORE_FINISHED_MAX_AGE_MS = 60 * 60 * 1000;
// 任务记录持久化（2026-10-12 John 定）：不再按条数自动裁剪，见 _createTask / _persist / restore。
const DEFAULT_MAX_CONCURRENT = 3; // 同时运行的任务数上限（0=不限）；管理器设置里可改

let _instance = null;
const MGR_VER = 32; // 每次修改管理器逻辑 +1（v32=命令型任务 spawn 的 'error' 按「启动失败」结算 + 结算幂等 _settled + retry 复位）：globalThis 单例按版本换新实例，绕开插件加载器的 lib 模块缓存（v21=加 forget 单条删除；v22=清死代码；v23=并发队列与重试；v24=percent 口径收口到 summary.percentOf；v25=接入 aria2 backend + task.backend；v26=restore 为 running/pending 补写 interrupted 终态 + 回收孤儿 finished；v27=retry 以磁盘校正 received（取消后重试不再永久失败）；v28=终态记录改原子写（临时文件+fsync+rename，不再出现半截 JSON）；v29=.part 归属后端（partOwner）+ 换后端丢弃旧半成品，修「切后端续传交付带洞文件却报 done」；v30=restore 区分「aria2 实例还活着」与「实例已没」，前者恢复运行态继续跟踪，不再误报下载失败；v31=平台适配层收编：spawnOpts/killTree 成对、命令型子进程落盘 pid、restore 收孤儿命令；v32=命令型任务 spawn 的 'error' 区分启动失败与运行中报错（'spawn' 事件为界）、结算幂等 _settled、retry 复位闸门）
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
    // 从 aria2 活实例接回来的任务保留原起始时间（elapsed 才是真实下载时长，不是「重启后跑了多久」）
    task.startedAt = task._resumedStartedAt || Date.now();
    delete task._resumedStartedAt;
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
    // 重试起点以磁盘为准，不能沿用内存里的 received。必须在清 backend/aria2Gid 之前算：
    // 那两个字段参与「这条是不是 aria2 任务」的判定（aria2 的 .part 大小不是进度）。
    // .part 不存在 → 0（fallback 0）：没有半成品就不要拿内存值当初点。
    t.received = receivedOnDisk(t, 0);
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
    t._settled = false; // 上一轮的结算闸门必须复位，否则重试后终态永远不成立
    t._spawnError = null; // 同理：上一轮的 spawn 错误不能拼进这一轮的失败文案
    t._samples = [];
    t._lastPersistAt = 0;
    t._lastProgressAt = Date.now();
    t.state = "pending";
    t.queued = true;
    t.queuedAt = Date.now();
    // 升级前创建的旧任务没有 partOwner：用持久化的 backend 回填归属（aria2 任务必然写过 backend；
    // 更早的时代只有 node-http，partOwnershipConflict 的缺省归属正是 node-http）。
    // 必须在清 backend 之前做——清完就没有任何线索了。
    if (!t.partOwner && t.backend) t.partOwner = t.backend;
    // backend 先清空：重试会重新选路，保留上一轮的结论会误导（“这次用的 aria2”其实是上次）
    t.backend = null;
    t.backendNote = null;
    t.aria2Gid = null;
    t.aria2Status = null;
    this._persist();
    this._pumpQueue();
    return { ok: true, taskId: t.taskId, state: t.state, queued: t.queued === true };
  }

  _createTask({ url, fileName, saveDir, speedLimit, sessionId, sessionRef, stallTimeoutMs = 30000, sessionPath = null, kind = "url", cmd = null, unit = "bytes", filePath: explicitPath = null, resumable = true, expectedSha256 = null, stallTaskId = null }) {
    // 2026-10-12 John 定：任务记录是持久资产，不因数量自动清理——只有用户主动「清空记录 / 删除记录」
    // 才移除。原先这里在超过 MAX_TASKS 时会删掉最老的终态记录，等于把用户在管理器里看到的历史悄悄抹掉。
    // 并发由 _maxConcurrent + 队列（_pumpQueue）治理，与记录条数无关，故不再设总量上限。

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
      _settled: false, // 命令型任务的结算闸门（error 与 close 只能结算一次）
      partPath,
      etag: null,
      lastModified: null,
      acceptRanges: false,
      expectedSha256: expectedSha256 || null,
      resumable: kind === "command" ? false : (resumable !== false),
      // 实际使用的传输 backend（"node-http" / "aria2"，由 _selectBackend 写）；
      // backendNote 记「降级/不可用」这类要看得见的原因，不隐藏失败。
      backend: null,
      backendNote: null,
      // .part 的归属后端（"node-http" / "aria2"）：由真正开始写 .part 的 backend 设置。
      // 为什么必须记：两种 backend 对 .part 的语义不同——node-http 当它是「从 0 开始的连续前缀」，
      // aria2 当它是「多段稀疏写，st_size 只是最远分片写到的偏移」。换后端接着写就是交付带洞文件
      // 却报 done（2026-10-19 实测：9.8% 取消后重试，洞占 75.84%，状态 done）。
      partOwner: null,
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

    // 边界（2026-10-18 重构）：传输归 backend，生命周期归 dlcore。
    // backend 只负责把字节弄到磁盘并写 task.state/received/total/error 等字段；
    // 停滞监视、elapsed、刷盘、终态回调都在这里包一层 try/finally。
    // 恢复路径（_forceBackend）：这条任务已被确认还在某个活着的 aria2 实例里，
    // 必须继续由 aria2 跟到底——不能重走选路（用户此刻把开关关了就会切到 node-http，
    // 而 _alignPartOwner 会把实例正在写的 .part 删掉）。
    const forced = task._forceBackend || null;
    if (forced) delete task._forceBackend;
    const backend = forced || await this._selectBackend(task);
    // 选路后、动手前：这次选中的 backend 与 .part 的归属不一致，就必须丢弃旧半成品（从头下）。
    // 放在这里而不是 retry()：选路只在这里发生（retry 只把任务排进队列）。
    this._alignPartOwner(task, backend.name);
    this._startStallMonitor(task);
    try {
      await backend.run({
        task,
        dataDir: this.dataDir,
        resolveProxy,
        friendlyError,
        persist: () => this._persist(),
      });
    } catch (e) {
      // aria2 起不来 / 半路失联属于「基础设施不可用」，不是「这个文件下不下来」。
      // 只在**一点数据都还没写、而且从没拿到 gid** 的时候降级回 node-http：
      //   · 没写字节 → 换 backend 不会产生第二份半成品，也不会把 aria2 的预分配文件当进度
      //   · 没拿到 gid → RPC 不可达时那个 aria2 进程已经没了，不存在「它在后台偷偷下载而这边也写」的双写风险
      // 已经传了一部分就如实报错——绝不悄悄换 backend 再报成功（那正是「state=done 文件却不对」的老坑）。
      if (e?.code === "ARIA2_UNAVAILABLE" && backend !== nodeHttpBackend
          && !task.aria2Gid && (task.received || 0) === 0 && task.state !== "done") {
        task.backend = nodeHttpBackend.name;
        task.backendNote = `aria2 不可用，已降级 node-http：${e.message}`;
        // 降级同样是「换后端」：如果 .part 是 aria2 写的，同样不能拿它当连续前缀续写。
        this._alignPartOwner(task, nodeHttpBackend.name);
        task.error = null;
        task.state = "running";
        task.aria2Gid = null;
        task.aria2Status = null;
        task.stage = null;
        await nodeHttpBackend.run({
          task,
          dataDir: this.dataDir,
          resolveProxy,
          friendlyError,
          persist: () => this._persist(),
        });
      } else {
        // backend 抛错 = 「没完成」。绝不能带着 running 静默结束（_run 是后台调用，
        // 这里若直接 rethrow 会变成不是任何人接的 unhandledRejection，任务永远挂 running）。
        const aborted = task.cancelRequested === true || task.controller?.signal?.aborted;
        if (task.state !== "done" && task.state !== "canceled") {
          task.state = aborted ? "canceled" : "interrupted";
          task.error = aborted ? (task.error || "已取消") : (task.error || `${backend.name} 传输异常：${friendlyError(e)}`);
          task.finishedAt = Date.now();
        }
      }
    } finally {
      this._stopStallMonitor(task);
      task.elapsed = (task.finishedAt || Date.now()) - (task.startedAt || Date.now());
      task.speed = 0;
      this._persist();
      this._fireFinal(task);
    }
  }

  // ── backend 选择（2026-10-18，W2）──
  // 规则：命令型永不进来（_run 顶部已分流）；URL 任务在「配置开启 + aria2 真的可用」时走 aria2，
  // 其余一律 node-http。**engine-config.json 没有 aria2 段 → 关闭 → 行为与改造前完全一致。**
  // 选中的名字写进 task.backend，供 UI/摘要显示（诊断「这条到底走的哪条路」）。
  async _selectBackend(task) {
    if (task.kind === "command") {
      task.backend = nodeHttpBackend.name;
      return nodeHttpBackend;
    }
    // 选择本身绝不允许把任务搞死：任何异常都是「不知道 aria2 行不行」，那就走久经考验的 node-http。
    try {
      const cfg = this._readAria2Config();
      aria2Backend.setOptions({ bin: cfg.bin, port: cfg.port });
      if (!cfg.enabled) {
        task.backend = nodeHttpBackend.name;
        return nodeHttpBackend;
      }
      const cap = await capabilitiesOf(aria2Backend, { dataDir: this.dataDir });
      if (!cap.available) {
        task.backend = nodeHttpBackend.name;
        task.backendNote = `aria2 不可用（${cap.reason || "未知原因"}），已用 node-http`;
        return nodeHttpBackend;
      }
      task.backend = aria2Backend.name;
      task.backendNote = null;
      return aria2Backend;
    } catch (e) {
      task.backend = nodeHttpBackend.name;
      task.backendNote = `backend 选择失败（${e?.message || e}），已用 node-http`;
      return nodeHttpBackend;
    }
  }

  // ── .part 归属与本次选中的 backend 对齐（2026-10-19）──
  // 两种 backend 对 .part 的语义互不兼容，绝不能拿同一份半成品接力：
  //   · node-http：把它当「从 0 开始的连续前缀」，Range 起点 = 文件大小
  //   · aria2：把它当「多段稀疏写」，st_size 只是最远分片写到的偏移
  //     （file-allocation=none 时一上来就是全长，实测 9.8% 进度时 .part 已 78.8%）
  // 换后端接着写 = 把洞当成已下载的字节交付出去，状态还报 done（实测：洞占 75.84%、SHA 不符、绿勾）。
  // 洞检测行不通（真实内容的零字节与空洞无法区分），唯一可靠的依据是「这个 .part 是谁写的」。
  // 所以：归属与本次 backend 不一致 → 丢掉半成品与控制文件、received 归零、从头下。
  // 进度归零是看得见的，比绿勾配坏文件好得多。
  // 归属一致 → 一律保持现状（续传行为不变）。
  //
  // 归属推断（partOwner 为空时）：
  //   · .part.aria2 存在 → aria2（那份控制文件本身就是 aria2 写的铁证，多段稀疏必然带它）
  //   · 否则 → node-http（升级前的任务只可能是 node-http，那时还没有 aria2 backend）
  // 这样既不丢老任务的续传能力，又不会把 aria2 的稀疏文件当连续前缀。
  _alignPartOwner(task, backendName) {
    if (!task || task.kind === "command" || !task.partPath || !backendName) return false;
    const ctlPath = task.partPath + ".aria2";
    let size = 0;
    let ctlExists = false;
    try { size = fs.existsSync(task.partPath) ? fs.statSync(task.partPath).size : 0; } catch { size = 0; }
    try { ctlExists = fs.existsSync(ctlPath); } catch { ctlExists = false; }
    // 没有半成品也没有控制文件：干净开局，归属跟着本次 backend 走
    if (size <= 0 && !ctlExists) {
      task.partOwner = backendName;
      return false;
    }
    const owner = task.partOwner || (ctlExists ? "aria2" : "node-http");
    if (owner === backendName) {
      task.partOwner = backendName; // 归属一致（含推断值落定）：续传行为保持现状
      return false;
    }
    try { fs.rmSync(task.partPath, { force: true }); } catch { /* 忽略清理失败 */ }
    try { fs.rmSync(ctlPath, { force: true }); } catch { /* 忽略清理失败 */ }
    task.partOwner = backendName;
    task.received = 0;
    const why = owner
      ? `后端已切换（${owner} → ${backendName}），旧半成品不可续用，重新下载`
      : `半成品归属不明，重新下载`;
    task.backendNote = task.backendNote ? `${task.backendNote}；${why}` : why;
    return true;
  }

  // engine-config.json 的 aria2 段（只读；开关由 W3 的管理器设置负责写）。
  // 读盘按 mtime 缓存：每次下载都读一遍 JSON 太浪费，但改配置又必须立即生效。
  // 归一逻辑只有一份：engine/backends/contract.js 的 normalizeAria2Config（server 侧共用）。
  _readAria2Config() {
    const file = path.join(this.dataDir, "engine-config.json");
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    const c = this._aria2CfgCache;
    if (c && c.mtime === mtime && c.file === file) return c.value;
    let value = normalizeAria2Config(null);
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf-8") || "{}");
      value = normalizeAria2Config(cfg);
    } catch { /* 无配置文件/解析失败 → 默认关闭（保持旧行为） */ }
    this._aria2CfgCache = { file, mtime, value };
    return value;
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
    let stopProbe = null; // winget 落盘探测的停止句柄（仅 winget-install 会赋值）
    try {
      // ★ spawnOpts 与 platform.killTree 是一对，改这里之前先读 platform 层的注释与
      //   方案 §3.3 原则一。posix 下必须 detached:true，否则 killTree 的 kill(-pid) 没有
      //   「进程组」可杀（只能杀到自己，孙进程变孤儿）。旧写法正是在这里漏了 detached。
      child = spawn(cmdBin, fullArgs, platform.spawnOpts({
        cwd: task.cmd.workdir || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      }));
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

    // 结算闸门：同一任务只准结算一次。spawn 失败时 'error' 与 'close' **都会来**
    //（win32 实测：先 error(ENOENT) 再 close(-4058)；posix 同理，退出码是 -ENOENT），
    // 两处都写终态就会发两次终态、两次 finished/*.json。
    const settle = (fn) => {
      if (task._settled) return;
      task._settled = true;
      fn();
    };

    // spawn 返回 child 不等于进程起来了：ENOENT（bin 不在 PATH、cwd 不存在）是**异步**
    // emit 'error'，下面那个 try/catch 只挡同步异常（参数类型错之类）。
    // 「起来了没有」只有 'spawn' 事件能回答：**它没发才是启动失败**。
    // 不能一律把 'error' 当启动失败：Node 的 'error' 还会在 kill 失败 / IPC 发消息失败时
    // 发出，那时进程早就跑起来了，报「无法启动」会把人往 PATH 上引，实际该看退出码与输出。
    let childSpawned = false;
    child.on("spawn", () => { childSpawned = true; });
    child.on("error", (e) => {
      task._spawnError = e; // 保留：close 分支的文案里仍会引用（运行中报错就走那条）
      if (childSpawned) return; // 起来了：交给 close 按退出码收口，不抢结算
      settle(() => {
        if (stopProbe) { try { stopProbe(); } catch { /* 忽略 */ } }
        this._stopStallMonitor(task);
        task.state = "failed";
        task.error = "命令无法启动：" + (e?.message || String(e));
        task.finishedAt = Date.now();
        task.elapsed = task.finishedAt - (task.startedAt || task.finishedAt);
        task.speed = 0;
        this._persist();
        this._fireFinal(task);
      });
    });

    // 落盘 pid（2026-10-20）：posix 下子进程带 detached，引擎被硬杀时它不会跟着死。
    // 不把 pid 写进 tasks.json，下次 restore 就没任何依据去收这个孤儿 ——
    // 只能眼看着一个已标「已中断」的任务在后台继续写目录。
    this._persist();

    // winget 下载进度旁路探测（2026-09-18）：CLI 不给下载进度，改为观测它的落盘文件；
    // 失败静默，不影响任务本身。pip / git / pnpm 不走此路。
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

    child.on("close", (code) => settle(() => {
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
          // 没有退出码（进程被信号杀死，close 的 code 就是 null）时不能拼成「命令退出码 null」：
          // 那句话会经 finished/*.json → 模型可见文本，属于脏数据（2026-10-18 修）。
          const codeText = code == null
            ? "进程被信号终止"
            : `命令退出码 ${code}` + hexSuffix;
          task.error = (task._spawnError ? task._spawnError.message + "；" : "") + clsMsg + codeText
            + (tail ? `：${summarizeCmdTail(tail)}` : "");
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
    }));
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
      // 杀整棵进程树：taskkill /T /F（win）或 kill(-pid)（posix）。
      // 两者收在 platform 层且与 spawnOpts 同文件——「起进程忘了 detached」这类缺陷
      // 从结构上不会再出现（方案 §3.3 原则一）。killTree 自己吞错，失败返回 false。
      if (!platform.killTree(t.child.pid)) {
        try { t.child.kill(); } catch { /* 已退出 */ }
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
    // percent 走 percentOf（与 /list 的摘要同一函数）：算两次就是两个真相源，
    // 迟早会漂。原先这里是内联的 Math.min + round，percentOf 与它逐字等价。
    return {
      taskId: t.taskId,
      url: t.url || null,  // 命令型任务没有 URL：给 null，别让 JSON 序列化把整个键丢掉
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
      percent: percentOf(t),
      // 取消后要告诉调用方「半成品在哪」（断点续传靠它）。此前 snapshot 不带它，
      // 工具面的「半成品已保留供续传（…）」永远报不出来（2026-10-18 补）。
      partPath: t.partPath || null,
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
      // 这条任务实际走的传输 backend（UI/诊断用；历史任务/命令任务为 null）
      backend: t.backend || null,
      backendNote: t.backendNote || null,
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

  // ── 重启恢复 ──
  // 两件事分开做：
  //   ① 同步全量恢复（历史 + 在途）——必须在返回前完成，server.js 启动即依赖 mgr.tasks 就绪
  //   ② 异步接回「还在跑的 aria2 任务」——需要真实 RPC 握手，不能阻塞启动
  //
  // 为什么要 ②：aria2c 是引擎 spawn 的**独立进程**，引擎被硬杀（崩溃 / App reload / 宿主重启）
  // 时它不会跟着死，还在继续往同一个 `.part` 写。旧语义「引擎重启 = 任务被打断」会把这种
  // 任务标成 interrupted 并补写失败终态——用户看到「下载失败」，而文件其实还在下、最后会下完，
  // 只是没人记录。一个跑了两小时的大文件因为 App 重启就显示失败，是明确的误报。
  //
  // 恢复规则（两种情形）：
  //   A：aria2 实例还活着（pid 存活 **且** getVersion 用正确 secret 能通）且任务还在它队列里
  //      → 不标 interrupted、不写终态，恢复成运行态继续跟踪（进度只取 RPC 的 completedLength）
  //   B：实例已没了 / 握手失败 / 任务不在它队列里
  //      → 保持原有语义：interrupted + 补写终态
  /**
   * 收孤儿命令进程（2026-10-20，配 detached 的收尾）。
   *
   * 为什么需要：posix 下命令型子进程带 detached（自成进程组），这是 killTree 能杀掉
   * 整棵树的前提，代价是**引擎被 SIGKILL 时子进程不会跟着死**。引擎重启后，任务已经被
   * 标成「已中断」，而 uv/pip/git 还在后台写同一个目录 —— 用户看到的与磁盘上发生的完全是两回事。
   *
   * 安全阀：只杀「记录里的 pid 还活着、且镜像名对得上」的进程。
   * 为何必须核名：PID 会被系统复用。引擎停机已一小时，那个 pid 可能已经属于别人的程序 ——
   * 不核名就杀，是拿用户的系统去赌运气。
   *
   * @private
   */
  _reapOrphanCommand(pid, cmdType) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
      if (!platform.pidAlive(n)) return false;
      // 期望的镜像名：git / node（pnpm 走 process.execPath）/ winget / python|uv
      const expect = cmdType === "git-clone" ? ["git"]
        : cmdType === "pnpm-install" ? ["node", "npm", "pnpm"]
          : cmdType === "winget-install" ? ["winget"]
            : ["python", "python3", "py", "uv"];
      const actual = platform.processNameOf(n);
      // 拿不到进程名：宁可不动。误杀的代价（用户别的程序被干掉）远大于漏杀（一个后台进程多活一阵）。
      if (!actual) return false;
      if (!expect.includes(actual)) return false;
      const killed = platform.killTree(n);
      if (!killed) { try { process.kill(n, "SIGTERM"); } catch { /* 已退出 */ } }
      return true;
    } catch { return false; }
  }

  restore() {
    // 先把没人等的孤儿终态收掉：见 _pruneOrphanFinished 的说明。
    this._pruneOrphanFinished();
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(this.dataDir, TASKS_FILE), "utf-8"));
    } catch { return; }
    if (!meta || !Array.isArray(meta.tasks)) return;
    const now = Date.now();
    // 待接回的候选：只包含「可能还在 aria2 里跑」的 URL 任务，用于后面异步验证
    const candidates = [];
    for (const m of meta.tasks) {
      const t = this.tasks.get(m.taskId);
      if (t) continue; // 内存中已有（create/prepare 后立即持久化过）
      if (m.state === "running" || m.state === "pending") {
        const isCmd = m.kind === "command" && m.cmd?.type;
        if (isCmd) {
          // 孤儿命令收尾（2026-10-20）：posix 下命令型子进程带 detached，引擎被硬杀
          // 时它不会跟着死。若 pid 还在且确实是这条命令起的子进程，先杀掉再清理。
          // 不杀就重启：uv/pip 会在后台继续写同一个目录，用户看到「已中断」+ 磁盘一直在变。
          this._reapOrphanCommand(m.childPid, m.cmd?.type);
          // 命令型：git-clone 中断删半成品目录；pnpm-install 保留 node_modules 半成品
          if (m.cmd.type === "git-clone" && m.filePath && fs.existsSync(m.filePath)) {
            try { fs.rmSync(m.filePath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
          }
        } else {
          try { if (m.filePath && fs.existsSync(m.filePath)) fs.unlinkSync(m.filePath); } catch { }
        }
        // URL 任务：保留 .part 半成品（不再删除），received 取 .part 实际大小作为续传恢复点
        const partPath = m.partPath || (m.filePath ? m.filePath + ".part" : null);
        // 与 retry 同一条规则（receivedOnDisk）：磁盘是 URL 任务进度的唯一事实来源。
        // .part 不存在时保留持久化值而不是 0：这是「重启前的恢复点」用于展示历史，抹成 0 会丢信息。
        const received = receivedOnDisk({
          kind: m.kind, backend: m.backend, aria2Gid: m.aria2Gid,
          partPath, filePath: m.filePath, received: m.received || 0,
        }, m.received || 0);
        const revived = {
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
          backend: m.backend || null,
          backendNote: m.backendNote || null,
          // .part 归属：重启后必须把「这份半成品是谁写的」一起恢复，否则选路时
          // 只能靠 .part.aria2 推断（那份控制文件可能已被清理）——推断错了就是带洞交付。
          partOwner: m.partOwner || m.backend || null,
          // 恢复时要靠 gid 回指实例里的同一条任务（不能重新 addUri：那会对同一份 .part 起第二个下载）
          aria2Gid: m.aria2Gid || null,
        };
        this.tasks.set(m.taskId, revived);
        // 可能还在 aria2 里跑的候选：先不写终态，等真实 RPC 握手后再定（见 _resumeAria2Tasks）。
        // 为什么要延后：一旦落了 interrupted 终态，app 侧等待方会立刻读到并报「下载失败」，
        // 而这条任务其实还在下——那正是要修的误报。同步只做一次廉价的 pid 粗筛：
        // 记录里的实例进程已经不在了，就没什么可等的，直接按原语义落终态。
        if (!isCmd && this._wasAria2Task(m, partPath) && recordedInstanceAlive(this.dataDir)) {
          candidates.push(m.taskId);
        } else {
          // 补写终态：引擎被 kill 时来不及走 onFinal，finished/<taskId>.json 永远不会出现，
          // 于是 app 侧 settleWhenDone 空等 30 分钟后报「下载超时未结束」——一个假错误，
          // 真实原因是「被应用重启打断」。这里补一条与 onFinal 同形的记录，让等待方立刻拿到真原因。
          this._publishInterrupted(revived);
        }
      } else {
        // 已完成/失败/取消的历史任务：全量恢复、永久保留，供卡片回放与管理器查阅。
        // 2026-10-12 John 定：不再只保留 24 小时内（原实现配合 _persist 的裁剪，
        // 会让老记录在下一次写盘时被永久抹掉，用户看到历史凭空消失）。
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
          backend: m.backend || null,
          backendNote: m.backendNote || null,
          partOwner: m.partOwner || m.backend || null,
        });
      }
    }
    // ② 异步接回还活着的 aria2 实例（不阻塞启动；握手不通就按 ① 的 interrupted 语义落终态）
    this._resumePromise = candidates.length
      ? this._resumeAria2Tasks(candidates).catch(() => { /* 见下方兜底 */ })
        // 兜底：不管接回过程出了什么意外，剩下仍是 interrupted 的候选必须把终态补上——
        // 否则它们既没恢复成运行态、也没落终态，app 侧会空等到自己的超时。
        .then(() => {
          for (const id of candidates) {
            const t = this.tasks.get(id);
            if (t && t.state === "interrupted") this._publishInterrupted(t);
          }
        })
      : Promise.resolve();
  }

  /**
   * 等「异步接回 aria2 活实例」这一步跑完。
   *
   * 为什么要公开：restore() 必须同步完成（server.js 启动即依赖 tasks 就绪），而接回需要
   * 真实 RPC 往返。要判断最终状态的调用方（测试 / 诊断）得能等它——否则会在握手中途
   * 读到「还是 interrupted」的中间态。不 await 也不会出错：接回失败就一直是 interrupted。
   *
   * @returns {Promise<void>}
   */
  whenRestored() {
    return this._resumePromise || Promise.resolve();
  }

  // ── 这条任务曾经是 aria2 接管的吗（决定要不要去握一次手）──
  // 三个依据，任一成立即候选：
  //   · partOwner === "aria2"：c04a2c0 起由真正写 .part 的 backend 记录，最直接
  //   · backend === "aria2"：上一轮选的传输后端（partOwner 缺失时的回填来源）
  //   · 存在 `.part.aria2` 控制文件：aria2 多段稀疏写的铁证（即使记录字段都被抹掉）
  _wasAria2Task(m, partPath) {
    if (!m || m.kind === "command") return false;
    if (m.partOwner === "aria2" || m.backend === "aria2") return true;
    try { return !!partPath && fs.existsSync(partPath + ".aria2"); } catch { return false; }
  }

  // ── 把「还在 aria2 里跑」的任务从 interrupted 恢复成运行态（2026-10-19）──
  //
  // 判定必须可靠，两道硬门槛：
  //   1. 记录过的 pid 进程存活（只算粗筛：pid 可能被复用）
  //   2. aria2.getVersion 用记录的 secret 真能通（真实 RPC 往返，不靠端口/进程名猜）
  // 再加一道业务门槛：实例里真能找回这条任务（持久化的 gid，或按 .part 路径回找）。
  // 三道全过才算「还在下」；任一道不过就保持 interrupted（实例已没 / 握手不通 / 任务不在队列）。
  //
  // 确认还在下之后要做的四件事：
  //   · 把已补写的 interrupted 终态**收回**（否则 app 侧等待方会先读到它而报失败）
  //   · 状态改回 running 并重新跑 _run，让 aria2 backend 接着跟踪到收尾（含已下完的交付）
  //   · 进度立刻用 RPC 刷一次（.part 大小在 aria2 下不是进度）
  //   · 不动 `.part` 与 `.part.aria2`：它们正在被写入
  async _resumeAria2Tasks(taskIds) {
    const cfg = this._readAria2Config();
    aria2Backend.setOptions({ bin: cfg.bin, port: cfg.port });
    // 实例已没 / 不是 aria2：不必再挨个握手，直接保持 interrupted
    for (const id of taskIds) {
      const t = this.tasks.get(id);
      if (!t || t.state !== "interrupted") continue;
      let adopted;
      try {
        adopted = await aria2Backend.adopt({ dataDir: this.dataDir, task: t });
      } catch (e) {
        adopted = { ok: false, reason: e?.message || String(e) };
      }
      if (!adopted?.ok) {
        // B 情形：实例已没 / 握手不通 / 任务不在队列 —— 保持原语义，现在才落 interrupted 终态。
        t.resumedFromInstance = false;
        this._publishInterrupted(t);
        continue;
      }
      // 从这一刻起它是运行中任务，不是终态任务
      t.state = "running";
      t.queued = false;
      t.finishedAt = null;
      t.error = null;
      t.speed = 0;
      t.elapsed = 0;
      t.resumedFromInstance = true;
      t.backend = "aria2";
      t.partOwner = "aria2";
      t.aria2Gid = adopted.gid || t.aria2Gid || null;
      t._resumeGid = true; // 让 backend.run 复用已有 gid，而不是再 addUri 一次
      t._forceBackend = aria2Backend; // 继续由 aria2 跟到底（不重走选路，否则可能删掉正在写的 .part）
      t._resumedStartedAt = t.startedAt || Date.now();
      t._lastProgressAt = Date.now();
      // 直接 _startTask，不走 _enqueueOrStart：这些任务**已经在 aria2 里跑着**，
      // 把它们挂成 pending 等于「不跟踪一条正在下的任务」，比误报失败更糟。
      // 并发槽位若因此超出上限，那只是如实反映了现状（aria2 并不会因为我们不跟踪就停下）。
      // 收回误报的终态：等待方读到 interrupted 就会直接报失败
      try { fs.rmSync(finishedPathOf(this.dataDir, t.taskId), { force: true }); } catch { /* 没文件也无所谓 */ }
      this._startTask(t);
    }
  }

  // ── 补写恢复后的 interrupted 终态（2026-10-18）──
  // 为什么要落盘而不是只留在内存：app 侧读到终态的唯一通道是 dataDir/finished/<taskId>.json
  // （不轮询引擎，避免挂起 RPC 堵住工具回程）。内存里标成 interrupted 只能让管理器显示正确，
  // 正在等这个任务的那一侧什么都收不到，只能等到自己的超时。
  // 形状必须与 server.js 的 onFinal 一致（同一个 summarizeTask 产出），否则消费方解析不了。
  // 幂等：路径固定为 finished/<taskId>.json，重复 restore 只会覆盖同一份。
  _publishInterrupted(task) {
    if (!task || task.state !== "interrupted") return;
    try {
      // 原子写：补写途中被 kill 时，等待方读到的要么没有文件、要么是完整记录，不会读到半截 JSON
      // （半截会被 JSON.parse 抛错吞掉，最终退化成「下载超时未结束」的假错误）
      writeJsonAtomic(finishedPathOf(this.dataDir, task.taskId), JSON.stringify(summarizeTask(task)));
    } catch { /* 补写失败不影响恢复本身（管理器至少还能显示 interrupted） */ }
  }

  // ── 回收没人等的孤儿终态（2026-10-18）──
  // finished/ 的正常路径是「等待方读走即删」（index.js settleWhenDone / notifyWhenRetryDone）。
  // 但等待方是 app 侧的轮询协程：App 重启时它一起没了，补写的终态就没人消费。
  // 所以引擎每次 restore 时收一次：超过 1 小时的终态文件必然没有等待方了。
  // 单个文件失败不影响其它，也不影响恢复。
  _pruneOrphanFinished(maxAgeMs = RESTORE_FINISHED_MAX_AGE_MS) {
    const dir = path.join(this.dataDir, "finished");
    let files = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - maxAgeMs;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* 单个失败忽略 */ }
    }
  }

  // ── 持久化（仅状态转换时调用，进度不落盘）──
  // 2026-10-12 John 定：终态记录全量保留，不再按条数裁剪——只有用户主动清理才移除。
  _persist() {
    try {
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
          backend: t.backend || null,
          backendNote: t.backendNote || null,
          partOwner: t.partOwner || null,
          // aria2 的 gid：重启后靠它回指实例里的同一条任务。
          // 不落盘就只能按 .part 路径回找（也能找，但 gid 是更直接的证据，
          // 且能区分「实例里另一条同名任务」这种罕见情形）。
          aria2Gid: t.aria2Gid || null,
          // 命令型任务的子进程 pid（2026-10-20，配 detached 的收尾）。
          // 为什么要落盘：posix 下子进程带 detached（自成进程组），引擎被 SIGKILL 时
          // 子进程不会跟着死——它会变成真正的孤儿，继续跑（uv/pip/git 写同目录），
          // 而 App 侧已经把它标成「已中断」。落盘 pid 是让下一次 restore 能把它们收掉的
          // 唯一依据（没有 pid 就只能眼睁睁看着）。只在 running 时写，终态时清。
          childPid: (t.kind === "command" && t.state === "running" && t.child && t.child.pid) ? t.child.pid : null,
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
      return { bin: "pnpm", args: ["install"] }; // 退化：PATH 上有 pnpm.exe 时可用
    },
    makeParser: (pp) => pp.createPnpmParser(),
    classifyExit: null,
  },
  "winget-install": {
    build: (cmd) => ({ bin: resolveWingetBin(), args: buildWingetArgs(cmd) }),
    makeParser: (pp) => pp.createWingetParser(),
    classifyExit: (pp) => pp.classifyWingetExit,
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

// winget 可执行解析：platform.which 优先，其次 WindowsApps 别名兜底（受管进程 PATH 不含用户别名时）。
// 探测手段统一走 platform 层（win 用 where.exe，posix 用 which）——这层不再出现 where.exe。
export function resolveWingetBin() {
  const name = platform.exe("winget");
  const hit = platform.which("winget");
  // which 已在 Windows 上返回 .exe 完整路径；posix 上不可能有 winget，命中就照用
  if (hit) return hit;
  if (platform.name !== "win32") return name; // 非 Windows：只可能是 PATH 上有个同名命令
  const guess = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "winget.exe");
  if (fs.existsSync(guess)) return guess;
  return name; // 退化：依赖 PATH
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

// Python 解释器解析：显式 pythonPath 优先（不存在则抛），否则由 platform.which 找第一个。
// 名字扩展名交给平台层（win 上是 python.exe，posix 上是 python）——这里不判平台。
function resolvePythonBin(pythonPath) {
  if (pythonPath) {
    const p = path.resolve(String(pythonPath));
    if (!fs.existsSync(p)) throw new Error(`指定的 Python 解释器不存在：${p}`);
    return p;
  }
  // win 上 python 可能是 0 字节的 App Execution Alias（应用商店重定向桩），
  // which 会返回它、existsSync 却是 false —— 这正是 platform.which 刻意不做二次过滤的原因。
  return platform.which("python") || platform.which("python3") || platform.exe("python");
}

// uv 可执行解析：platform.which 优先，其次官方安装器默认位置。
function resolveUvBin() {
  const hit = platform.which("uv");
  if (hit) return hit;
  const guess = platform.name === "win32"
    ? path.join(platform.homeDir(), ".local", "bin", "uv.exe")
    : path.join(platform.homeDir(), ".local", "bin", "uv");
  if (fs.existsSync(guess)) return guess;
  return platform.exe("uv"); // 退化：依赖 PATH
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
  // 1) 三平台通用前半：which 找到的若本身就是 JS 入口（posix 上 npm 全局装的 pnpm 是带 shebang
  //    的脚本），直接用；若是 .cmd shim（Windows），读内容挖出真正的 pnpm.mjs|cjs。
  //    旧实现在 posix 上恒返回 null（只认 .cmd 结尾），于是退化到 PATH 上的 pnpm —— 在
  //    有 .cmd 逻辑的 Windows 上对，在 mac/linux 上就靠碰运气了。
  const hit = platform.which("pnpm");
  if (hit) {
    if (/\.(mjs|cjs)$/i.test(hit)) return hit;
    try {
      const content = fs.readFileSync(hit, "utf-8");
      // ① .cmd shim 里的相对跳转（Windows npm 全局安装）
      const m = content.match(/node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.(?:mjs|cjs)/);
      if (m) {
        const entry = path.resolve(path.dirname(hit), m[0].replace(/\//g, path.sep));
        if (fs.existsSync(entry)) return entry;
      }
      // ② posix 上的 shim 常写成 exec node "$basedir/../pnpm/bin/pnpm.cjs" —— 同样抓路径
      const m2 = content.match(/(?:[^\s"']*)\/pnpm\/bin\/pnpm\.(?:mjs|cjs)/g);
      if (m2) {
        for (const rel of m2) {
          const norm = rel.replace(/^"|"$/g, "");
          const p = norm.startsWith("/")
            ? norm
            : path.resolve(path.dirname(hit), norm.replace(/\//g, path.sep));
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* 读不了就往下走 */ }
  }
  // 2) npm root -g 直拼标准结构（三平台同一套布局）
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", windowsHide: platform.name === "win32" });
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

// 续传起点校正（2026-10-19）：URL 任务的 received 以磁盘为准，不用内存值。
//
// 为什么要：task.received 记的是「已交给写流缓冲」的字节（node-http.js: task.received += chunk.length），
// 取消/中断走 ws.destroy()，destroy 不 flush，缓冲里的写被丢弃——磁盘上的 .part 可能远小于
// received，实测 64MB 高速下载取消时 .part 只有 0 字节。若沿用内存值当续传起点：
// createResumeStream 的长度校验必然失败，而 retry() 原本又不清 received，每次重试都拿同一个坏起点
// —— 于是「重试」按钮永久失败，只有重启引擎（走 restore 的 statSync）能自救。
// 现在 retry() 与 restore() 共用这一条规则，不再有两套口径。
//
// .part 不存在时用调用方给的 fallback（两个调用点取值不同，理由写在各自处）：
//   retry()  → 0：重试是一次新运行，不能声称自己有根本不存在的字节
//   restore()→ 持久化的 received：那是「重启前的恢复点」，用于展示历史，抹成 0 会丢信息
// 命令型任务没有 .part；aria2 任务的 .part 大小**不是进度**（file-allocation=none 时一上来就是全长，
// 稀疏文件，实测已完成 300KB 的 .part 已经 1.19MB），它的真实进度在自己的 .aria2 控制文件里，
// 所以这两类原样沿用持久化的 received。
function receivedOnDisk(t, fallback = 0) {
  const keep = Number.isFinite(t?.received) && t.received > 0 ? t.received : 0;
  const miss = Number.isFinite(fallback) ? fallback : keep;
  if (!t || t.kind === "command") return keep;
  if (t.backend === "aria2" || t.aria2Gid) return keep;
  if (!t.partPath) return miss;
  try {
    return fs.existsSync(t.partPath) ? fs.statSync(t.partPath).size : miss;
  } catch {
    return miss;
  }
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
  // 错误行识别：pnpm 的 [ERR_XXX] / git 的 fatal: / pip 的 error:（PEP 668 就长这样）
  const errLine = lines.find((l) => /ERR_[A-Z0-9_]+|^fatal:|^error:|^ERROR:/i.test(l)) || "";
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
  // PEP 668（2026-10-20）：Debian/Ubuntu 24.04、Homebrew Python 等把系统 Python 标成
  // externally-managed，pip 直接拒装。原文是「error: externally-managed-environment」+
  // 一段链接，用户需要的是「该怎么办」。
  // **不给 --break-system-packages**：那会把系统 Python 的包管理搞坏，而且是用户
  // 看不见的持久损坏。正确做法是 venv 或 pipx，这里直接告诉他。
  if (/externally-managed-environment|EXTERNALLY-MANAGED/i.test(tail)) {
    return "系统 Python 受外部管理，禁止直接装包（PEP 668）。请改用 venv："
      + "先建虚拟环境（python -m venv .venv），再用该环境的解释器（pythonPath 指向 .venv/bin/python）安装；"
      + "或改用 runner=uv 走独立环境";
  }
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

// 代理地址来源（按优先级）：显式参数 → config.proxy.url/字符串 → 环境变量 → 系统代理（只读）
//
// 系统代理这一步走 platform.readSystemProxy()：win 读注册表，mac 读 scutil，linux 读
// gsettings/env。旧写法直接 spawnSync "reg query"，在 mac/linux 上恒失败且毫无提示 ——
// 用户看着系统里明明配了代理，下载器却报「无代理」。
//
// 注意：只读，不写系统设置（只读纪律）。
export function resolveProxyUrl(dataDir, explicit = "") {
  if (explicit) return explicit;
  const p = readUserConfig(dataDir).proxy;
  if (typeof p === "string" && p.trim()) return p.trim();
  if (p && typeof p === "object" && typeof p.url === "string" && p.url.trim()) return p.url.trim();
  const envP = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (envP) return envP;
  try {
    const sp = platform.readSystemProxy();
    if (!sp || !sp.enabled || !sp.server) return "";
    const v = String(sp.server).trim();
    if (!v) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
    // 注册表/系统库里存的可能是 "127.0.0.1:7890"，也可能带协议前缀；
    // 也可能包含 socks 协议（gsettings 的 socks host）。带协议的照原样，裸 host:port 补 http。
    return "http://" + v;
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
      ["-sI", "--max-time", sec, "-o", platform.nullDevice(), `https://${h}/`],
      { windowsHide: platform.name === "win32", timeout: timeoutMs + 2000 }
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

// readSmallBody 与 AbortError 已随 URL 下载逻辑搬至 ./backends/node-http.js

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
