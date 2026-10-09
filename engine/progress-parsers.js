// lib/progress-parsers.js — 命令型任务的输出行解析器（纯函数）
// git clone / pnpm install 的 stdout/stderr 行 → 进度数据。
// 每行输入（已剥 \r）→ { stage, received, total, unit, pct, message } 或 null。
//
// - git clone：进度在 stderr，对象计数天然是 received/total，无状态
// - pnpm install：进度在 stdout，\r 重绘每秒多次，必须状态化（同 stage 取最新，received 直接赋值不累加）

const GIT_CLONING = /Cloning into\s+'([^']+)'/;
const GIT_ENUM = /remote:\s+Enumerating objects:\s+(\d+)/;
const GIT_RECEIVING = /Receiving objects:\s+(\d+)%\s*\((\d+)\/(\d+)\)/;
const GIT_DELTAS = /Resolving deltas:\s+(\d+)%\s*\((\d+)\/(\d+)\)/;
const GIT_UPDATING = /Updating files:\s+(\d+)%\s*\((\d+)\/(\d+)\)/;

export function parseGitLine(line) {
  if (!line) return null;
  let m;
  if ((m = line.match(GIT_CLONING))) return { stage: "cloning", pct: 0, message: "准备克隆" };
  if ((m = line.match(GIT_ENUM))) return { stage: "enumerating", message: `枚举对象 ${m[1]}` };
  if ((m = line.match(GIT_RECEIVING)))
    return { stage: "receiving", received: +m[2], total: +m[3], unit: "objects", pct: +m[1], message: `接收对象 ${m[2]}/${m[3]}` };
  if ((m = line.match(GIT_DELTAS)))
    return { stage: "resolving", received: +m[2], total: +m[3], unit: "objects", pct: +m[1], message: `解析增量 ${m[1]}%` };
  if ((m = line.match(GIT_UPDATING)))
    return { stage: "checkout", received: +m[2], total: +m[3], unit: "files", pct: +m[1], message: `检出文件 ${m[2]}/${m[3]}` };
  return null;
}

// pnpm 11.21.0 实测（2026-09-19，管道模式）：
//   Progress: resolved 31, reused 12, downloaded 19, added 0
// 逐行输出（无 \r 重绘），且**常见输出里没有 `Packages: +N`**——总包数不可知。
// 所以这里不再用常量分母伪造百分比：分母未知就不给 total / pct，只报真实计数。
const PNPM_PROGRESS = /Progress:\s+resolved\s+(\d+),\s+reused\s+(\d+),\s+downloaded\s+(\d+),\s+added\s+(\d+)/;
const PNPM_PACKAGES = /Packages:\s+\+(\d+)/; // 部分版本/场景才有，一旦出现就当作总包数
const PNPM_BUILD = /postinstall\$/;
const PNPM_BAS_DONE = /Done in\s+(?:(\d+(?:\.\d+)?)m\s+)?(\d+(?:\.\d+)?)s/;

export function createPnpmParser() {
  let total = null; // 总包数：只有 pnpm 明确给出 Packages: +N 时才知道
  let received = 0; // 已落地包数（解析 → 下载 → 安装，取推进最远的一档）
  return function (line) {
    if (!line) return null;
    let m;
    if ((m = line.match(PNPM_PACKAGES))) { total = +m[1]; return null; }
    if ((m = line.match(PNPM_PROGRESS))) {
      const resolved = +m[1], downloaded = +m[3], added = +m[4];
      const stage = added > 0 ? "linking" : (downloaded > 0 ? "fetching" : "resolving-deps");
      // received 单调推进：已安装 > 已下载 > 已解析；同一 stage 只取最新，不累加
      received = Math.max(received, added > 0 ? added : (downloaded > 0 ? downloaded : resolved));
      const out = {
        stage, unit: "packages", received,
        detail: `解析 ${resolved} · 下载 ${downloaded} · 已装 ${added}`,
      };
      if (total) {
        out.total = total;
        out.pct = Math.min(100, Math.round((received / total) * 1000) / 10);
      }
      return out;
    }
    if (PNPM_BUILD.test(line)) return { stage: "building", unit: "packages", received, detail: "编译原生模块（postinstall）" };
    if ((m = line.match(PNPM_BAS_DONE))) {
      if (total) return { stage: "finalizing", unit: "packages", received: total, total, pct: 100, detail: "收尾" };
      return { stage: "finalizing", unit: "packages", received, detail: "收尾" };
    }
    return null;
  };
}

// ══════════════════════════════════════════════════════════════════════════
// winget / pip 链路解析器（2026-09-18 实机取证）
// 与 git/pnpm 的差异：两条链路都是阶段式输出（管道模式下没有进度条、没有字节数），
// 解析器只推进 stage / 文案，不做百分比伪造（received/total 保持缺省）。
// ══════════════════════════════════════════════════════════════════════════

// ── winget（v1.29 实测，中文系统）──
// 输出样例（jqlang.jq，全程约 5.9s，stdout，UTF-8）：
//   已找到 jq [jqlang.jq] 版本 1.8.2
//   正在下载 https://github.com/jqlang/jq/releases/download/...
//   已成功验证安装程序哈希
//   正在启动程序包安装...
//   已修改路径环境变量；重启 shell 以使用新值。
//   添加了命令行别名： "jq"
//   已成功安装
// 已安装场景：找到已安装的现有包。正在尝试升级已安装的包... / 找不到可用的升级。 / 配置的源中没有可用的较新的包版本。
// 英文串来自 winget-cli 源码资源（src/AppInstallerCLIPackage/Shared/Strings/en-us/winget.resw），
// 本机中文环境未实测英文输出，作为备用匹配保留。
const WG_FOUND = /^已找到\s+(.+?)\s*\[([^\]]+)\]\s*版本\s*(\S+)/;
const WG_FOUND_EN = /^Found\s+(.+?)\s*\[([^\]]+)\]\s*Version\s*(\S+)/;
const WG_DOWNLOADING = /^正在下载\s+(\S+)/;
const WG_DOWNLOADING_EN = /^Downloading\s+(\S+)/;

// meta 键约定：非任务核心字段的派生信息，由 dlcore 的 feed 浅合并进任务对象
// （pkgName/pkgVersion 供卡片与结算文案使用）。
export function createWingetParser() {
  return function (line) {
    if (!line) return null;
    let m;
    if ((m = line.match(WG_FOUND)) || (m = line.match(WG_FOUND_EN))) {
      const name = m[1].trim();
      return {
        stage: "found",
        message: `已找到 ${name} ${m[3]}`,
        meta: { pkgName: name, pkgId: m[2], pkgVersion: m[3] },
      };
    }
    if (/^找到已安装的现有包|^Found an existing package already installed/.test(line)) {
      return { stage: "found", message: "检测到已安装，尝试升级", meta: { upgrading: true } };
    }
    if ((m = line.match(WG_DOWNLOADING)) || (m = line.match(WG_DOWNLOADING_EN))) {
      return { stage: "downloading", message: "下载安装包", meta: { installUrl: m[1] } };
    }
    if (/^已成功验证安装程序哈希|^Successfully verified installer hash/.test(line)) {
      return { stage: "verifying", message: "哈希校验通过" };
    }
    if (/^正在启动程序包安装|^Starting package install/.test(line)) {
      return { stage: "installing", message: "安装中" };
    }
    if (/^已修改路径环境变量|^Path environment variable modified/.test(line)) {
      return { stage: "installing", message: "PATH 已更新，重启 shell 后生效", note: "PATH 已更新，重启 shell 后生效" };
    }
    if (/^添加了命令行别名|^Command line alias added/.test(line)) {
      return { stage: "installing", message: "已添加命令别名", note: line.trim() };
    }
    if (/^已成功安装|^Successfully installed/.test(line)) {
      return { stage: "finalizing", message: "安装完成" };
    }
    if (/^找不到可用的升级|^No available upgrade found/.test(line)) {
      return { stage: "finalizing", message: "无可用升级" };
    }
    return null;
  };
}

// ── brew（macOS；Windows 上 winget 的对应物）──
// brew 输出（stdout+stderr 混合，英文，与系统语言无关），阶段式、无字节进度：
//   ==> Downloading https://.../foo--1.2.tar.gz
//   ==> Fetching dependencies for foo: bar
//   ==> Installing dependencies for foo: bar
//   ==> Pouring foo--1.2.arm64_sonoma.bottle.tar.gz
//   ==> Caveats
//   ==> Summary
//   🍺  /opt/homebrew/Cellar/foo/1.2: 5 files, 1.2MB
// 已安装且最新：Warning: foo 1.2 is already installed and up-to-date.
const BREW_DOWNLOADING = /^==>\s+Downloading\s+(\S+)/;
const BREW_FETCHING = /^==>\s+Fetching\s+/;
const BREW_INSTALLING_DEPS = /^==>\s+Installing dependencies for\s+(.+?):/;
const BREW_POURING = /^==>\s+Pouring\s+(\S+)/;
const BREW_INSTALLING = /^==>\s+Installing\s+(\S+)/;
const BREW_CAVEATS = /^==>\s+Caveats/;
const BREW_SUMMARY = /^==>\s+Summary/;
const BREW_DONE = /^🍺\s+/;
const BREW_ALREADY = /already installed and up-to-date|is already installed/i;

export function createBrewParser() {
  return function (line) {
    if (!line) return null;
    let m;
    if ((m = line.match(BREW_DOWNLOADING))) return { stage: "downloading", message: `下载 ${m[1]}`, meta: { installUrl: m[1] } };
    if (BREW_FETCHING.test(line)) return { stage: "downloading", message: "获取依赖" };
    if ((m = line.match(BREW_INSTALLING_DEPS))) return { stage: "installing", message: `安装依赖 ${m[1]}` };
    if ((m = line.match(BREW_POURING))) return { stage: "installing", message: "解包安装" };
    if ((m = line.match(BREW_INSTALLING))) return { stage: "installing", message: `安装 ${m[1]}` };
    if (BREW_CAVEATS.test(line)) return { stage: "finalizing", message: "读取说明（Caveats）" };
    if (BREW_SUMMARY.test(line)) return { stage: "finalizing", message: "生成摘要" };
    if (BREW_DONE.test(line)) return { stage: "finalizing", message: "安装完成", note: line.replace(/^🍺\s*/, "").trim() };
    if (BREW_ALREADY.test(line)) return { stage: "finalizing", message: "已安装（最新）", note: "已安装且最新" };
    return null;
  };
}

// ── pip（26.0 实测，英文输出不随系统语言）──
// 输出样例（venv 内安装 six，stdout）：
//   Collecting six
//     Downloading six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)
//   Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)
//   Installing collected packages: six
//   Successfully installed six-1.17.0
// 已安装场景：Requirement already satisfied: six in ... (1.17.0)
// 注意：feed 已按 [\r\n]+ 拆行并 trim，缩进两格的 metadata 行与普通行前缀相同，靠 .metadata 后缀区分。
const PIP_COLLECTING = /^Collecting\s+(\S+)/;
const PIP_METADATA = /^Downloading\s+(\S+\.metadata)\s/;
const PIP_DOWNLOADING = /^Downloading\s+(\S+)\s+\(([^)]+)\)/;
const PIP_INSTALLING = /^Installing collected packages:\s*(.+)$/;
const PIP_SUCCESS = /^Successfully installed\s+(.+)$/;
const PIP_SATISFIED = /^Requirement already satisfied:\s*(\S+)\s+in\s+.+?\(([^)]+)\)\s*$/;

export function createPipParser() {
  let collected = 0;
  return function (line) {
    if (!line) return null;
    let m;
    if ((m = line.match(PIP_COLLECTING))) {
      collected += 1;
      return { stage: "collecting", message: `解析 ${m[1]}`, meta: { pkgCount: collected } };
    }
    if (PIP_METADATA.test(line)) {
      return { stage: "collecting", message: "获取元数据" };
    }
    if ((m = line.match(PIP_DOWNLOADING))) {
      return { stage: "downloading", message: `下载 ${m[1]}`, meta: { currentFile: m[1], currentSize: m[2] } };
    }
    if ((m = line.match(PIP_INSTALLING))) {
      return { stage: "installing", message: "安装中", meta: { installList: m[1].trim() } };
    }
    if ((m = line.match(PIP_SUCCESS))) {
      return { stage: "finalizing", message: "安装完成", note: `已安装 ${m[1].trim()}`, meta: { installed: m[1].trim() } };
    }
    if ((m = line.match(PIP_SATISFIED))) {
      return { stage: "finalizing", message: "依赖已满足", note: `${m[1]} ${m[2]} 依赖已满足`, meta: { alreadySatisfied: true } };
    }
    return null;
  };
}

// ── uv（0.11 实测；输出在 **stderr**，dlcore 的 feed 对 stdout/stderr 等处理）──
//   Using Python 3.12.13 environment at: ...
//   Resolved 1 package in 1.43s
//   Installed 1 package in 24ms
//    + six==1.17.0
const UV_ENV = /^Using Python .+ environment at:/;
const UV_RESOLVED = /^Resolved\s+(\d+)\s+packages?\s+in\s+/;
const UV_INSTALLED = /^Installed\s+(\d+)\s+packages?\s+in\s+/;
const UV_CHECKED = /^(?:Checked|Audited)\s+(\d+)\s+packages?\s+in\s+/;
const UV_PKG = /^\+\s+(\S+)==(\S+)$/;

export function createUvParser() {
  let resolvedCount = null;
  return function (line) {
    if (!line) return null;
    let m;
    if (UV_ENV.test(line)) {
      return { stage: "collecting", message: "定位 Python 环境" };
    }
    if ((m = line.match(UV_RESOLVED))) {
      resolvedCount = +m[1];
      return { stage: "downloading", message: `解析完成（${m[1]} 个包）`, meta: { pkgCount: resolvedCount } };
    }
    if ((m = line.match(UV_INSTALLED))) {
      return { stage: "installing", message: `安装完成（${m[1]} 个包）` };
    }
    // 已安装且无变更：uv 输出 Checked/Audited 行，没有实际安装动作（实测 0.11）
    if ((m = line.match(UV_CHECKED))) {
      return { stage: "finalizing", message: `已是最新（${m[1]} 个包）`, note: `依赖已是最新（${m[1]} 个包）` };
    }
    if ((m = line.match(UV_PKG))) {
      return { stage: "finalizing", message: `安装 ${m[1]}`, note: `已安装 ${m[1]} ${m[2]}`, meta: { installed: `${m[1]}==${m[2]}` } };
    }
    return null;
  };
}

// ── winget 退出码分类（HRESULT 风格 0x8A15xxxx；Node 以无符号数返回，先 >>> 0 归一）──
// 码表来源：winget-cli/doc/windows/package-manager/winget/returnCodes.md（2026-05 版）+
// 本机实测（0x8A150014 找不到包 / 0x8A15002B 无可用升级）。
// 返回 { state, note?, error? }；未知码返回 null，由 _runCommand 走通用失败分支（附 hex）。
export function classifyWingetExit(rawCode) {
  const code = Number(rawCode) >>> 0;
  switch (code) {
    case 0x00000000: return { state: "done" };
    case 0x8A15002B: return { state: "done", note: "无可用更新" };          // UPDATE_NOT_APPLICABLE（已安装且最新）
    case 0x8A15010D: return { state: "done", note: "系统中已有其他版本" };   // INSTALL_ALREADY_INSTALLED
    case 0x8A150109: return { state: "done", note: "需要重启系统完成安装" }; // REBOOT_REQUIRED_TO_FINISH
    case 0x8A15010B: return { state: "done", note: "系统将重启以完成安装" }; // REBOOT_INITIATED
    case 0x8A15010C: return { state: "canceled", error: "安装被取消" };      // CANCELLED_BY_USER
    case 0x8A150014: return { state: "failed", error: "winget 未找到匹配的包" };
    case 0x8A150016: return { state: "failed", error: "匹配到多个包，请用完整 ID 重试" };
    case 0x8A150019: return { state: "failed", error: "该操作需要管理员权限" };
    case 0x8A150008: return { state: "failed", error: "安装包下载失败" };
    case 0x8A150107: return { state: "failed", error: "无网络连接" };
    case 0x8A150105: return { state: "failed", error: "磁盘空间不足" };
    case 0x8A150102: return { state: "failed", error: "已有其他安装在进行中" };
    case 0x8A15010A: return { state: "failed", error: "需先重启系统再重新安装" };
    // WinINet / 网络层错误（winget 下载失败时直接抛出的底层码，2026-09-18 实测 0x80072EE2）
    case 0x80072EE2: return { state: "failed", error: "下载超时，无法连接下载服务器" };
    case 0x80072EFD: return { state: "failed", error: "无法连接下载服务器" };
    case 0x80072EE7: return { state: "failed", error: "下载服务器域名解析失败" };
    default: return null;
  }
}

// ── winget search 表格解析（/command 的候选流程用）──
// 实机输出列宽随内容自适应，间距可能复杂多变：
//   A) 宽表（多结果、带匹配理由）：名称  ID  版本  匹配  源
//   B) 窄表（单结果/精确命中）：列间缩成 1 空格，且“名称与 ID 之间也可能是 1 空格”：
//        名称               ID                           版本       源
//        ------------------------------------------------------------------
//        Sysinternals Suite Microsoft.Sysinternals.Suite 2026-07-09 winget
// 由于分隔空格数不可靠，改为 **ID token 锚定**：行内 token 化（空白分隔），
// 从右往左找第一个“像 ID 的 token”（含字母、含点、无其它杂字符——纯数字版本号
// 与日期版本如 2026-07-09 自然被排除）。ID 之前拼为名称，之后的 token 含数字则当版本。
// 取“最后一个”而非第一个：名称里可能自带像 ID 的 token（如 Node.js），真 ID 更靠后。
const WG_ID_LIKE = /^[A-Za-z0-9][A-Za-z0-9._+~-]*$/;
function isWingetIdToken(tok) {
  if (!tok || tok.length < 3) return false;
  if (!WG_ID_LIKE.test(tok)) return false;
  if (!tok.includes(".")) return false;
  if (!/[A-Za-z]/.test(tok)) return false;      // 排除纯版本号形态（如 1.8.2）
  if (!/\.[A-Za-z0-9]/.test(tok)) return false; // 点后要有内容（排除尾部怪点）
  return true;
}

export function parseWingetSearch(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  let inTable = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!inTable) {
      if (/^[-\u2500\u2014]{10,}$/.test(line.trim())) inTable = true;
      continue;
    }
    if (!line.trim()) continue;
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) continue;
    let idIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (isWingetIdToken(tokens[i])) { idIdx = i; break; }
    }
    if (idIdx <= 0) continue; // 找不到 ID，或 ID 在行首（缺名称，视为坏行）
    const name = tokens.slice(0, idIdx).join(" ");
    const id = tokens[idIdx];
    const next = tokens[idIdx + 1];
    const version = next && /\d/.test(next) ? next : "";
    out.push({ name, id, version });
  }
  return out;
}
