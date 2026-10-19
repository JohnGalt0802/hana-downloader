// tests/tools/aria2-cap-squatter-evidence.mjs — 复现「端口上坐的不是 aria2，却报 available:true」
//
// 复现步骤（与验收单一致）：
//   1. 起一个假 HTTP 服务，回 {"hello":"i am not aria2"}
//   2. 清掉 dataDir/aria2-instance.json
//   3. 调 aria2Backend.capabilities({ dataDir })
//
// 期望（修复后）：available === false，reason 说明「不是 aria2」。
// 修复前：available === true, version === null, port === 6803。
//
// 端口（2026-10-20 改）：不再写死 6802。6802 是产品 aria2 的默认端口，开发机上引擎开着
// aria2 时本脚本必然 EADDRINUSE 崩掉，看起来像产品 bug。改法保留原语义——
// 「一个非 aria2 服务占着某端口，产品去连它」——只是把端口换成 listen(0) 拿到的空闲端口，
// 再用 setOptions({ port }) 让产品去连这个端口（capabilities 以 options.port 为待探测端口）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

import { aria2Backend, resolveAria2Bin } from "../../engine/backends/aria2.js";
import { capabilitiesOf } from "../../engine/backends/contract.js";

const BASE = path.join(os.tmpdir(), "hd-a2-squatter");
fs.rmSync(BASE, { recursive: true, force: true });
fs.mkdirSync(BASE, { recursive: true });
// 步骤 2：确保没有实例记录
try { fs.rmSync(path.join(BASE, "aria2-instance.json"), { force: true }); } catch { /* 本来就没有 */ }

// 步骤 1：假服务（会回 JSON，但不是 aria2 的 JSON-RPC）。
// 端口由系统分配（listen(0)），避免与开发机上真实跑着的 aria2 抢 6802。
const fake = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"hello":"i am not aria2"}');
});
await new Promise((resolve, reject) => {
  fake.once("error", reject);
  fake.listen(0, "127.0.0.1", resolve);
});
const PORT = fake.address().port;
console.log(`假服务占住 127.0.0.1:${PORT}（非 aria2）`);

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
