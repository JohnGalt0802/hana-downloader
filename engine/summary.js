// engine/summary.js — 任务摘要的唯一来源（/list、finished/*.json、stalled/*.json 共用）
//
// 为什么单独成文件：summarize 原先内联在 server.js 里，既没法离线单测，
// 也没人盯它和 dlcore.snapshot() 的字段集是否对齐（2026-10-18 实测后果：
// /list 丢掉了 unit/stage/stageDetail/percent/speed/elapsed/queued/kind/startedAt/finishedAt，
// 管理器刷新后把 git/pnpm 的对象数当字节显示、百分比整段消失、耗时恒为空）。
//
// 契约：**同一份字段语义**。snapshot() 是 /wait（卡片）的快照，summarizeTask 是 /list
// （管理器）与落盘事件的摘要，两者被 UI 同一套代码消费，所以字段集与口径必须一致。
// summarizeTask 同时接受两种形态：
//   · 快照形态（mgr.list() 的产物：有 cmdType / percent / stalled 布尔）
//   · 原始任务形态（mgr.onFinal/onStall 直接给的 task：有 cmd.type，没有 percent）
//
// 纯函数，无 IO、无宿主依赖，可 Node 侧直接单测（tests/unit-contract.mjs）。

/**
 * 百分比。全仓唯一口径，`dlcore.snapshot()` 与 `summarizeTask()` 都调它。
 *
 * 口径（与改造前的 snapshot 逐字等价，前端已按现状工作，不得改）：
 *   total 为真值时才计算，结果 Math.min(100, received/total*100)，再 Math.round(x*10)/10；
 *   否则 null。
 * 唯一的「新增」是一层 NaN 保护：received 非数值时改造前会算出 NaN
 *（JSON 序列化后变 null，前端拿到的仍是 null），现在直接给 null，对象层面也干净。
 *
 * 注意：不再“优先取 t.percent”。那会让同一份数据存在两个真相源
 * （快照自带的 percent vs 现算），也是本题要收口的技术债。
 */
export function percentOf(t) {
  if (!t) return null;
  const total = t.total;
  if (!total) return null;
  const pct = Math.min(100, (t.received / total) * 100);
  if (!Number.isFinite(pct)) return null;
  return Math.round(pct * 10) / 10;
}

/**
 * 任务摘要。字段集 = 「管理器 + 事件消费方」用到的全部字段。
 * @param {object|null} t 快照或原始任务
 * @returns {object|null}
 */
export function summarizeTask(t) {
  if (!t) return null;
  return {
    // taskId 是主键，刻意**不兜底**：mgr.tasks 是 Map<taskId, task>，到这里还没有 taskId 就是
    // 上游的编程错误。静默给 null 只会让一条无身份的记录流进 /list 与管理器（行 key、
    // 取消/重试按钮都靠它），把错误推到更远的地方。缺键就会在 JSON 里消失——
    // 消费方看到 undefined 比看到一个假 id 更容易定位问题。
    taskId: t.taskId,
    // 其余字段一律兜底：summarizeTask 是对外契约的收口点，不能依赖上游一定给值。
    state: t.state || t.status || null,
    fileName: t.fileName || null,
    url: t.url || null,
    total: t.total ?? null,
    received: t.received ?? 0,
    filePath: t.filePath || null,
    error: t.error || null,
    canceledBy: t.canceledBy || null,
    // 两种形态都兼容：快照有 cmdType，原始任务只有 cmd.type
    cmdType: t.cmdType || t.cmd?.type || null,
    note: t.note || null,
    sessionPath: t.sessionPath || null,
    sessionId: t.sessionId || null,
    stallTaskId: t.stallTaskId || null,
    stalledAt: t.stalledAt || null,
    // ── P2 补齐项（2026-10-18）：这些字段管理器一直在读，此前被 summarize 丢掉 ──
    kind: t.kind || "url",
    unit: t.unit || "bytes",
    stage: t.stage || null,
    stageDetail: t.stageDetail || null,
    percent: percentOf(t),
    speed: Number.isFinite(t.speed) ? Math.round(t.speed) : 0,
    elapsed: t.elapsed ?? 0,
    queued: t.queued === true,
    startedAt: t.startedAt ?? null,
    finishedAt: t.finishedAt ?? null,
    // 停滞标记：快照形态给布尔，原始任务形态靠 stalledAt 推断（与 snapshot 口径一致）
    stalled: t.stalled != null ? t.stalled === true : t.stalledAt != null,
    saveDir: t.saveDir || null,
    partPath: t.partPath || null,
    speedLimit: t.speedLimit || 0,
  };
}
