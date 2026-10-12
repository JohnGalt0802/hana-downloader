// tests/unit-aria2.mjs — aria2 后端：状态映射 / 配置读取 / 提交与取消的对账语义
// 覆盖评审定档的五条不可省项里可离线验证的部分：
//   1. 不让 aria2 与引擎同时调度（后端字段在 create 时确定，见 dlcore 集成分支）
//   2. 传输有明确身份（gid 预分配 & 持久化）
//   3. 提交结果不明先对账（hasGid 语义：true/false/null 必须区分）
//   4. 临时文件与最终文件分离、完成判定不来自 .part 长度
//   5. 取消未确认不报成功
//
// 本套件不启真 daemon、不发网络请求：只测纯逻辑与契约（mapStatus / config / 语义分支）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAria2Config, aria2 } from "../engine/aria2-backend.js";

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hd-aria2-test-"));
const cfgPath = path.join(dir, "engine-config.json");

console.log("── loadAria2Config 默认值 ──");
{
  const c = loadAria2Config(dir);
  check("默认关闭（不破坏既有行为）", c.enabled, false);
  check("默认端口避开 skill 的 6801", c.port, 6802);
  check("默认 minSplitSize = 1MB（非 aria2 原生的 20MB）", c.minSplitSize, 1 << 20);
  check("默认 split = 16", c.split, 16);
  check("默认不走 gh-proxy", c.ghProxy, "");
}

console.log("── loadAria2Config 读取配置 ──");
{
  fs.writeFileSync(cfgPath, JSON.stringify({
    defaultSaveDir: "D:\\x",
    aria2: { enabled: true, port: 6803, minSplitSize: 524288, split: 8, maxConnectionPerServer: 8, ghProxy: "https://v4.gh-proxy.org/" },
  }), "utf-8");
  const c = loadAria2Config(dir);
  check("enabled 读到", c.enabled, true);
  check("port 读到", c.port, 6803);
  check("minSplitSize 读到", c.minSplitSize, 524288);
  check("split 读到", c.split, 8);
  check("ghProxy 读到", c.ghProxy, "https://v4.gh-proxy.org/");
}

console.log("── loadAria2Config 容错（坏值回落默认）──");
{
  fs.writeFileSync(cfgPath, JSON.stringify({ aria2: { enabled: "yes", port: -1, split: "x", minSplitSize: 0 } }), "utf-8");
  const c = loadAria2Config(dir);
  check("非布尔 enabled → false", c.enabled, false);
  check("非法 port → 默认 6802", c.port, 6802);
  check("非法 split → 默认 16", c.split, 16);
  check("minSplitSize=0 → 默认 1MB", c.minSplitSize, 1 << 20);

  fs.writeFileSync(cfgPath, "{ 坏 JSON", "utf-8");
  const c2 = loadAria2Config(dir);
  check("JSON 损坏 → 全部默认", [c2.enabled, c2.port], [false, 6802]);
}

console.log("── mapStatus：传输状态映射 ──");
{
  const cases = [
    ["active", "running"],
    ["waiting", "running"],
    ["paused", "running"],
    ["complete", "transfer-complete"], // 注意：绝不是 done——交付由上层校验后决定
    ["error", "failed"],
    ["removed", "canceled"],
  ];
  for (const [raw, want] of cases) {
    check(`${raw} → ${want}`, aria2.mapStatus({ status: raw, totalLength: "100", completedLength: "0" }).transferState, want);
  }
}

console.log("── mapStatus：字段与 errorCode 陷阱 ──");
{
  const s = aria2.mapStatus({
    status: "active", totalLength: "5447254", completedLength: "1234567",
    downloadSpeed: "409600", connections: "16", errorCode: "0", errorMessage: "",
  });
  check("total 数值化", s.total, 5447254);
  check("received 数值化", s.received, 1234567);
  check("speed 数值化", s.speed, 409600);
  check("connections 数值化", s.connections, 16);
  check('errorCode "0"（truthy 字符串）解析为 0', s.errorCode, 0);
  check('errorCode "0" 不误判为失败', s.transferState, "running");

  const e = aria2.mapStatus({ status: "error", errorCode: "1", errorMessage: "boom", totalLength: "0", completedLength: "0" });
  check("真实错误码解析", e.errorCode, 1);
  check("错误信息带出", e.errorMessage, "boom");

  const z = aria2.mapStatus({ status: "active", totalLength: "0", completedLength: "0" });
  check("totalLength=0 → total=null（不报假进度）", z.total, null);
}

console.log("── 交付语义：complete 不等于 done ──");
{
  // 多段下载会预分配完整长度：.part 的 size 可能等于 total 而内容未下载完。
  // 因此完成判定绝不能来自文件长度。mapStatus 的 complete → transfer-complete 已隔离这层。
  const st = aria2.mapStatus({ status: "complete", totalLength: "1000", completedLength: "1000" });
  check("complete 只到 transfer-complete，不直达 done", st.transferState === "done", false);
}

console.log("── resolveBin：能找到（或明确找不到）──");
{
  const c = loadAria2Config(dir);
  const bin = aria2.resolveBin(c);
  // 本机装有 aria2c（skill 用的那个），应为可解析路径或命令名；找不到时为空串。
  check("返回字符串", typeof bin, "string");
  console.log(`       解析到 bin = ${bin || "(未找到)"}`);
}

console.log("── instanceDir：专属目录在 App 数据目录下 ──");
{
  const p = aria2.instanceDir(dir);
  check("位于 dataDir 之下", p.startsWith(dir), true);
  check("目录名为 aria2（与 skill 隔离）", path.basename(p), "aria2");
}

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n=== aria2: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
