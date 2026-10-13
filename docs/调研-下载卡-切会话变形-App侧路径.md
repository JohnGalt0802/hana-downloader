# 调研：下载卡「切换会话后变形」的 App 侧可能路径

> 范围：仅分析 App 侧代码（ui/card.js、ui/manager.js、index.js、manifest.json、sdk 调用）。
> 不查宿主 bundle 源码（另有负责人）。所有结论附文件+行号+片段；未确认处标 `[未确认]`。
> 关联历史：踩坑记录.md 第 38 条（加载期三合一）、第 44 条（realization/cardForm）、
> `docs/hana-app卡片尺寸与身份反馈.md`（宽度由卡壳定、上报不生效）。

---

## 一、尺寸上报完整链路（Q1）

### 1.1 上报函数 `reportSize(force)` — `ui/card.js:61-73`

```js
function reportSize(force) {
  try {
    const h = measureH();
    if (!force && h === lastReportedH) return;   // 去重：未强制且高度未变→跳过
    lastReportedH = h;
    try { hana.ui?.resize?.({ height: h, width: CARD_WIDTH }); } catch { }
    try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch { }
  } catch { }
}
```

- 两条实际出口：① SDK `hana.ui.resize({height, width:CARD_WIDTH})`；② 顶层 legacy `postMessage('hana.card-resize', height)` 兜底（host 0.970.9 聊天流挂载位只认这条，见 `card.js:40` 注释）。
- **去重键只有高度**：`lastReportedH`（line 59 初值 0），宽度是常量不参与变化判断。`force=true` 时无视去重强制补报。

### 1.2 所有调用点（何时上报）

| # | 调用点 | 代码位置 | force | 触发节奏 |
|---|---|---|---|---|
| A | `ResizeObserver(root)` | `card.js:75-77` | false | 任意 DOM 尺寸变化 |
| B | `bootSettle` 首帧 | `card.js:87` | **true** | 脚本加载 1 次 |
| C | `bootSettle` 定时器 | `card.js:93-99` | **true** | 每 1500ms，最多 6 次（≈9s） |
| D | `bootSettle` resize 监听 | `card.js:90` | **true**（仅 `!adopted()`） | window resize 事件 |
| E | `render()` 末尾 | `card.js:496` | false | 每次 poll（活跃 300ms / 终态 5s） |
| F | 终态强制补报 | `card.js:361-364` | **true** | 终态切换时 `[0,1000,2500]`ms 各 1 次，受 `terminalReported` 守卫只跑一次 |
| G | `applyExpandState()` | `card.js:309` | false | 折叠/展开（用户交互或 BroadcastChannel） |
| H | `renderFail` / `renderHint` | `card.js:523,531` | false | 错误/提示渲染 |
| I | `window load` | `card.js:535` | false | 加载后 60ms 1 次 |

`measureH()`（`card.js:43-57`）：取 `.dl` 的 `offsetHeight` + body 上下 padding，下限 24px。`CARD_WIDTH = 400`（`card.js:41`，2026-09-17 由 450 收窄）。

### 1.3 force 补报的触发点

仅 B / C / D / F 四处：`bootSettle` 首帧与定时器、resize 监听（仅未采纳时）、终态一次性强制补报。除 F 受 `terminalReported` 守卫外，B/C 在每次脚本加载（重挂）时都会重跑。

### 1.4 bootSettle 收敛窗口

- 定时器：`setInterval(..., 1500)`，`n>=6` 时 `clearInterval`（`card.js:92-99`）→ 上限 **≈9s**。
- 提前退出：`if (adopted()) clearInterval(timer)`（`card.js:95`）——宿主一旦「采纳宽度」立即停。
- resize 监听器**不随收敛结束移除**（`card.js:90` 在函数体内注册，IIFE 只清 interval）。

### 1.5 窗口结束后的再上报机制

1. `render()` 末尾 `reportSize(false)`（E）——**但按 `lastReportedH` 去重，高度稳定即 no-op**。
2. `ResizeObserver`（A）——仅当 `#dl-root` 实际尺寸变化才触发，且 `reportSize(false)` 仍按高度去重。
3. 终态一次性 `terminalReported` 补报（F）——**每个 terminal 转换只跑一次**，守卫后再不触发。
4. window resize 监听（D）——仅 `!adopted()` 时 force。
5. 用户折叠/展开（G）、错误/提示（H）、`load`（I）——均为一次性或交互驱动。

> 关键结论：**bootSettle 收敛窗口结束后，对「内容高度稳定」的卡片，周期性强制补报机制基本归零**，只剩「高度真变化才动」的去重上报。`lastReportedH` 记录的是卡片**自己量到的高度**，不是宿主**实际施加的高度**——若宿主丢弃/覆盖上报，卡片无从感知、不会重试（详见 H-D）。

---

## 二、adopted() 是否会在「容器宽≈400」时误判（Q2）

```js
// card.js:85-86
const adopted = () => {
  try { return Math.abs(window.innerWidth - CARD_WIDTH) <= 2; } catch { return true; }
};
```

- `adopted()` 只看 **iframe 的 `window.innerWidth` 是否≈400**（`CARD_WIDTH`）。它**完全不检查高度/上报是否被采纳**。
- 用途：① `card.js:95` 收敛器提前停；② `card.js:90` resize 监听「已采纳就不补报」。

### 误判场景

**场景 A：容器宽恰好≈400（如窄列 348→约 400，或某布局下卡壳宽=400±2）**
- `adopted()` 直接 `true` → 收敛器 tick 1 即 `clearInterval`（`card.js:95`），bootSettle 几乎不补报。
- 此时若首帧/早期那次上报在加载期被宿主丢弃（踩坑 38：宿主通道拥堵会丢），卡片高度永久停在宿主默认值，且**宽度检查给出「已采纳」的假安全感**，**不再有强制补报去拆这扇单向门**（`card.js:66-67` 注释明示此风险，但 adopted 只守宽度不守高度）。
- ⇒ **窄列（≈400）反而比宽列更危险**：宽列 `adopted()=false` 会持续补报到 9s，给宿主采纳留足时间；窄列一上来就收兵。

**场景 B：容器宽远大于 400（如 774 / 1018）**
- `adopted()=false`，收敛器补报到 9s 上限（`card.js:97`）。若 9s 后宿主仍未采纳（信封上限未给到 400），收敛器**放弃**，之后仅靠去重上报——宽度永远停在信封默认宽（撑满聊天流），即踩坑 38 的「撑满」表现。

**切会话导致容器宽变化时的耦合**：切换回来若卡壳宽落到≈400，adopted 误判提前收兵；若落到远>400，则 9s 后放弃。**两种落点都可能停在错误形态**，差别只是「窄且错」还是「宽且错」。

---

## 三、resize 监听器的触发条件与限制（Q3）

| 监听 | 位置 | 守卫 | 重挂是否重走 | 仅隐藏/显示是否触发 |
|---|---|---|---|---|
| card.js `window resize` | `card.js:90` | `if (!adopted())` | 重挂→bootSettle 重跑，监听重新注册 | `[未确认]` 依赖宿主是否在 re-show 派发 resize 事件 |
| manager.js `window resize` | `manager.js:1011` | 无（总是 reportSize） | manager 无 bootSettle，init 时注册一次 | 同上，依赖宿主是否派发 resize |

### 若切换会话导致 iframe **重新挂载**（脚本重跑）
- card.js：bootSettle **完整重走**（首帧 force + 定时器 ≤9s + resize 监听全新注册）。收敛窗口重新计时。
- manager.js：init 重跑，仅 init 时一次 `reportSize()`（`manager.js:1009`）+ resize 监听重新注册。

### 若切换会话只是 **隐藏/显示**（脚本不重跑）
- card.js：bootSettle 的 IIFE **不会再次执行**（其 interval 早已 clear，但 `card.js:90` 的 resize 监听仍在）。**没有周期补报**，只剩：
  - `render()` 的去重上报 E（高度稳定→no-op）；
  - `ResizeObserver` A（仅高度真变才动）；
  - resize 监听 D（**仅当宿主派发 resize 且 `!adopted()`**）。
- manager.js：同样只剩 init 时那一次 + resize 监听。
- **若宿主 re-show 不派发 window resize 事件**（host 行为 `[未确认]`），则 re-show 后**无任何补报路径**，卡片停在宿主 re-show 时施加的默认尺寸。

> 补充：`display:none`/卸载若销毁 JS 上下文→re-show 即重挂（走「重挂」分支）；若仅 visibility 切换或 keep-alive→走「隐藏/显示」分支。两种宿主行为 `[未确认]`，但二者都暴露问题（见 H-C / H-A）。

---

## 四、终态降频（IDLE_MS / schedule）对尺寸上报时效的影响（Q4）

```js
// card.js:160-162
var FAST_MS = 300;   // 活跃期
var IDLE_MS = 5000;  // 终态后慢查
// card.js:195
schedule(FINAL_STATES[t.state] ? IDLE_MS : FAST_MS);
```

- 终态后 `poll()` 每 5s 跑一次，`render()` 末尾 `reportSize()`（E，force=false）。
- **去重使稳态补报失效**：终态卡片内容高度稳定 → `measureH()` 返回值恒定 → `h === lastReportedH` → `reportSize(false)` 在 `card.js:68` 直接 `return`，**不真发消息**。
- **终态强制补报是一次性的**：`terminalReported` 守卫（`card.js:60`）+ `[0,1000,2500]`（`card.js:361-364`）只在「进入终态」那一刻跑一次；若这三次本身在加载期被宿主丢弃（踩坑 38），之后**再无强制补报**。
- `ResizeObserver` 同理：内容高度不变则 `.dl`/`#dl-root` 尺寸不变 → 不触发。

**结论**：**会，且影响显著**。终态卡片在两扇「强制补报」门（bootSettle + terminal 一次性）过后，若高度稳定，**稳态上报频率有效为 0**；一旦宿主在 re-show 时把尺寸重置为默认（撑满/变高），卡片**不会自愈**——除非用户主动折叠/展开（G 触发 `reportSize`）或宿主派发 resize 且 `!adopted()`（D）。这正是「切会话回来又变形」的最合理解释。

---

## 五、「切会话回来变形」App 侧全部可能路径（Q5）

> 每条：假设 → 代码位置 → 验证方法。按可能性从高到低排序。

### H-A（最高可能·根因候选）：终态/idle 卡片在 re-show 后失去强制补报，停在宿主默认尺寸

- **假设**：下载完成进入终态后，卡片靠 `IDLE_MS` 慢查存活。切会话回来时，宿主对 re-show 的 iframe 施加默认尺寸（撑满聊天流/变高）；而 App 侧此时仅剩「去重后 no-op」的稳态上报，bootSettle 强制补报已结束、terminal 一次性补报可能已在加载期被丢（踩坑 38），故**无机制重新上报正确尺寸**，卡片永久变形直到用户交互。
- **代码位置**：去重 `card.js:68`；终态降频 `card.js:161,195`；terminal 一次性补报 `card.js:60,361-364`；bootSettle 一次性 `card.js:83-99`；`lastReportedH` 只记录卡片自己量的高度（`card.js:59,70`）。
- **验证方法**：
  1. 复现：发起下载→等进入终态→切到另一会话→切回，观察卡片形态。
  2. 在 `card.js` 的 `reportSize` 内临时埋点：`console.log('POST', force, h, lastReportedH)` vs `console.log('SKIP', h)`，统计 re-show 后 30s 内真实 POST 次数（预期≈0）。
  3. 查 `app-card-activity/*.jsonl` 中 `name:"diag"` 时间戳（踩坑 38 判据）：若停在 re-show 之前某刻，说明当时通道堵、上报被丢。
  4. 对比 iframe `window.innerWidth`/`measureH()` 量值与宿主信封 `envW.max`（踩坑 38 公式 `实际宽=min(想要,信封上限)-1`）。

### H-B（高）：re-show 为「隐藏/显示」而非「重挂」时，bootSettle 不重跑、resize 监听是唯一补报，若宿主不派发 resize 则零补报

- **假设**：宿主在切会话时**不销毁 iframe 上下文**而只是隐藏/再显示。bootSettle IIFE 不重跑（interval 早已清），仅 `card.js:90` 的 resize 监听存活；若宿主 re-show 不派发 `window resize` 事件（host 行为 `[未确认]`），则 re-show 后**完全没有补报**，卡片停在 re-show 默认尺寸。
- **代码位置**：bootSettle 仅清 interval 不清监听 `card.js:90,97`；render 去重 no-op `card.js:68,496`；ResizeObserver 仅高度变化触发 `card.js:75-77`。
- **验证方法**：
  1. 在 `card.js:90` 与 `card.js:93` 埋计数器，切会话前后打印 `resizeFired` / `bootTick` 次数。
  2. 确认宿主对 re-show 是否派发 `resize`（`[未确认]`：可在 iframe 内 `window.addEventListener('resize', ()=>console.log('RS'))` 实测）。
  3. 若 `resizeFired===0` 且卡片变形→坐实本路径。

### H-C（中）：adopted() 在容器宽≈400 时误判「已采纳」，提前收兵漏掉被丢上报

- **假设**：切回后卡壳宽恰好≈400（窄列/某布局），`adopted()` 返回 true→收敛器 tick1 即 `clearInterval`（`card.js:95`），不再补报；若该早期上报被丢，卡片停错且**宽度检查误判为已采纳**，不再重试。
- **代码位置**：`card.js:85-86,95`。
- **验证方法**：
  1. 把宿主窗口调到让聊天卡列≈400px；触发 re-mount；打印每 tick 的 `adopted()` 与 `clearInterval` 时刻、是否 `POST`。
  2. 若 tick1 即收兵且此时高度上报被丢（对照 H-A 的 diag 时间戳）→坐实。
  3. 写静态断言：re-mount 后 `window.innerWidth` 落入 `[398,402]` 时观察收敛行为。

### H-D（中）：manager 卡无 bootSettle 强制收敛，仅靠 init 一次 + resize 监听

- **假设**：管理器卡（`manifest.json` realization=card）的 `reportSize`（`manager.js:103-113`）**没有 bootSettle、没有 terminal 强制补报、没有 ResizeObserver**，只在 init 时调用一次（`manager.js:1009`）+ `window resize` 监听（`manager.js:1011`）。切会话 re-show 若无 resize 事件，管理器卡也停在默认尺寸。
- **代码位置**：`manager.js:103-113,1009,1011`；对照 card.js 的 bootSettle（`card.js:83-99`）。
- **验证方法**：
  1. 打开管理器卡→切会话→切回，观察管理器卡形态是否也变形。
  2. 在 `manager.js` init 与 resize 监听处埋点，统计 re-show 后真实 POST 次数。
  3. 与 card.js 行为对照，确认 manager 侧缺少强制收敛兜底。

### H-E（中·部署类，非逻辑 bug）：运行副本与开发目录不一致导致通道版本错配（尺寸失控假象）

- **假设**：若近期只改了 `ui/*.js` 未同步运行副本 `C:\Users\John Galt\.hanako\apps\hana-downloader\` 或未重启宿主，则卡片与宿主消息通道版本错配，表现为「尺寸失控/切会话变形」假象（文档一之再补「改 ui/ 任何文件后必须重启宿主再验收」；踩坑 19；`docs/改动生效范围.md`）。
- **代码位置**：`docs/改动生效范围.md` 对照表；踩坑 19；`hana-app卡片尺寸与身份反馈.md` 一之再补。
- **验证方法**：
  1. 比对哈希：`Get-FileHash` 比较 `D:\HanakoWorks\HanaAgentAPPs\hana-downloader-app\ui\card.js` 与 `C:\Users\John Galt\.hanako\apps\hana-downloader\ui\card.js`。
  2. 查宿主日志 `renderer.log`：通道错配典型现象为 `msg0`（收不到任何宿主消息）、request 8s 超时、`hana.track` 超时（踩坑 38）。

### H-F（低·App 无法修复）：宽度由卡壳定，App 上报不生效，re-show 后无重报宽度机制

- **假设**：实际宽度 = `min(CARD_WIDTH=400, 信封上限) - 1`（踩坑 38 / 文档一之再补）。卡片 `reportSize` 虽传 `width:CARD_WIDTH`，但宽度上报通道在聊天流挂载位不生效（resize 桥只认 height，见 `hana-app卡片尺寸与身份反馈.md` 一/一之补）。切会话后若宿主信封上限变化而 iframe 未重挂，卡片**无机制重申宽度**。
- **代码位置**：`card.js:70`（width 常量）、`card.js:40` 注释（legacy 只报 height）、`index.js:661,922`（`preferredWidthPx:400`）。
- **验证方法**：
  1. re-show 前后（不重载）量 `window.innerWidth`；查 diag 记录的 `envW.max`。
  2. 确认 `postMessage` 的 width 是否被宿主采纳（需宿主侧确认，`[未确认]`）。

---

## 六、可能性排序与根因判断

| 排序 | 假设 | 性质 |
|---|---|---|
| 1 | **H-A**：终态/idle 卡片 re-show 后强制补报门已闭、稳态上报被去重成 no-op → 停错不自愈 | 逻辑缺陷（最可能是根因） |
| 2 | **H-B**：re-show 为隐藏/显示而非重挂，bootSettle 不重跑，resize 监听+去重上报均失效 | 逻辑缺陷 |
| 3 | **H-C**：adopted() 在容器≈400 时误判提前收兵 | 逻辑缺陷（放大 H-A/B） |
| 4 | **H-D**：manager 卡缺 bootSettle 兜底 | 逻辑缺陷 |
| 5 | **H-E**：副本/目录不一致导致通道错配假象 | 部署纪律 |
| 6 | **H-F**：宽度宿主定、App 无法重报 | App 无能为力（宿主侧） |

**最可能根因**：**H-A（叠加 H-C）**。终态卡片在 bootSettle 与一次性 terminal 补报两扇强制门过后，稳态只剩按 `lastReportedH` 去重的 `reportSize(false)`，内容高度不变即 no-op；切会话 re-show 时宿主若重置默认尺寸（踩坑 38 加载期丢上报的同机理），App 侧**没有任何后续强制补报**去纠正——窄列（≈400）还会因 `adopted()` 误判让 bootSettle 提前收兵（H-C），进一步压缩唯一能补救的窗口。验证优先看 H-A 的埋点与 `app-card-activity` diag 时间戳。

---

## 七、给修复方向的提示（仅列，不实施）

> 以下为后续可验证的修复思路，本调研不修改任何代码。

1. **去重键应感知「宿主是否真的采纳」**，而非只记卡片自己量的高度；或 render 末尾的 `reportSize(false)` 改为对「终态/疑似未采纳」场景定期 force（打破 no-op 死锁）。
2. **bootSettle 收敛不应被 `adopted()` 宽度误判提前终止**；或 adopted 同时校验高度信道健康。
3. **re-show / visibilitychange 补报**：监听 `document.visibilitychange` 或宿主 surface 事件，re-show 时强制补报几轮（类比 terminal 一次性补报）。
4. **manager 卡补齐 bootSettle / ResizeObserver 兜底**（与 card.js 对齐）。
5. 部署纪律：每次改 `ui/*` 后同步运行副本并重启验收（H-E）。
