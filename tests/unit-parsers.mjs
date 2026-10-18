// 解析器单测：用 2026-09-18 实机输出当样例（winget/pip/uv 三段均来自实机探测）
import * as pp from "../engine/progress-parsers.js";

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  let ok = false;
  try { ok = expectFn(actual); } catch (e) { ok = false; }
  if (ok) { pass++; }
  else { fail++; console.log("FAIL:", name, "=>", JSON.stringify(actual)); }
}

// ── winget parser ──
{
  const p = pp.createWingetParser();
  check("wg: found", p("已找到 jq [jqlang.jq] 版本 1.8.2"), (x) => x && x.stage === "found" && x.meta.pkgName === "jq" && x.meta.pkgId === "jqlang.jq" && x.meta.pkgVersion === "1.8.2");
  check("wg: downloading", p("正在下载 https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-windows-amd64.exe"), (x) => x && x.stage === "downloading" && x.meta.installUrl.includes("jq-windows"));
  check("wg: verifying", p("已成功验证安装程序哈希"), (x) => x && x.stage === "verifying");
  check("wg: installing", p("正在启动程序包安装..."), (x) => x && x.stage === "installing");
  check("wg: path note", p("已修改路径环境变量；重启 shell 以使用新值。"), (x) => x && x.note && x.note.includes("PATH"));
  check("wg: alias note", p("添加了命令行别名： \"jq\""), (x) => x && x.note && x.note.includes("别名"));
  check("wg: success", p("已成功安装"), (x) => x && x.stage === "finalizing");
  check("wg: upgrade path", p("找到已安装的现有包。正在尝试升级已安装的包..."), (x) => x && x.meta && x.meta.upgrading === true);
  check("wg: no upgrade", p("找不到可用的升级。"), (x) => x && x.stage === "finalizing");
  check("wg: noise ignored", p("此应用程序由其所有者授权给你。"), (x) => x === null);
  check("wg: license noise", p("Microsoft 对第三方程序包概不负责，也不向第三方程序包授予任何许可证。"), (x) => x === null);
  // 英文备用
  check("wg-en: found", p("Found jq [jqlang.jq] Version 1.8.2"), (x) => x && x.stage === "found" && x.meta.pkgName === "jq");
  check("wg-en: success", p("Successfully installed"), (x) => x && x.stage === "finalizing");
}

// ── pip parser ──
{
  const p = pp.createPipParser();
  check("pip: collecting", p("Collecting six"), (x) => x && x.stage === "collecting" && x.meta.pkgCount === 1);
  check("pip: metadata", p("Downloading six-1.17.0-py2.py3-none-any.whl.metadata (1.7 kB)"), (x) => x && x.stage === "collecting");
  check("pip: downloading", p("Downloading six-1.17.0-py2.py3-none-any.whl (11 kB)"), (x) => x && x.stage === "downloading" && x.meta.currentFile === "six-1.17.0-py2.py3-none-any.whl" && x.meta.currentSize === "11 kB");
  check("pip: installing", p("Installing collected packages: six"), (x) => x && x.stage === "installing" && x.meta.installList === "six");
  check("pip: success", p("Successfully installed six-1.17.0"), (x) => x && x.stage === "finalizing" && x.note.includes("six-1.17.0"));
  check("pip: satisfied", p("Requirement already satisfied: six in D:\\HanakoWorks\\_temp\\piptest-venv\\Lib\\site-packages (1.17.0)"), (x) => x && x.stage === "finalizing" && x.meta.alreadySatisfied === true && x.note.includes("1.17.0"));
  check("pip: noise ignored", p("  \r"), (x) => x === null);
  // 第二种大小写法
  check("pip: MB size", p("Downloading numpy-2.0.0-cp314-cp314-win_amd64.whl (15.9 MB)"), (x) => x && x.meta.currentSize === "15.9 MB");
}

// ── uv parser ──
{
  const p = pp.createUvParser();
  check("uv: env", p("Using Python 3.12.13 environment at: D:\\HanakoWorks\\_temp\\uvtest-venv"), (x) => x && x.stage === "collecting");
  check("uv: resolved", p("Resolved 1 package in 1.43s"), (x) => x && x.stage === "downloading" && x.meta.pkgCount === 1);
  check("uv: installed", p("Installed 1 package in 24ms"), (x) => x && x.stage === "installing");
  check("uv: pkg line", p("+ six==1.17.0"), (x) => x && x.note.includes("six") && x.note.includes("1.17.0"));
  check("uv: checked", p("Checked 1 package in 0.18ms"), (x) => x && x.stage === "finalizing" && x.note && x.note.includes("最新"));
  check("uv: warning ignored", p("warning: Failed to hardlink files; falling back to full copy. This may lead to degraded performance."), (x) => x === null);
}

// ── winget 退出码分类 ──
{
  check("exit: 0", pp.classifyWingetExit(0), (x) => x && x.state === "done");
  check("exit: 0x8A15002B (2316632107)", pp.classifyWingetExit(2316632107), (x) => x && x.state === "done" && x.note);
  check("exit: -1978335189 signed", pp.classifyWingetExit(-1978335189), (x) => x && x.state === "done");
  check("exit: 0x8A150014 not found", pp.classifyWingetExit(2316632084), (x) => x && x.state === "failed");
  check("exit: 0x8A150019 admin", pp.classifyWingetExit(-1978335207), (x) => x && x.state === "failed" && x.error.includes("管理员"));
  check("exit: unknown", pp.classifyWingetExit(12345), (x) => x === null);
  check("exit: 0x80072EE2 WinINet timeout", pp.classifyWingetExit(2147954402), (x) => x && x.state === "failed" && x.error.includes("超时"));
  check("exit: 0x80072EE7 DNS", pp.classifyWingetExit(-2147012889), (x) => x && x.state === "failed");
  // 2026-10-18 事故：Number(null) >>> 0 === 0，把「被信号杀死的安装」判成安装成功并回执宿主。
  // 凡不是合法有限数值的，一律当未知码（null），交给调用方走通用失败分支。
  check("exit: null 不是 0（进程被信号杀）", pp.classifyWingetExit(null), (x) => x === null);
  check("exit: undefined 不是 0", pp.classifyWingetExit(undefined), (x) => x === null);
  check("exit: 'abc' 不是 0", pp.classifyWingetExit("abc"), (x) => x === null);
  check("exit: true 不是 0", pp.classifyWingetExit(true), (x) => x === null);
  check("exit: false 不是 0", pp.classifyWingetExit(false), (x) => x === null);
  check("exit: [] 不是 0", pp.classifyWingetExit([]), (x) => x === null);
  check("exit: {} 不是 0", pp.classifyWingetExit({}), (x) => x === null);
  check("exit: '' 不是 0", pp.classifyWingetExit(""), (x) => x === null);
  check("exit: NaN 不是 0", pp.classifyWingetExit(NaN), (x) => x === null);
  check("exit: Infinity 不是 0", pp.classifyWingetExit(Infinity), (x) => x === null);
  check("exit: 真 0 仍是 done", pp.classifyWingetExit(0), (x) => x && x.state === "done");
  check("exit: '0' 字符串仍是 done", pp.classifyWingetExit("0"), (x) => x && x.state === "done");
  check("exit: 0x8A15002B 带 note", pp.classifyWingetExit(0x8A15002B), (x) => x && x.state === "done" && !!x.note);
}

// ── winget search 表格解析 ──
{
  const table = [
    "名称                                 ID                                   版本            匹配         源",
    "--------------------------------------------------------------------------------------------------------------",
    "LiteMonitor                          Diorser.LiteMonitor                  1.3.6           Moniker: zip winget",
    "360 Zip                              360.360Zip                           1.0.0.1041      Tag: zip     winget",
    "7-Zip                                7zip.7zip                            26.03           Tag: zip     winget",
    "PowerArchiver 2022                   ConeXware.PowerArchiver.2022         21.00.18        Tag: zip     winget",
  ].join("\r\n");
  const rows = pp.parseWingetSearch(table);
  check("search: count", rows, (x) => x.length === 4);
  check("search: first", rows, (x) => x[0].id === "Diorser.LiteMonitor" && x[0].version === "1.3.6");
  check("search: name with space", rows, (x) => x.some((r) => r.name === "PowerArchiver 2022" && r.id === "ConeXware.PowerArchiver.2022"));
  check("search: empty", pp.parseWingetSearch("找不到与输入条件匹配的程序包。"), (x) => x.length === 0);

  // 窄表：单条精确结果，匹配列消失、列间缩到 1 空格（实测 jqlang.jq）
  const narrow = [
    "名称 ID        版本  源",
    "----------------------------",
    "jq   jqlang.jq 1.8.2 winget",
  ].join("\r\n");
  const rows2 = pp.parseWingetSearch(narrow);
  check("search-narrow: count", rows2, (x) => x.length === 1);
  check("search-narrow: id/version/name", rows2, (x) => x[0].id === "jqlang.jq" && x[0].version === "1.8.2" && x[0].name === "jq");

  // 极窄表：名称与 ID 之间也只有 1 个空格（实测 Microsoft.Sysinternals.Suite）
  const ultraNarrow = [
    "名称               ID                           版本       源",
    "------------------------------------------------------------------",
    "Sysinternals Suite Microsoft.Sysinternals.Suite 2026-07-09 winget",
  ].join("\r\n");
  const rows4 = pp.parseWingetSearch(ultraNarrow);
  check("search-ultra: count", rows4, (x) => x.length === 1);
  check("search-ultra: id/name/version", rows4, (x) => x[0].id === "Microsoft.Sysinternals.Suite" && x[0].name === "Sysinternals Suite" && x[0].version === "2026-07-09");

  // 名称含点与点号的干扰场景
  const tricky = [
    "名称                                                   ID                                   版本            匹配         源",
    "---------------------------------------------------------------------------------------------------------------------------------",
    "Microsoft .NET 6.0.23 - Windows Server Hosting         Microsoft.DotNet.HostingBundle.6       6.0.23          6.0.36      winget",
    "Node.js JavaScript Runtime                             OpenJS.NodeJS                          22.5.0          winget",
  ].join("\r\n");
  const rows3 = pp.parseWingetSearch(tricky);
  check("search-tricky: count", rows3, (x) => x.length === 2);
  check("search-tricky: dotnet", rows3, (x) => x.some((r) => r.id === "Microsoft.DotNet.HostingBundle.6" && r.version === "6.0.23" && r.name.startsWith("Microsoft .NET")));
  check("search-tricky: nodejs", rows3, (x) => x.some((r) => r.id === "OpenJS.NodeJS" && r.version === "22.5.0"));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
