// tests/unit-cardview.mjs — 聊天流卡片标记生成（ui/shared/cardview.js）
//
// 覆盖 2026-10-12 重设计的核心契约：
//   1. 文件名是主实体（不再被 URL 顶掉）
//   2. 格式徽章按扩展名分类
//   3. 状态标签是唯一状态信号；不再输出折叠/全选/详情表
//   4. 进度条：完成态不画，进行中才画
//   5. 动作按钮按状态给最少的必要项
// 纯函数测试，不碰 DOM、不依赖网络。
import { renderCardHTML, fileKind, fmtBytes, fmtDuration } from "../ui/shared/cardview.js";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
}
const has = (html, s) => html.includes(s);

console.log("── fileKind：按扩展名分类 ──");
check("zip → archive", fileKind("a.zip").kind === "archive" && fileKind("a.zip").ext === "ZIP");
check("exe → exe", fileKind("Setup-2.0.exe").kind === "exe");
check("safetensors → model", fileKind("w.safetensors").kind === "model");
check("长扩展名不硬截（角标留空，给 title）", fileKind("w.safetensors").ext === "" && fileKind("w.safetensors").fullExt === "SAFETENSORS");
check("png → img", fileKind("x.PNG").kind === "img");
check("无扩展名 → file + FILE 标注", fileKind("LICENSE").kind === "file" && fileKind("LICENSE").ext === "FILE");
check("大小写不敏感", fileKind("A.ZIP").kind === "archive");

console.log("── fmtBytes / fmtDuration ──");
check("1023B", fmtBytes(1023) === "1023B");
check("1KB", fmtBytes(1024) === "1.00KB");
check("1MB", fmtBytes(1048576) === "1.00MB");
check("24.8MB", /^24\.8MB$/.test(fmtBytes(26004684)));
check("null → —", fmtBytes(null) === "—");
check("30s", fmtDuration(30) === "30s");
check("2m", fmtDuration(120) === "2m");
check("1.0h", fmtDuration(3600) === "1.0h");
check("0/负 → 空", fmtDuration(0) === "" && fmtDuration(-5) === "");

const RUNNING = {
  taskId: "t1", state: "running", fileName: "openhanako-v1.1.4-win-x64.zip",
  url: "https://github.com/x/y/releases/download/v1.1.4/openhanako-v1.1.4-win-x64.zip",
  filePath: "D:\\d\\openhanako-v1.1.4-win-x64.zip",
  total: 26004684, received: 17683184, speed: 3355443, percent: 68, unit: "bytes",
  stageDetail: "aria2 传输中 · 16 连接",
};
const DONE = { ...RUNNING, state: "done", received: 26004684, speed: 0, percent: 100, note: null };
const FAILED = { ...RUNNING, state: "interrupted", error: "请求被中止\n连接超时", percent: 25 };
const PKG = { taskId: "t4", state: "running", kind: "command", cmdType: "winget-install", fileName: "jq 1.8.2", unit: "steps", total: null, received: 0, speed: 0, percent: null, stage: "download" };

console.log("── 主实体：文件名（不被 URL 顶掉）──");
{
  const h = renderCardHTML(RUNNING);
  check("显示文件名", has(h, "openhanako-v1.1.4-win-x64.zip"));
  check("文件名带 title（悬停看全）", has(h, 'title="openhanako-v1.1.4-win-x64.zip"'));
  check("URL 不出现在卡片主体（不再抢首行）", !has(h, "https://github.com/x/y"));
}

console.log("── 格式徽章 ──");
{
  const h = renderCardHTML(DONE);
  check("archive 类徽章", has(h, "k-archive"));
  check("角标显示 ZIP", has(h, 'class="dl-badge-ext"') && has(h, "ZIP"));
  check("含 SVG 图标", has(h, "<svg"));
  check("图标是完整 svg 元素（裸 path 不渲染）", /<svg[^>]*><path/.test(h));
}

console.log("── 状态标签：唯一状态信号 ──");
{
  check("进行中给出百分比", has(renderCardHTML(RUNNING), "68%"));
  check("完成给「已完成」", has(renderCardHTML(DONE), "已完成"));
  check("失败给「已中断」", has(renderCardHTML(FAILED), "已中断"));
  const h = renderCardHTML(RUNNING);
  // 旧版的三处冗余：不再有独立的 pct/size/speed 三个 span，也不再有 badge
  check("不再输出旧 .dl-badge", !has(h, 'class="dl-badge b-'));
  check("不再输出 .dl-pct / .dl-size / .dl-speed 三件套", !has(h, "dl-pct") && !has(h, "dl-size") && !has(h, "dl-speed"));
}

console.log("── 折叠/全选/详情表：全部清除 ──");
{
  const h = renderCardHTML(DONE);
  check("无折叠按钮 dl-fold", !has(h, 'id="dl-fold"'));
  check("无全选框 dl-all", !has(h, "dl-all"));
  check("无详情面板 dl-detail", !has(h, "dl-detail"));
  check("无任务 ID 泄露行", !has(h, "dl-d-row"));
  check("无「文件/路径/操作/任务/状态」键值表", !has(h, "dl-d-label"));
}

console.log("── 副行：体积 / 速度 / 剩余 / 原因 ──");
{
  const r = renderCardHTML(RUNNING);
  check("进行中显示 已下载/总量", has(r, "16.9MB") && has(r, "24.8MB") && has(r, "/"));
  check("进行中显示速度", has(r, "3.20MB/s"));
  check("进行中显示剩余时间", has(r, "剩"));
  // 阶段明细不再进副行（占半行、显挤）；改用体积·速度·剩余
  check("进行中不再显示阶段明细", !has(r, "aria2 传输中"));
  const d = renderCardHTML(DONE);
  check("完成显示总体积", has(d, "24.8MB"));
  check("完成显示来源主机", has(d, "github.com"));
  const f = renderCardHTML(FAILED);
  check("失败显示原因（换行压成空格）", has(f, "请求被中止 连接超时"));
  check("失败副行标 err", has(f, "dl-sub err"));
  check("失败原因在 title（悬停看全）", has(f, 'title="请求被中止 连接超时"'));
}

console.log("── 进度条：完成态不画 ──");
{
  const r = renderCardHTML(RUNNING);
  check("进行中画进度条", has(r, "dl-track") && has(r, "dl-bar"));
  check("进行中填充宽度 68%", has(r, 'style="width:68%"'));
  const d = renderCardHTML(DONE);
  check("完成态不画进度条", !has(d, "dl-track"));
  const p = renderCardHTML(PKG);
  check("阶段式未定进度 → 不确定条(indet)", has(p, "indet"));
}

console.log("── 排队态：标签与副行不重复 ──");
{
  const q = renderCardHTML({ taskId: "t6", state: "pending", queued: true, fileName: "a.exe", url: "https://files.example.com/a.exe", total: 100, received: 0, percent: 0, unit: "bytes" });
  check("标签说排队中", has(q, "排队中"));
  check("副行不再写「排队中…」（改为来源主机）", has(q, "files.example.com") && !has(q, "排队中…"));
}

console.log("── 动作按钮：按状态给最少必要项 ──");
{
  const r = renderCardHTML(RUNNING);
  check("进行中给取消", has(r, "dl-cancel"));
  check("进行中不给打开/重试", !has(r, "dl-open") && !has(r, "dl-retry"));
  const d = renderCardHTML(DONE);
  check("完成给打开 + 文件夹", has(d, "dl-open") && has(d, "dl-folder"));
  check("完成不给取消", !has(d, "dl-cancel"));
  const f = renderCardHTML(FAILED);
  check("失败给重试", has(f, "dl-retry"));
  check("失败不给打开", !has(f, "dl-open"));
  const p = renderCardHTML(PKG);
  check("winget/pip 完成态无可打开产物时不硬塞按钮", !has(renderCardHTML({ ...PKG, state: "done" }), "dl-open"));
}

console.log("── HTML 注入防护（文件名/错误含特殊字符）──");
{
  const evil = { ...RUNNING, fileName: '<img src=x onerror=alert(1)>.zip' };
  const h = renderCardHTML(evil);
  check("文件名被转义", has(h, "&lt;img") && !has(h, "<img src=x"));
  const evilErr = { ...FAILED, error: '<script>bad()</script>' };
  check("错误文本被转义", !has(renderCardHTML(evilErr), "<script>"));
}

console.log("── 计数型任务（pnpm/objects）单位文案 ──");
{
  const clone = { taskId: "t5", state: "running", kind: "command", cmdType: "git-clone", fileName: "some-repo", unit: "objects", total: 1732, received: 744, speed: 0, percent: 43 };
  const h = renderCardHTML(clone);
  check("计数型显示 objects 计数", has(h, "744") && has(h, "1732"));
}

console.log(`\n=== cardview: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
