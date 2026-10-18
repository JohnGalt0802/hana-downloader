// engine/atomic-write.js — 终态记录的原子写（2026-10-19）
//
// 为什么需要它：finished/<taskId>.json 是 app 侧读到终态的唯一通道
// （index.js settleWhenDone / notifyWhenRetryDone 每 2 秒 existsSync → readFileSync → JSON.parse）。
// 原先用 writeFileSync 直接写目标路径：进程在 write 中途被杀，文件会永久停在半截 JSON。
// 读方那一侧 JSON.parse 抛错被 catch 吞掉，于是继续空转，一直读到 30 分钟满，
// 最后报「下载超时未结束」——把一次成功伪装成超时（与 2026-10-18 修掉的假超时同一症状）。
//
// 做法：同目录临时文件 → 写入 → fsync → rename 覆盖目标。
//   · 临时文件必须与目标**同目录**：跨盘 rename 不是原子的（会退化成 copy+delete）
//   · rename 之前目标路径上的旧文件完好；rename 之后读到的是完整新文件，不存在中间态
//   · fsync 在 rename 之前：保证「可见」时内容已经落盘，不只是进了页缓存
//   · 临时文件名以 .tmp 结尾（不是 .json），不会被 finished/ 的消费方与回收逻辑当成终态
//
// 并发/幂等：每次写入用独立的临时文件名（pid + 随机），同一任务被并发写终态时
// 各写各的临时文件，rename 后写覆盖先写——可以接受；任何时刻目标路径上都不会有半截内容。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// 同步睡眠：rename 重试要用（这里全是同步 API，不能用 await）
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* 忙等，极少数环境没有 Atomics */ } }
}

// Windows 上 rename 到「正被别的进程打开的目标文件」会报 EPERM/EACCES/EBUSY。
// 这不是数据问题：读方是 existsSync → readFileSync 的瞬态持有（app 侧每 2 秒一次）。
// 不重试的后果很具体：终态写不出去 → 等待方读到 30 分钟满 → 又变成「下载超时未结束」。
// 预算刻意小（20×5ms≈100ms）：这是同步重试，会阻塞事件循环；
// 真实持有时长是微秒级，100ms 已经远超，而 restore() 连续补写多个任务时不能被单个卡住的文件拖长。
function renameWithRetry(tmp, target, attempts = 20, waitMs = 5) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, target); return; }
    catch (e) {
      const retryable = e && (e.code === "EPERM" || e.code === "EACCES" || e.code === "EBUSY");
      if (!retryable || i >= attempts - 1) throw e;
      sleepSync(waitMs);
    }
  }
}

/**
 * 原子写一个 JSON 文件：要么目标路径保持原样，要么变成完整的这份内容。
 * 失败时清理临时文件并抛出（调用方按原逻辑 try/catch）。
 * @param {string} filePath 目标文件（绝对或相对路径）
 * @param {string|object} data 已序列化的字符串，或任意可 JSON 化的值
 * @returns {string} 实际写入的文本
 */
export function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const tmp = path.join(dir, `.${base}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);

  let fd = null;
  let renamed = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // wx：临时名唯一，若撞名则直接失败而不是覆盖别人的临时文件
    // mode 用 0o666（同 writeFileSync 的默认值，实际受 umask 约束）：不因改写入方式而改掉文件权限
    fd = fs.openSync(tmp, "wx", 0o666);
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmp, filePath); // 原子替换：到这一步才算写完
    renamed = true;
    return text;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 已关或无效 */ } }
    // 失败路径不留垃圾（成功路径 tmp 已被 rename 走，unlink 会 ENOENT，忽略即可）
    if (!renamed) { try { fs.unlinkSync(tmp); } catch { /* 本来就没写成 */ } }
  }
}

/** 终态记录路径的唯一来源：finished/<taskId>.json（App 侧读的就是这个路径） */
export function finishedPathOf(dataDir, taskId) {
  return path.join(dataDir, "finished", `${taskId}.json`);
}
