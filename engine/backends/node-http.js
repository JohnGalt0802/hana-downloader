// hana-downloader-app/engine/backends/node-http.js — URL 下载 backend（Node 原生 http/https）
// 2026-10-18 从 dlcore._run() 原地提取：行为零变化，只搬家不重写。
//
// 搬进来的：请求与重定向（3xx / 文本重定向）、代理优先 + 失败降级直连、断点续传
// （Range/If-Range/.part、206/200/416 分支）、流式落盘与限速、SHA-256 校验、终态判定。
// 留在 dlcore 的：停滞监视、elapsed、快照刷盘、终态回调（生命周期归 dlcore，传输归 backend）。
//
// ctx 由 dlcore 传入：
//   task        任务对象（字段见 dlcore._createTask）
//   dataDir     数据目录（解析代理时用）
//   resolveProxy(dataDir, url) → 代理地址字符串（空串 = 直连）
//   friendlyError(err)         → 人话错误文案
//   persist()                  → dlcore._persist()，进度节流落盘用
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { createTunnelAgent } from "../tunnel-agent.js";

const SPEED_SAMPLE_MS = 700;   // 测速采样间隔
const SPEED_SAMPLES_MAX = 5;   // 滑动窗口样本数（≈3.5s）
const CHUNK_SLEEP_MIN_MS = 1;  // 限速时 chunk 间最小等待

export const nodeHttpBackend = {
  name: "node-http",
  capabilities() {
    return {
      available: true,
      name: "node-http",
      features: ["resume", "sha256", "proxy", "proxy-fallback", "speed-limit", "cancel", "redirect"],
      reason: null,
    };
  },

  async run(ctx) {
    const { task } = ctx;

    let ws = null;
    let wroteAnyChunk = false;
    const hash = task.expectedSha256 ? createHash("sha256") : null;
    const controller = task.controller;
    let req = null;
    // 取消：destroy 底层请求（触发 error → catch 按 canceled 处理）
    const abortListener = () => { try { if (req) req.destroy(new AbortError("canceled by user")); } catch { /* 忽略 */ } };
    controller.signal.addEventListener("abort", abortListener);
    try {
      // 续传前先核账（2026-10-19 修）：.part 已经完整（大小 === total）时，绝不能再发 Range 从尾部开始——
      // 那必然被服务端回 416，而 416 分支会删掉 .part，一份可能完全正确的 1GB 半成品就此白下。
      // 有 expectedSha256 时直接对整份 .part 流式重算摘要：通过即交付，不通过如实报失败（保留 .part）。
      if (hash && task.partPath && task.total != null && task.total > 0) {
        let partStat = null;
        try { partStat = fs.statSync(task.partPath); } catch { /* 没有 .part：走正常下载 */ }
        if (partStat && partStat.size === task.total) {
          await seedHashFromFile(task.partPath, partStat.size, hash);
          const presetDigest = hash.digest("hex");
          task.received = task.total;
          if (presetDigest === task.expectedSha256) {
            fs.renameSync(task.partPath, task.filePath);
            task.state = "done";
            task.error = null;
          } else {
            task.state = "failed";
            task.error = `SHA-256 校验失败：期望 ${task.expectedSha256}，实际 ${presetDigest}`
              + "（半成品文件大小已完整，内容与期望摘要不符；已保留 .part 供排查）";
          }
          task.finishedAt = Date.now();
          return;
        }
      }

      const targetUrl = new URL(task.url);
      // 本地回环目标永不走代理：回环流量经代理隧道既慢又不稳定（实测被中途掐断）
      const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(targetUrl.hostname)
        || /^127\./.test(targetUrl.hostname);
      const proxy = isLoopback ? "" : ctx.resolveProxy(ctx.dataDir, task.url);
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
            // 续传起点：发出的 Range 必须与磁盘上的 .part 长度一致。
            // 不能只信 task.received —— 那是「已交给写流缓冲」的字节，取消/中断后缓冲被丢弃，
            // 磁盘可能更少甚至没有文件。以磁盘为准，后面 206 分支的 Content-Range 校验
            // 就不会因为一个不可兑现的起点而硬失败。.part 不存在 → 0（从头下）。
            startOffset = task.resumable !== false ? partSizeOnDisk(task) : 0;
            if (task.received !== startOffset) task.received = startOffset;
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
        const crTotal = m[3] === "*" ? null : Number(m[3]);
        // 先建写流：它可能把起点按磁盘实际情况退回来（半成品长度不足 / 不存在时）。
        // 返回值与期望不同时以它为准重算 startOffset 与 received，否则后续 chunk 会从旧值上累加。
        const resumed = await createResumeStream(task, startOffset);
        ws = resumed.ws;
        if (resumed.startOffset !== startOffset) {
          startOffset = resumed.startOffset;
          task.received = startOffset;
        }
        // 服务器给的起始位置必须与（校正后的）起点一致：对不上是真的不一致（体是别的区间），
        // 不能吞——吞了就会把错位的字节当成功交付。可恢复的情况已在 createResumeStream 里退让过了。
        if (crStart !== startOffset) throw new Error(`断点续传偏移不符：服务器返回 ${crStart}，期望 ${startOffset}`);
        if (crTotal != null && Number.isFinite(crTotal) && crTotal > 0) {
          task.total = crTotal;
        } else {
          // Content-Range 无总长度：用剩余长度 + 起始偏移还原全量大小
          const cl = parseInt(res.headers["content-length"] || "", 10);
          task.total = Number.isFinite(cl) && cl > 0 ? cl + startOffset : null;
        }
        // 续传：hash 必须覆盖整文件，所以先把 [0, startOffset) 的已有字节喂进去。
        // 漏掉这一段（旧实现）会让摘要只算后半截，正确文件也必然报「SHA-256 校验失败」。
        if (hash) await seedHashFromFile(task.partPath, startOffset, hash);
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
        // 写流出错必须转成 reject：ws.write() 失败（磁盘满）与取消时 destroy 后
        // 残留的挂起写（ERR_STREAM_DESTROYED）都会在写流上发 'error'，没人监听就是
        // 进程级 unhandled error —— 实测取消高速下载时直接抛死引擎进程（2026-10-19）。
        ws.on("error", reject);
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
          // 写流已销毁（取消/出错）：还往上面写只会再抛 ERR_STREAM_DESTROYED，
          // 而且会把根本没落盘的字节记进 received——正是「内存大于磁盘」的来源。
          if (ws.destroyed) return;
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
            ctx.persist();
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
            return; // 已标终态，交给 dlcore 收尾
          }
        }
        if (fs.existsSync(task.partPath)) {
          try {
            fs.renameSync(task.partPath, task.filePath);
            task.state = "done";
            task.error = null;
          } catch (re) {
            task.state = "failed";
            task.error = ctx.friendlyError(e) + "；落盘改名失败：" + ctx.friendlyError(re);
          }
        } else {
          task.state = "failed";
          task.error = ctx.friendlyError(e);
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
          task.error = ctx.friendlyError(e);
        } else {
          // failed 且写过 chunk：保留 .part，状态置 interrupted（可续传）
          task.state = "interrupted";
          task.error = ctx.friendlyError(e);
        }
      }
      task.finishedAt = Date.now();
    } finally {
      try { controller.signal.removeEventListener("abort", abortListener); } catch { /* 忽略 */ }
    }
  },
};

// 把 .part 的 [0, length) 段流式喂给 hash（续传时补齐前段摘要）。
// 必须流式：readFileSync 读 1GB 级文件会把内存和事件循环一起顶爆。
async function seedHashFromFile(filePath, length, hash) {
  if (!(length > 0)) return;
  const rs = fs.createReadStream(filePath, { start: 0, end: length - 1 });
  for await (const chunk of rs) hash.update(chunk);
}

// .part 的实际大小（续传起点的唯一事实来源）；不存在或不可读 → 0。
function partSizeOnDisk(task) {
  if (!task?.partPath) return 0;
  try {
    return fs.existsSync(task.partPath) ? fs.statSync(task.partPath).size : 0;
  } catch {
    return 0;
  }
}

// 206 续传：必须用 r+ 打开已存在的 .part，绝不能用默认的 "w"（会截断清零）。
// fs.createWriteStream(path, { start }) 默认 flags 是 "w"：先 truncate 到 0 再从 start 写，
// [0,startOffset) 全部被清零、状态却报 done（2026-10-18 修）。
// r+ 不截断（文件不存在则 ENOENT），FileHandle.createWriteStream({ start }) 基于已打开的 fd，
// 不会重新打开/截断（实测对照见提交说明）。
//
// 长度不足 startOffset / 文件不存在（2026-10-19 修）：不再硬失败，改为以磁盘为准把起点退回来。
// 内存里的 received 是「已交给写流缓冲」的字节，取消/中断时 destroy 不 flush，磁盘上可能更少、
// 甚至没有 .part。把一次本可恢复的状态报成永久失败（且 retry 沿用同一个坏起点，只能重启引擎），
// 代价远大于「从头重下已经存在的那段」。真正的服务端不一致仍由调用方用 Content-Range 校验拦住。
// 返回 { ws, startOffset }，调用方必须用返回的 startOffset 继续（它还要用于 received 与 Content-Range）。
async function createResumeStream(task, startOffset) {
  // 从 0 开始（服务器主动给 206、我们没发 Range 的非规范响应）：无前段要保留，
  // 保持原有 "w" 语义（建文件/截断到 0），与原实现逐字等价。
  if (!(startOffset > 0)) return { ws: fs.createWriteStream(task.partPath, { flags: "w" }), startOffset: 0 };
  let fh;
  try {
    fh = await fs.promises.open(task.partPath, "r+");
  } catch (e) {
    // .part 不存在（ENOENT）：没有可续的前段，退成从头写的 "w"，而不是把任务钉死。
    // 其它错误（EACCES/EISDIR 等）是真的文件不可用，保留报错。
    if (e?.code === "ENOENT") {
      return { ws: fs.createWriteStream(task.partPath, { flags: "w" }), startOffset: 0 };
    }
    throw new Error(`续传失败：半成品文件不可用（${e.code || e.message}）`);
  }
  try {
    const st = await fh.stat();
    if (st.size < startOffset) {
      // 内存值与磁盘不符（取消时写缓冲被丢弃）。以磁盘为准继续，
      // 不要把一次可恢复的状态变成永久失败。
      startOffset = st.size;
    }
    if (!(startOffset > 0)) {
      // 磁盘上实际是 0 字节：r+ 从 0 写也能工作，但 "w" 语义更明确（截断到 0 再写）。
      await fh.close();
      return { ws: fs.createWriteStream(task.partPath, { flags: "w" }), startOffset: 0 };
    }
    return { ws: fh.createWriteStream({ start: startOffset }), startOffset };
  } catch (e) {
    try { await fh.close(); } catch { /* 忽略 */ }
    throw e;
  }
}

// 小响应缓冲：Content-Length < 4KB 时读完整 body，用于检测文本重定向
// （npmmirror 等返回 200 + "Redirecting to <url>" 的非标准重定向）。
// 非重定向时返回 Buffer（由调用方写回流），重定向/异常返回 null 由上层处理。
//
// 2026-10-19 修：旧实现拿「总耗时 3 秒」当结束条件——到点就 resolve(null)，
// 把已经收到的字节整段扔掉；调用方再从流里读剩下的部分，于是交付一个缺头部的
// 截断文件而状态报 done。现在的语义是：
//   · 只有读到 end、且字节数与 Content-Length 相符，才算结束，返回完整 Buffer；
//   · 停顿（暂时没有新数据）不是结束，只重置空闲计时，已收字节一律保留；
//   · 空闲超过上限、流报错、实际字节数与声明不符 → 明确失败（reject），
//     绝不把半截数据当成功交给上层。
const SMALL_BODY_IDLE_MS = 30000; // 空闲上限：连续这么久一个新字节都没有才判失败（与 dlcore 默认 stall 阈值一致）
const SMALL_BODY_MAX = 8192;      // 声明 <4KB 却发超这个量：响应头与实际不符，按失败处理

function readSmallBody(res) {
  const cl = parseInt(res.headers["content-length"] || "", 10);
  if (!(Number.isFinite(cl) && cl >= 0 && cl < 4096)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onErr);
      res.removeListener("close", onClose);
    };
    // 失败即明确失败：拆掉连接，别让它带着「已丢字节」的半成品继续往下走
    const fail = (err) => {
      if (done) return;
      done = true;
      cleanup();
      try { res.destroy(); } catch { /* 忽略 */ }
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = (buf) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(buf);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => fail(new Error(`小文件响应空闲超过 ${SMALL_BODY_IDLE_MS / 1000} 秒（已收 ${total}/${cl} 字节）`)),
        SMALL_BODY_IDLE_MS
      );
    };
    const onData = (c) => {
      chunks.push(c);
      total += c.length;
      if (total > SMALL_BODY_MAX) {
        return fail(new Error(`响应长度与 Content-Length 不符（声明 ${cl}，已收到 ${total} 字节）`));
      }
      arm(); // 有新字节：只重置空闲计时，不结束
    };
    const onEnd = () => {
      if (total !== cl) {
        return fail(new Error(`响应长度与 Content-Length 不符（声明 ${cl}，实际 ${total} 字节）`));
      }
      ok(Buffer.concat(chunks));
    };
    const onErr = (e) => fail(e);
    // close 而没等到 end：连接被提前断开。Node 对截断响应通常先发 aborted/error，
    // 这里兜一层，避免「只有 close 没有 error」时永远挂住（旧实现就会挂到进程退出）。
    const onClose = () => {
      if (!res.complete) fail(new Error(`连接提前关闭（已收 ${total}/${cl} 字节）`));
    };
    res.on("data", onData);
    res.on("end", onEnd);
    res.on("error", onErr);
    res.on("close", onClose);
    arm();
  });
}

class AbortError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "AbortError";
  }
}
