// tests/unit-capabilities.mjs — 平台能力裁剪（2026-10-20 新增，阶段三）
//
// 三件事，都是派工计划的验收项：
//   P3-1  proxyControl 在非 Windows 关闭：服务端回 unsupported（200，不是 500），UI 不渲染入口
//   P3-2  winget 在非 Windows 不注册：命令 enum 里没有，硬传也被拒且文案说清可用项
//   P3-3  pip/uv 撞 PEP 668：错误文案必须给出 venv 出路，且绝不建议 --break-system-packages
//
// 为什么要单独一套：这三条的共同点是「不该做的事不报错、而是根本不做」。
// 这种「缺席」最容易被后来的改动悄悄补回来（比如有人觉得「回个 500 更直白」），
// 所以要用断言把它钉住。
//
// 本套件不联网、不启引擎（P3-1 的 HTTP 行为用源码断言 + 平台层直调验）。
import fs from "node:fs";
import path from "node:path";
import { createPlatform, platform } from "../engine/platform/index.mjs";

let pass = 0, fail = 0;
function check(name, fn) {
  let ok = false, detail = "";
  try {
    const r = fn();
    ok = r === undefined ? true : !!r;
    if (!ok) detail = " => " + safe(r);
  } catch (e) { ok = false; detail = " => threw " + (e?.message || e); }
  if (ok) pass++;
  else { fail++; console.log("FAIL:", name + detail); }
}
const safe = (x) => { try { return JSON.stringify(x); } catch { return String(x); } };

const root = process.cwd();
const serverSrc = fs.readFileSync(path.join(root, "engine", "server.js"), "utf-8");
const indexSrc = fs.readFileSync(path.join(root, "index.js"), "utf-8");
const dlcoreSrc = fs.readFileSync(path.join(root, "engine", "dlcore.js"), "utf-8");
const managerSrc = fs.readFileSync(path.join(root, "ui", "manager.js"), "utf-8");

// ══ P3-1 · proxyControl 按平台裁剪 ═════════════════════════════════════════
console.log("── P3-1 proxyControl 裁剪 ──");

check("能力表：win32 有 proxyControl，posix 没有", () => {
  return createPlatform("win32").capabilities.proxyControl === true
    && createPlatform("darwin").capabilities.proxyControl === false
    && createPlatform("linux").capabilities.proxyControl === false;
});
check("server 的六个 proxy-control 端点都带能力守卫", () => {
  // 六条路径各自都要有 platform.capabilities.proxyControl 的判断，少一条就是漏窗
  const paths = ["/proxy-control/status", "/proxy-control/scan", "/proxy-control/config",
    "/proxy-control/verify", "/proxy-control/start", "/proxy-control/stop"];
  return paths.every((p) => {
    const i = serverSrc.indexOf(`u.pathname === "${p}"`);
    if (i < 0) return false;
    // 取该端点后 400 字符内是否出现能力判断
    const seg = serverSrc.slice(i, i + 400);
    return /platform\.capabilities\.proxyControl/.test(seg);
  });
});
check("不支持时代理控制回 200 + unsupported（不报错、不 500）", () => {
  // 注意区分两个场景：
  //   · 代理控制端点：平台没这个能力，是「本机就不支持」，回 200 + unsupported 让 UI 静静掤掉；
  //   · winget-install：是「你让我做一件这平台做不到的事」，回 400 并解释可用类型，更直白。
  // 两者都有 unsupported 字段，但状态码不同——这是故意的，不是不一致。
  //
  // 断言方式：不抠字面写法（proxyCtlOff 的签名改过一次），只看它肚子里是不是 send(200。
  if (!/unsupported:\s*true/.test(serverSrc)) return false;
  const i = serverSrc.indexOf("const proxyCtlOff");
  if (i < 0) return false;
  const seg = serverSrc.slice(i, i + 300);
  return /send\(200/.test(seg) && !/send\(4\d\d/.test(seg);
});
check("不支持时的文案说清是平台原因（不是「功能坏了」）", () =>
  /不支持代理启停控制/.test(serverSrc));
check("只影响启停梯子，不影响读系统代理（readSystemProxy 未被守卫拦）", () => {
  // dlcore 里读系统代理那段不应出现 proxyControl 判断
  const i = dlcoreSrc.indexOf("platform.readSystemProxy()");
  return i > 0;
});
check("UI 三入口只在能力不为 false 时渲染（null=未知先显示，waiting 服务端回 unsupported 再拿掉）", () => {
  // 2026-10-20 审查后改：原断言要求「cap.proxyControl 为真才渲染」，但那只在拿到
  // platform 字段时成立；旧引擎配新 UI 拿不到字段时会变成 null，那时该先显示。
  // 真正的契约是「只有确定不支持时不渲染」，不是「确定支持才渲染」。
  const i = managerSrc.indexOf("if (cap.proxyControl !== false)");
  if (i < 0) return false;
  const seg = managerSrc.slice(i, i + 400);
  return /appendChild\(optProxyCtl\)/.test(seg)
    && /appendChild\(optScan\)/.test(seg)
    && /appendChild\(optVerify\)/.test(seg);
});
check("UI 初值是三态里的 null（未知），不是 false（不支持）", () =>
  /var cap = \{[^}]*proxyControl:\s*null/.test(managerSrc));
check("UI 拿到 unsupported 时把三个按钮从 DOM 移除（不是整菜单重渲染）", () => {
  const i = managerSrc.indexOf("d.unsupported");
  if (i < 0) return false;
  const seg = managerSrc.slice(i, i + 400);
  return /\.remove\(\)/.test(seg) && /cap\.proxyControl = false/.test(seg);
});
check("UI 从 /settings 的 platform 字段取能力", () =>
  /data\.platform/.test(managerSrc) && /platform\.proxyControl/.test(managerSrc));

// ══ P3-2 · winget 按平台裁剪 ══════════════════════════════════════════════
console.log("\n── P3-2 winget 裁剪 ──");

check("server /command 对 winget-install 有平台守卫", () => {
  const i = serverSrc.indexOf('kind === "winget-install"');
  if (i < 0) return false;
  const seg = serverSrc.slice(i, i + 700);
  return /capabilities\.pkgManager/.test(seg) && /unsupported:\s*true/.test(seg);
});
check("守卫的拒绝文案给出了可用类型（不只是说「不行」）", () => {
  const i = serverSrc.indexOf("没有 winget");
  if (i < 0) return false;
  const seg = serverSrc.slice(i - 300, i + 400);
  return /git-clone \/ pnpm-install \/ pip-install/.test(seg);
});
check("index.js 的 kind enum 由能力表生成，不是写死四个", () => {
  return /COMMAND_KINDS/.test(indexSrc)
    && /enum:\s*COMMAND_KINDS/.test(indexSrc)
    && !/enum:\s*\[\s*"git-clone",\s*"pnpm-install",\s*"winget-install"/.test(indexSrc);
});
check("index.js 在 execute 里也拦一道（模型可能无视 enum 硬传）", () => {
  return /if \(!COMMAND_KINDS\.includes\(kind\)\)/.test(indexSrc);
});
check("硬传 winget 时的文案提到「当前系统没有 winget」", () =>
  /当前系统（\$\{platform\.name\}）没有 winget/.test(indexSrc));
check("工具描述本身也随平台变（模型看描述就知道别调）", () =>
  /HAS_WINGET\s*\n?\s*\?/.test(indexSrc) && /当前系统不是 Windows，没有 winget/.test(indexSrc));

// ══ P3-3 · PEP 668 ════════════════════════════════════════════════════════
console.log("\n── P3-3 PEP 668 ──");

check("识别 externally-managed-environment", () =>
  /externally-managed-environment|EXTERNALLY-MANAGED/i.test(dlcoreSrc));
check("给出 venv 出路（而不是让用户去关系统保护）", () => {
  const i = dlcoreSrc.indexOf("请改用 venv");
  if (i < 0) return false;
  const seg = dlcoreSrc.slice(i - 200, i + 500);
  return /python -m venv/.test(seg) && /pythonPath/.test(seg);
});
check("**绝不建议 --break-system-packages**（那是持久性损坏）", () => {
  // 允许注释里出现「不给 --break-system-packages」这句解释，禁止出现在参数数组里
  const bad = /args\.push\(\s*["']--break-system-packages["']/.test(dlcoreSrc);
  const bad2 = /["']--break-system-packages["']\s*,/.test(dlcoreSrc);
  return !bad && !bad2;
});
check("summarizeCmdTail 认得 pip 的 error: 行（否则那句提示挂不上去）", () =>
  /\^error:/.test(dlcoreSrc) || /\|error:/.test(dlcoreSrc));

// ══ 四、/settings 回包带 platform（UI 的唯一数据来源）══════════════════════
console.log("\n── /settings 的 platform 字段 ──");

check("server 定义了 platformInfo()", () => /function platformInfo\(\)/.test(serverSrc));
check("GET /settings 回包带 platform", () => {
  const i = serverSrc.indexOf('if (req.method === "GET") {');
  const seg = serverSrc.slice(i, i + 800);
  return /platform:\s*platformInfo\(\)/.test(seg);
});
check("POST /settings 回包也带 platform（改完设置即刷新能力）", () => {
  const cnt = (serverSrc.match(/platform:\s*platformInfo\(\)/g) || []).length;
  return cnt >= 2;
});
check("platformInfo 失败不抛（降级为「什么都没有」）", () => {
  const i = serverSrc.indexOf("function platformInfo()");
  const seg = serverSrc.slice(i, i + 600);
  return /catch/.test(seg) && /proxyControl:\s*false/.test(seg);
});

// ══ 五、本机实测：能力表与真机一致 ═════════════════════════════════════════
console.log("\n── 本机能力实测对照 ──");

check("生产 platform 的 name 与本机一致", () => platform.name === process.platform);
if (process.platform === "win32") {
  check("本机（Windows）proxyControl 为 true", () => platform.capabilities.proxyControl === true);
  check("本机（Windows）pkgManager 真实探测到 winget", () => platform.capabilities.pkgManager === "winget");
} else {
  check("本机（posix）proxyControl 为 false", () => platform.capabilities.proxyControl === false);
}

console.log(`\n=== capabilities: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
