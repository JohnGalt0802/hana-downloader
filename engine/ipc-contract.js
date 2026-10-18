// engine/ipc-contract.js — App ↔ 引擎之间的取值兜底（纯函数，可单测）
//
// 背景（2026-10-18）：引擎如果回了非 JSON（崩溃残留、端口被别的进程占、代理错误页…），
// 旧 callEngine 直接 `return text` 把裸字符串交给调用方，调用方按对象用（r.ok / r.taskId），
// 全是 undefined —— 「引擎失联」被显示成「任务已发起/已完成」，属于乱码当成功。
// 现在统一由 parseEngineResponse 收口：解析失败返回结构化错误对象。
//
// 另一条：content[].text / 任务 label 这类**模型可见文本**必须是字符串。
// 宿主读 .length，null 会让整条会话当场断掉（2026-10-18 事故）。asText 就是那个归一入口。

/**
 * 把引擎回包的文本按 JSON 解析成对象。
 * 任意失败（非 JSON、顶层是标量/null/数组之外的东西）一律返回 {ok:false,error}，
 * 绝不把裸字符串交给调用方。
 * @param {string|any} text 引擎回包原文
 * @returns {object}
 */
export function parseEngineResponse(text) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `engine non-JSON: ${raw.slice(0, 200)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // 合法 JSON 但不是对象（null / 数字 / 字符串 / 数组）：同样不是本引擎的契约形状
    return { ok: false, error: `engine non-object JSON: ${raw.slice(0, 200)}` };
  }
  return parsed;
}

/**
 * 任意值 → 字符串。null/undefined → ""。
 * 用于所有会进模型上下文或宿主 UI 的文本字段。
 */
export function asText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return String(value); } catch { return ""; }
}
