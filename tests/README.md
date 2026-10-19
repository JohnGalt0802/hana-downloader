# tests/ — 离线测试

2026-09-20 从 `D:\HanakoWorks\_temp` 回仓。此前这些断言的 import 写死绝对路径，
`_temp` 清一次就全没了；现在它们住在仓库里，跟着代码一起走。

**不依赖网络、不依赖宿主、不启动引擎**——全部本地回环。

## 跑

```powershell
cd D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app
node tests/run-tests.mjs
```

退出码 0 = 全过，1 = 有失败。

## 文件

| 文件 | 覆盖 |
| --- | --- |
| `unit-parsers.mjs` | 输出解析器：winget 阶段/备注、pip、uv、git clone、winget search 表格（含窄表/极窄表/点号干扰）、winget 退出码分类。46 项 |
| `unit-probe.mjs` | winget 下载进度探测：HEAD 跟随重定向取总大小、下载目录文件增长 → received、终态自停、无目录时不炸。10 项 |
| `unit-display.mjs` | `ui/shared/display.js`：阶段/单位表、任务形态判定（兼容快照与任务对象两种形态）、三类进度文案 |
| `unit-download.mjs` | 下载内核端到端：落盘完整性、**SHA-256 校验**（对/错两条路）、**限速**是否真拖慢、记录清理。需要约 8 秒 |
| `unit-queue.mjs` | 并发队列与重试：maxConcurrent 排队与自动放行、放宽上限后立即开跑、失败→重试→成功、在途拒绝重试、排队任务可取消、默认限速套用。需要约 10 秒 |
| `unit-theme.mjs` | 声明式主题数据层：继承合并、校验拒收、DEFAULTS 填满、schema 口径与 theme.json 三腿一致 |
| `unit-cardview.mjs` | `ui/shared/cardview.js`：minimal 主题逐字节回归、golden 冻结快照、缺省第三腿一致性、主题字段落地 |
| `unit-stall.mjs` | 卡滞快照落盘契约（起真引擎）：sessionPath/stallTaskId/stalledAt 带到 App 侧、卡滞中的任务可取消 |
| `unit-stall-notify.mjs` | **卡滞提醒的投递通道（2026-10-19）**：download-file 只建「下载 xxx」宿主任务、不再建「停滞提醒：xxx」；卡滞走 sendCustom 且 `triggerTurn === true`；一轮里两个卡滞只投一次并合并成一条；重试通知仍是 `triggerTurn === false`。假 SDK，不起引擎不联网 |
| `unit-restore.mjs` | **重启恢复的终态补写（2026-10-18）**：`restore()` 把 running/pending 恢复成 interrupted 时必须补写 `finished/<taskId>.json`（否则 App 侧 `settleWhenDone` 空等 30 分钟报假超时）、记录是 `summarizeTask` 形状、重复 restore 幂等、历史终态不被补写、超 1 小时的孤儿终态在 restore 时回收、被消费后「读走即删」。纯离线 |
| `unit-contract.mjs` | **契约兜底（2026-10-18）**：`/list` 摘要字段齐全且与 `snapshot` 同语义、`percent` 口径一致、非 JSON 回包结构化、`displayNameOf` 永不产出 undefined、`stateBadge(undefined)` 不渲染 undefined、`/cancel` 响应形状与消费方一致。起真引擎跑 `/cancel` 与 `/list` |
| `unit-aria2.mjs` | **aria2 backend（2026-10-18 W2）**：backend 契约校验、aria2 状态/进度映射（`complete` 不等于 `done`）、`.part` 交付的内容级校验（SHA 不符拒交付）、`capabilities` 的可用性判定（非 aria2 占端口必须 `available:false`）、**bin 探测失败不缓存**（装完不重启即可用）；**有 aria2 时跑真链路**（本地源 → 下载 → 断言产物 SHA-256 与源一致、中断后重试仍一致）。未装 aria2 自动 skip，不算失败 |
| `unit-platform.mjs` | **平台适配层（2026-10-20 P1-1）**：十组接口契约（`which` 找不到给 `""`、`exe` 加后缀、`spawnOpts` 带 `windowsHide`、`killTree` 对不存在的 pid 返 false 不抛、`reveal` 对不存在路径返 `{ok:false}`、`readSystemProxy` 形状、`homeDir`/`tempDir` 非空、`normalizePath` 比较键、`capabilities` 三键齐全且来自真实探测）；`createPlatform` 拒收非法平台名；**darwin/linux 骨架必须抛「尚未实现」**（不许静默返回假值）。用 `createPlatform("win32")` 注入，不依赖本机平台 |
| `unit-aria2-ui.mjs` | **aria2 开关的三态文案（2026-10-18 W3）**：`aria2StatusText` 的四条出口（检测中 / 未启用 / 已启用·版本·端口 / 已启用但不可用：reason）、version/port 缺省不产脏话、畸形输入不抛不产 undefined，以及显示限制说明 `ARIA2_LIMIT_NOTE` |

## servers/ — 手工验证用的本地下载源

自动测试不用它们；它们是为「在聊天流里造一张卡」准备的现场。
各自起一个进程，然后在会话里让助手下载对应 URL。

| 脚本 | 端口 | 现场 |
| --- | --- | --- |
| `servers/e2e.mjs` | 18999 | 2MB 一次性（最快，用来验完成态卡片） |
| `servers/fast.mjs` | 18932 | 6MB 一次性 |
| `servers/slow.mjs` | 18933 | 6MB @ ≈80KB/s（约 75 秒，用来验「下载慢过 agent 收束」） |
| `servers/stall.mjs` | 47653 | 发 1KB 后静默 150 秒（造卡滞） |
| `servers/stall-recover.mjs` | 18951 | 下到一半停住，等 `POST /trigger-resume` 恢复（造卡滞→恢复） |

```powershell
# 例：起一个卡滞现场
node tests/servers/stall.mjs
# 另开一处恢复现场（可带参数：port totalMB stallFraction）
node tests/servers/stall-recover.mjs 18951 50 0.5
```

## 约定

- 新增的纯逻辑（解析器、展示文案、路径规则）都要在这里有一条断言；
  写不动的（要宿主在场、要 iframe、要真实网络）写进 `docs/踩坑记录.md`，写明成色。
- 测试用的临时目录走 `os.tmpdir()`，跑完自清，不在仓库里留垃圾。
