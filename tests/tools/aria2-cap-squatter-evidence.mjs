// tests/tools/aria2-cap-squatter-evidence.mjs — 复现「端口上坐的不是 aria2，却报 available:true」
//
// 复现步骤（与验收单一致）：
//   1. 起一个假 HTTP 服务占住配置端口（默认 6802），回 {"hello":"i am not aria2"}
//   2. 清掉 dataDir/aria2-instance.json
//   3. 调 aria2Backend.capabilities({ dataDir })
//
// 期望（修复后）：available === false，reason 说明「不是 aria2」。
// 修复前：available === true, version === null, port === 6803。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { aria2Backend, resolveAria2Bin } from "../../engine/backends/aria2.js";
import { capabilitiesOf } from "../../engine/backends/contract.js";

const PORT = 6802;
const BASE = path.join(os.tmpdir(), "hd-a2-squatter");
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
// 步骤 2：确保没有实例记录
try { fs.rmSync(path.join(BASE, "aria2-instance.json"), { force: true }); } catch { /* 本来就没有 */ }

// 步骤 1：假服务（会回 JSON，但不是 aria2 的 JSON-RPC）
const fake = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"hello":"i am not aria2"}');
});
await new Promise((resolve, reject) => {
  fake.once("error", reject);
  fake.listen(PORT, "127.0.0.1", resolve);
});

const bin = resolveAria2Bin("");
console.log("aria2c =", bin || "（未检测到）");
aria2Backend.setOptions({ bin, port: PORT });

// 步骤 3
const cap = await capabilitiesOf(aria2Backend, { dataDir: BASE });
console.log("capabilities =", JSON.stringify(cap));

const ok = cap.available === false && typeof cap.reason === "string" && /aria2/i.test(cap.reason);
console.log("判定：available === false 且 reason 说清不是 aria2 →", ok ? "PASS" : "FAIL");

// 收尾：只关自己起的东西
await aria2Backend.shutdown();
fake.close();
fs.rmSync(BASE, { recursive: true, force: true });
process.exitCode = ok ? 0 : 1;
