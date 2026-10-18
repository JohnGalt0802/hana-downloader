import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 端口一律向系统要（listen(0) 后取真端口），并行跑不互抢
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const BASE = path.join(os.tmpdir(), "hd-w3-status");
fs.rmSync(BASE, { recursive: true, force: true });
const DATA_DIR = path.join(BASE, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = await freePort();
const ARIA2_PORT = await freePort();
const eng = spawn(process.execPath, [path.resolve("engine/server.js"), DATA_DIR], { env: { ...process.env, HD_ENGINE_PORT: String(PORT) }, stdio: "ignore" });
let ok = false;
for (let i = 0; i < 100 && !ok; i++) { await sleep(100); try { ok = (await (await fetch(`http://127.0.0.1:${PORT}/ping`)).json()).ok === true; } catch {} }
console.log("engine ready =", ok);
const api = async (p, body) => (await fetch(`http://127.0.0.1:${PORT}${p}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
console.log("1 未启用 status =", JSON.stringify(await api("/aria2/status")));
const saved = await api("/settings", { aria2: { enabled: true, bin: "", port: ARIA2_PORT } });
console.log("2 POST settings.aria2 =", JSON.stringify(saved.settings?.aria2));
console.log("3 启用后 status =", JSON.stringify(await api("/aria2/status")));
await api("/settings", { aria2: { enabled: true, bin: "C:\\\\no\\\\such\\\\aria2c.exe", port: ARIA2_PORT } });
const bad = await api("/aria2/status");
console.log("4 坏 bin status =", JSON.stringify({ available: bad.available, reason: bad.reason }));
await api("/settings", { aria2: { enabled: false, bin: "", port: ARIA2_PORT } });
const off = await api("/aria2/status");
console.log("5 关回去 status =", JSON.stringify({ enabled: off.enabled, available: off.available }));
eng.kill();
await sleep(500);
fs.rmSync(BASE, { recursive: true, force: true });
