# backend 契约与 aria2 接入（W2 · 2026-10-18）

## 一、契约在哪、怎么用

**唯一实现位置**：`engine/backends/contract.js`

```js
import { validateBackend, capabilitiesOf, validateContext, deliverPartFile, sha256File } from "./backends/contract.js";
```

| 导出 | 用途 |
| --- | --- |
| `REQUIRED_BACKEND_MEMBERS` / `REQUIRED_CAPABILITIES` / `REQUIRED_CTX_FIELDS` / `REQUIRED_TASK_FIELDS` / `OPTIONAL_TASK_FIELDS` | 契约的字段清单（常量，测试与调用方共用同一份） |
| `validateBackend(backend)` | 校验 `name` / `capabilities()` / `run()` 齐备，返回 `{ ok, errors[] }`（同步；`capabilities` 允许返回 Promise） |
| `validateCapabilities(cap)` | 校验 `{ available, name, features, reason }` |
| `capabilitiesOf(backend, ...args)` | 取能力的统一入口（兼容同步/Promise/抛错，永远回完整对象） |
| `validateContext(ctx)` | backend 入口处防御性校验，缺字段直接抛 |
| `deliverPartFile(task)` | `.part` → 正式文件，**有 `expectedSha256` 时先比对内容，不符就不交付** |
| `sha256File(path)` | 流式 SHA-256（1MB 分块，不整文件进内存） |

一个 backend 最小形状：

```js
export const myBackend = {
  name: "my-backend",
  capabilities() { return { available: true, name: "my-backend", features: [], reason: null }; },
  async run(ctx) { /* 把字节弄到磁盘，写 task.state/received/total/error */ },
};
```

### ctx 形状（dlcore 传进来）

| 字段 | 说明 |
| --- | --- |
| `task` | 任务对象（`dlcore._createTask` 产出） |
| `dataDir` | 数据目录；backend 只允许在这里放自己的实例记录/临时文件 |
| `resolveProxy(dataDir, url)` | 返回代理 URL，空串 = 直连（回环目标由 backend 自行跳过） |
| `friendlyError(err)` | 错误归一成一句人话 |
| `persist()` | 请求 dlcore 刷盘（节流用，别每条 chunk 都调） |

### backend 必须写好的 task 字段

`state`、`received`、`total`、`error`。
可选：`speed` / `stage` / `stageDetail` / `unit` / `etag` / `lastModified` / `acceptRanges` / `finishedAt`。

### 禁止

- 不调 dlcore 内部方法（除 `ctx.persist()`）：不碰 `_fireFinal` / `_pumpQueue` / `_persist`
- 不碰 UI / 会话 / 卡片 / 通知
- **不得把「传输结束」当「文件正确」**：`state=done` 必须建立在内容级校验之上
- 不得谎报成功：RPC 失联、提交结果不明、取消未确认 → 保持未完成 + 写 error

### 错误语义

backend 可以 throw，也可以自己写完 `task.state` / `task.error` 后正常返回。
`dlcore._run` 的 catch 分支保证「抛错 = 没完成」：状态落 `interrupted`（取消时落 `canceled`），
绝不会带着 `running` 静默结束。

---

## 二、aria2 backend（`engine/backends/aria2.js`）

### 受管实例

```
aria2c --enable-rpc --rpc-listen-port=<port> --rpc-secret=<random>
       --rpc-listen-all=false --dir=<dataDir>/aria2-downloads
       --continue=true --auto-file-renaming=false --allow-overwrite=true
       --file-allocation=none --max-concurrent-downloads=1
       --disable-ipv6=true --no-conf=true
```

- **只管理自己启动的实例**：PID/端口/secret 记在 `dataDir/aria2-instance.json`（权限 600）；
  关闭只关自己持有的 `ChildProcess`。**代码里没有任何 `taskkill aria2c.exe` / `pkill aria2c`**。
- **端口不强占**：默认 6802，依次试 6802–6809；探测用 `aria2.getVersion` 确认对面真是 aria2；
  全占用则 `available:false, reason:"端口被占用"`。
- **secret 每次启动随机**（`crypto.randomBytes(24)`），只存内存 + 实例记录文件；**不进日志、不进 capabilities 回包**。
- 复用：内存实例 → 记录文件里 pid 还活着且 `getVersion` 通 → 新起。复用的实例（adopted）不 kill。

### 能力探测

`aria2Backend.capabilities({ dataDir })` → `{ available, name, features, reason, bin, port, version }`。

**`available:true` 必须建立在真实 RPC 往返之上**（2026-10-18 修）：

1. 先识别配置端口上坐的是谁（`identifyOccupant`）：空闲 / aria2 / 其它
   —— 被**非 aria2** 占着就 `available:false`，reason 直接说清（配置错了要当场说，不静默避让）
2. 起/复用受管实例（与 `run` 同一条路径，不新增进程管理逻辑）
3. 用正确的 secret 调 `aria2.getVersion`，**拿到合法 version 才算可用**，并把版本填进回包

避让保留：配置端口被**另一个 aria2** 占着时，跳过它自己找下一个端口（不抢别人的实例）。

识别细节（实测踩出来的）：aria2 对未授权请求**故意延迟约 2s** 才回 `Unauthorized`（防猜 secret）。
所以探测超时必须 ≥3s，否则会把自家实例误判成「非 aria2」。而答 `Unauthorized` 恰恰证明对面是 aria2
（JSON-RPC 数字 error code），这种情形算「是 aria2」，继续走握手流程。

### 进度与状态映射

| aria2 | → 本仓语义 |
| --- | --- |
| `active` | `running` |
| `waiting` / `paused` | `pending`（映射函数层面；**运行中不把 task.state 降级**，避免 dlcore 并发槽位计数错乱） |
| `complete` | `"complete"` —— **不等于 done**，必须过内容级校验才交付 |
| `error` | `failed`（网络类 errorCode 1/2/5/6/7/29 且已收到字节 → `interrupted`，与 node-http 同语义） |
| `removed` | `canceled` |

进度只认 RPC：`completedLength → received`、`totalLength → total`、`downloadSpeed → speed`（700ms 采样 + 5 点滑动平均）。
**绝不用 `.part` 文件长度当进度**：`file-allocation=none` 下 aria2 仍会把 `.part` 开到全长，
实测已完成 300KB 的文件 `.part` 已经是 1.19MB。同理 `dlcore.restore()` 对 aria2 任务不做
`statSync(.part)` 兑现（否则重启后进度直接显示 100%）。

### 交付判定（内容级）

aria2 报 `complete` 之后依次核对：

1. `.part` 存在（不在就按 `files[].path` 找回并改名）
2. `completedLength === totalLength`
3. 文件大小 === `totalLength`
4. `expectedSha256` 存在时 → `deliverPartFile()` 流式算 SHA-256 比对
5. 全部通过才 `rename(.part → filePath)` 并 `state=done`；任何一项不过 → `failed`，**不交付**

RPC 侧只要带了 `expectedSha256`，还会同时给 aria2 传 `checksum=sha-256=…` 双重自检
（aria2 自检失败会回 errorCode 32，我们同样落 failed 而不看它的 status）。

### 取消语义

`aria2.remove(gid)` → 等状态变 `removed`（最多 3s）→ `aria2.removeDownloadResult(gid)`。
`.part` 与 `.part.aria2` 控制文件保留（续传靠它们）。没确认 removed 就是 `failed: 取消未确认`，不假报已取消。

### 并发

dlcore 是唯一调度权威。aria2 只有 `max-concurrent-downloads`，每次 `addUri` 前用
`changeGlobalOption` 把它抬到「本 backend 当前在跑的任务数」，保证 aria2 不会因为自己的队列上限
把某个任务干晾着（否则 dlcore 的停滞监视会误报）。

### 配置

`engine-config.json`：

```json
{ "aria2": { "enabled": false, "bin": "", "port": 6802 } }
```

- 默认 `enabled:false`；**没有这段也一样**（读不到就当关闭）。
- `bin` 空 = 自动探测（PATH → WinGet Links → scoop shims → chocolatey → Program Files）。
  **只缓存找到的结果，不缓存失败**（2026-10-18 修）：探测失败的代价是一次 `where.exe`（毫秒级），
  换来「用户装完立即可用」，不用重启引擎。
- `bin` 显式给了但文件不存在 → 视为不可用（**不静默回落 PATH**，配错要看得见）；
  这类「配错」不进缓存，每次调用稳定返回空。
- 只读：写开关是 W3 的事（`POST /settings` 的 `aria2` 段已做形状归一，`GET /settings` 会回完整默认值）。

### 选择逻辑（`dlcore._selectBackend`）

```
命令型任务 → node-http（防御，正常不会到这）
aria2.enabled=false → node-http
aria2.enabled=true 且 capabilities().available → aria2
否则 → node-http（task.backendNote 记「不可用原因」）
```

选中的名字写进 `task.backend`，`task.backendNote` 记降级原因；两者都进 `snapshot()`、`_persist()`、
`summarizeTask()`（`/list` 与 finished/*.json 可见）。

运行期 aria2 抛 `ARIA2_UNAVAILABLE`（起不来/半路失联）时，**只在一点数据都没写的情况下**降级回
node-http；已经传了字节就如实报错——绝不悄悄换 backend 再报成功。

---

## 三、测试

`tests/unit-aria2.mjs`

- **纯函数段（90 项，任何机器都跑；其中 mock 段在无 aria2c 的机器上自动跳过）**：状态映射（含「complete 不是 done」）、
  进度映射（字符串转数字 / 非法值不产 NaN / 超量夹紧）、错误文案、端口候选、契约校验、
  `deliverPartFile` 的 SHA 不符拒交付、`restore()` 对 aria2 任务不用 `.part` 大小兑现（重启后进度不会变 100%）、
  **capabilities 的可用性判定**（mock 非 aria2 的 RPC 回包 → 必须 `available:false`）、
  **bin 探测失败不缓存**（子进程隔离环境：先空 → 放入 aria2c → 不等待、不重启，立即能找到）。
- **真实链路段（43 项，没装 aria2 自动 skip）**：起本地 HTTP 源 → aria2 backend 下载 → **断言文件 SHA-256
  与源一致**；摘要错误必须 failed 且不交付；中断 → retry → 再断言 SHA 一致；进度单调不减；
  取消不假报完成；两个任务并发都正确；`capabilities().version` 是真实版本号；只关自己的实例。
- `HD_TEST_NO_ARIA2=1 node tests/unit-aria2.mjs` 可强制走 skip 分支（验证 skip 逻辑本身）。

`tests/tools/` 下的取证脚本（**不进套件**，需本机有 aria2 才有意义）：

| 脚本 | 看什么 |
| --- | --- |
| `aria2-evidence.mjs` | 直打 backend：正常下载 / 摘要错误 / 中断→续传 / 开关关闭 / 实例关闭，全部 SHA 对拍 |
| `aria2-cap-squatter-evidence.mjs` | 假服务占住配置端口 → `capabilities()` 必须 `available:false` 且 reason 说清不是 aria2 |
| `aria2-bin-cache-evidence.mjs` | 隔离环境下启动引擎 → 放入 aria2c → **不重启**问 `/aria2/status`，必须立即 `available:true` |
| `aria2-engine-evidence.mjs` | 起真引擎走 HTTP 面：`/settings` 的 aria2 段、`/download` → `/wait` → SHA 对拍、`/list` 的 backend 字段 |
| `aria2-degrade-evidence.mjs` | 降级三条路：bin 配错 / 无 aria2 段 / `enabled:false` → 都落 node-http 且下载正常 |
| `aria2-ports-evidence.mjs` | 6802–6809 全被占用 → `available:false, reason:"端口被占用"`，不抢占、不影响下载 |
| `aria2-concurrency-evidence.mjs` | 两个 aria2 任务同时跑，两边 SHA 都对 |
