// manager.js — Hana 下载管理器（跨会话）
// 轮询引擎的 /list 获取所有会话的下载任务，列表 + 筛选 + 详情 + 操作。
// v2 App：后端访问走官方 @hana/app-sdk 的 hana.api，不再劫持 window.fetch。

import { hana } from "./assets/sdk.js";
// 阶段文案、计数单位与任务形态判定都有唯一来源（Node 侧 index.js 同用这个模块）
import { STAGE_TEXT, unitSuffix, isPkgTask, isCountTask, isCmdTask } from "./shared/display.js";

(function () {
  "use strict";

  // ── 主题 ──
  // 宿主主题快照（hana.theme）；旧宿主不发主题快照时退回系统配色。
  function syncTheme() {
    var dark = false;
    try {
      var snap = hana.theme.getSnapshot() || {};
      var label = String(snap.theme || "");
      dark = snap.appearance === "dark" || /dark|midnight|contrast|深|夜/i.test(label);
      if (!dark && !snap.appearance && (!label || label === "inherit")) {
        dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      }
    } catch (e) {
      dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
    document.body.classList.toggle("t-dark", dark);
    if (typeof render === "function") { try { render(); } catch (e2) { /* 忽略 */ } }
  }
  syncTheme();
  try { hana.theme.subscribe(function () { syncTheme(); }); } catch (e3) { /* 订阅不可用就只留首帧 */ }

  // ── 卡片联动通道 ──
  // 2026-09-21：管理器和聊天流卡片各跑在独立 iframe 里，本来互不通气。管理器的「重试」
  // 是在同一个 taskId 上把任务复活，而卡片进终态后已停止轮询，于是停在旧状态，
  // 必须刷新前端才恢复（用户实测反馈）。现在凡是改任务状态的动作都广播一声，
  // 卡片收到后立刻恢复快频轮询并马上查一次。
  var BC = null;
  try { BC = new BroadcastChannel("hana-dl-cards"); } catch (e5) { BC = null; }
  function notifyCards(taskId) {
    if (!BC) return;
    // taskId 传 null 表示「不指定」，所有卡片都醒一下
    try { BC.postMessage({ type: "taskChanged", taskId: taskId || null }); } catch (e6) { /* 忽略 */ }
  }

  try { hana.ready(); } catch (e4) { /* ready 失败不阻塞渲染 */ }

  // 配色诊断已于 2026-09-25 移除：原实现在挂载后 1.2s 调 hana.track("diag", {...})
  // 上报底色与主题快照。宿主 0.1023.1 对该通道加了校验（cardInstanceId 必须是宿主
  // 铸造的，管理器是宿主原生卡、拿不到自算 id），调用会报
  //   Uncaught HanaPluginError: events/track cardInstanceId must be a host-minted app card id.
  // 且多卡同时挂载时会成批超时（见 docs/踩坑记录.md 第 38 条），收益为零、只有害处。

  // 阶段文案与计数单位来自 ui/shared/display.js（唯一来源），这里不再各存一份。

  var POLL_MS = 3000;
  var tasks = [];
  var filter = "all"; // all | active | done | failed
  var search = ""; // 搜索关键词
  var expanded = null; // taskId 展开详情
  var settings = {}; // 插件设置（defaultSaveDir / agentChooses）

  // ── 后端访问 ──
  // v2 App：统一走 hana.api.fetch（SDK 自动带 iframe 的 surface session 票据，
  // 并把路径拼成 /api/apps/<appId>/routes/<path>）。
  // 旧插件时代的 /download/xxx 路径在这里映射到引擎端点，调用点不用改。
  var API_MAP = {
    "/download/list": { path: "engine/list", method: "GET" },
    "/download/status": { path: "engine/wait", method: "POST", fromQuery: "taskId" },
    "/download/cancel": { path: "engine/cancel", method: "POST", fromQuery: "taskId" },
    "/download/cancel-all": { path: "engine/cancel-all", method: "POST" },
    "/download/clear": { path: "engine/clear", method: "POST" },
    "/download/forget": { path: "engine/forget", method: "POST" },
    "/download/reveal": { path: "engine/reveal", method: "POST" },
    "/download/retry": { path: "retry", method: "POST" }, // 走 App 路由：App 要起终态守望，好把重试结果通知给 agent
    "/settings": { path: "engine/settings", method: null },
    "/diag": { path: "engine/ping", method: "GET" },
  };

  function apiFetch(path, init) {
    var raw = String(path || "");
    var qi = raw.indexOf("?");
    var base = qi >= 0 ? raw.slice(0, qi) : raw;
    var query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    var rule = API_MAP[base] || { path: "engine" + base, method: null };
    var body = init && init.body;
    var opts = { method: (rule.method || (init && init.method) || "GET") };

    if (rule.fromQuery) {
      // 旧式 query 调用 → 引擎只吃 JSON body
      var obj = {};
      query.forEach(function (v, k) { obj[k] = v; });
      if (body) { try { Object.assign(obj, JSON.parse(body)); } catch (e) { /* body 不是 JSON 就忽略 */ } }
      opts.method = "POST";
      opts.headers = { "content-type": "application/json" };
      opts.body = JSON.stringify(obj);
    } else if (body) {
      opts.body = body;
      opts.headers = (init && init.headers) || { "content-type": "application/json" };
    }
    return hana.api.fetch(rule.path, opts);
  }

  function reportSize() {
    try {
      var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
      if (!h || h < 60) h = 60;
      try { hana.ui.resize({ height: h }); } catch (e) { /* 老宿主没有这路 */ }
      // 兜底：0.970.9 的部分挂载位只认这条顶层高度消息
      try { window.parent.postMessage({ type: "hana.card-resize", height: h }, "*"); } catch (e2) { /* 忽略 */ }
    } catch (e3) { /* 忽略 */ }
  }

  // ── 格式化 ──
  function fmtBytes(n) {
    if (n == null || !isFinite(n) || n <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + units[i];
  }
  function fmtSpeed(s) {
    if (!s || s <= 0) return "";
    return fmtBytes(s) + "/s";
  }
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  }
  function fmtDuration(ms) {
    if (!ms || ms <= 0) return "";
    var s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + "m" + (r ? r + "s" : "");
    var h = Math.floor(m / 60); m = m % 60;
    return h + "h" + m + "m";
  }
  function shortPath(p) {
    if (!p) return "";
    var parts = p.split(/[\\/]/);
    return parts.slice(0, -1).join("/").length > 30
      ? "…" + parts.slice(-3).join("/")
      : p;
  }
  function sessionLabel(t) {
    if (t.sessionPath) {
      var sp = String(t.sessionPath).split(/[\\/]/).pop() || "";
      return sp.replace(/\.jsonl$/i, "");
    }
    if (t.sessionId) return String(t.sessionId).slice(0, 12);
    return "未知会话";
  }

  // ── 渲染 ──
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function stateMeta(t) {
    switch (t.state) {
      case "running": return { label: "下载中", cls: "st-running" };
      case "pending": return { label: t.queued ? "排队中" : "准备中", cls: "st-pending" };
      case "done": return { label: "完成", cls: "st-done" };
      case "failed": return { label: "失败", cls: "st-failed" };
      case "canceled": return { label: "已取消", cls: "st-canceled" };
      case "interrupted": return { label: "已中断", cls: "st-interrupted" };
      default: return { label: t.state || "未知", cls: "st-unknown" };
    }
  }

  function render() {
    var listEl = document.getElementById("mgr-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    var visible = tasks.filter(function (t) {
      if (filter === "all") return true;
      if (filter === "active") return t.state === "running" || t.state === "pending";
      if (filter === "done") return t.state === "done";
      if (filter === "failed") return t.state === "failed" || t.state === "canceled" || t.state === "interrupted";
      return true;
    }).filter(function (t) {
      if (!search) return true;
      var q = search.toLowerCase();
      return (t.fileName || "").toLowerCase().indexOf(q) >= 0
        || (t.url || "").toLowerCase().indexOf(q) >= 0
        || (t.filePath || "").toLowerCase().indexOf(q) >= 0
        || (t.error || "").toLowerCase().indexOf(q) >= 0;
    });

    if (visible.length === 0) {
      var empty = el("div", "mgr-empty", "暂无下载任务");
      listEl.appendChild(empty);
      reportSize();
      return;
    }

    visible.forEach(function (t) {
      var row = el("div", "mgr-row" + (t.state === "done" ? " mgr-row-done" : (t.state === "failed" || t.state === "canceled" || t.state === "interrupted") ? " mgr-row-fail" : ""));
      // 整行进度背景：下载任务行即进度条（背景按百分比填充）
      if (t.state === "running" || t.state === "pending") {
        var rowPct = t.total ? Math.min(100, (t.received / t.total) * 100) : 0;
        var rowBg = el("div", "mgr-row-bg");
        rowBg.style.width = (t.total ? rowPct : 5) + "%";
        if (!t.total && t.state === "running") rowBg.classList.add("indet");
        row.appendChild(rowBg);
      }
      var isExpanded = expanded === t.taskId;
      var st = stateMeta(t);

      var head = el("div", "mgr-head");
      if (isExpanded) head.classList.add("open");

      var main = el("div", "mgr-main");
      var nameRow = el("div", "mgr-name-row");
      var badge = el("span", "mgr-badge " + st.cls, st.label);
      var name = el("span", "mgr-name", t.fileName || t.taskId);
      nameRow.appendChild(badge);
      nameRow.appendChild(name);

      var metaRow = el("div", "mgr-meta");
      var metaBits = [];
      var isPkg = isPkgTask(t);
      if (t.state === "running") {
        if (isPkg && !t.total) {
          // 阶段式任务：暂无字节数据时显示阶段文案（2026-09-18）；有下载探测数据后走字节显示
          metaBits.push(STAGE_TEXT[t.stage] || "安装中");
        } else if (isCountTask(t)) {
          // 计数型（git / pnpm）：received/total 是对象数/包数，不能按字节渲染（2026-09-19）
          metaBits.push(t.stageDetail || (t.received + (t.total ? "/" + t.total : "" ) + unitSuffix(t.unit)));
        } else {
          if (t.speed) metaBits.push(fmtSpeed(t.speed));
          metaBits.push(t.total ? (t.percent != null ? t.percent + "%" : "") : fmtBytes(t.received));
        }
      } else if (t.state === "done") {
        // 2026-09-19：命令类（git clone / pnpm）的 received/total 是对象数/包数，不是产物大小，
        // 完成行不再按字节渲染；包安装（winget/pip）报备注；URL 下载才报真实大小。
        if (isPkg) {
          if (t.note) metaBits.push(t.note);
        } else if (!isCmdTask(t)) {
          metaBits.push(fmtBytes(t.total || t.received));
        }
        if (t.elapsed) metaBits.push(fmtDuration(t.elapsed));
      } else if (t.error) {
        metaBits.push(t.error);
      }
      metaBits.push(sessionLabel(t));
      metaBits.push(fmtTime(t.finishedAt || t.startedAt));
      metaRow.textContent = metaBits.filter(Boolean).join(" · ");

      main.appendChild(nameRow);
      main.appendChild(metaRow);

      var actions = el("div", "mgr-actions");
      // 主按钮：打开文件；旁边小箭头展开下拉（打开文件 / 打开所在文件夹）
      var btnOpen = el("button", "mgr-btn mgr-open-main", "打开");
      btnOpen.onclick = function (e) { e.stopPropagation(); openFile(t); };
      var btnMore = el("button", "mgr-btn mgr-more", "▾");
      btnMore.title = "更多操作";
      btnMore.onclick = function (e) {
        e.stopPropagation();
        if (rowMenuEl && rowMenuEl.style.display === "block" && rowMenuTask === t) {
          closeRowMenu();
        } else {
          closeRowMenu();
          openRowMenu(actions, t);
        }
      };
      actions.appendChild(btnOpen);
      actions.appendChild(btnMore);
      if (t.state === "running" || t.state === "pending") {
        var btnCancel = el("button", "mgr-btn mgr-btn-danger", "取消");
        btnCancel.onclick = function (e) { e.stopPropagation(); cancelTask(t); };
        actions.appendChild(btnCancel);
      }

      head.appendChild(main);
      head.appendChild(actions);
      head.onclick = function () {
        expanded = expanded === t.taskId ? null : t.taskId;
        render();
      };

      row.appendChild(head);

      if (isExpanded) {
        var detail = el("div", "mgr-detail");
        var rows = [
          ["任务 ID", t.taskId],
          ["下载地址", t.url || "—"],
          ["保存位置", shortPath(t.filePath || "")],
          ["来源会话", sessionLabel(t)],
          ["开始时间", t.startedAt ? new Date(t.startedAt).toLocaleString() : "—"],
          ["结束时间", t.finishedAt ? new Date(t.finishedAt).toLocaleString() : "—"],
          ["耗时", fmtDuration(t.elapsed) || "—"],
          ["状态", st.label + (t.error ? "：" + t.error : "")],
        ];
        rows.forEach(function (r) {
          var dRow = el("div", "mgr-detail-row");
          var k = el("span", "mgr-detail-k", r[0]);
          var v = el("span", "mgr-detail-v", r[1]);
          dRow.appendChild(k);
          dRow.appendChild(v);
          detail.appendChild(dRow);
        });
        row.appendChild(detail);
      }

      listEl.appendChild(row);
    });

    reportSize();
  }

  // ── 行内下拉菜单（body 级单例，避免 render 重建列表时被销毁）──
  var rowMenuEl = null;
  var rowMenuTask = null;
  function ensureRowMenu() {
    if (rowMenuEl) return rowMenuEl;
    rowMenuEl = el("div", "mgr-row-menu");
    var optRetry = el("button", "mgr-row-menu-opt mgr-row-menu-retry", "重试");
    optRetry.onclick = function (e) { e.stopPropagation(); var t = rowMenuTask; closeRowMenu(); if (t) retryTask(t); };
    var opt1 = el("button", "mgr-row-menu-opt", "打开所在文件夹");
    opt1.onclick = function (e) { e.stopPropagation(); var t = rowMenuTask; closeRowMenu(); if (t) reveal(t); };
    var opt2 = el("button", "mgr-row-menu-opt", "删除记录");
    opt2.onclick = function (e) { e.stopPropagation(); var t = rowMenuTask; closeRowMenu(); if (t) forgetTask(t, false); };
    var opt3 = el("button", "mgr-row-menu-opt mgr-row-menu-danger", "删除记录及文件");
    opt3.onclick = function (e) { e.stopPropagation(); var t = rowMenuTask; closeRowMenu(); if (t) forgetTask(t, true); };
    rowMenuEl.appendChild(optRetry);
    rowMenuEl.appendChild(opt1);
    rowMenuEl.appendChild(opt2);
    rowMenuEl.appendChild(opt3);
    document.body.appendChild(rowMenuEl);
    // 全局点击关闭
    document.addEventListener("click", function (ev) {
      if (rowMenuEl && rowMenuEl.style.display !== "none" && !rowMenuEl.contains(ev.target)) {
        closeRowMenu();
      }
    });
    return rowMenuEl;
  }
  function openRowMenu(anchorEl, t) {
    rowMenuTask = t;
    var menu = ensureRowMenu();
    // 重试只对终态开放：在途任务（running / pending）没有可重试的语义
    var retryOpt = menu.querySelector(".mgr-row-menu-retry");
    if (retryOpt) {
      retryOpt.style.display = (t && (t.state === "interrupted" || t.state === "failed" || t.state === "canceled")) ? "block" : "none";
    }
    // 定位（fixed 相对视口）
    var r = anchorEl.getBoundingClientRect();
    var mw = menu.offsetWidth || 150;
    var mh = menu.offsetHeight || 70;
    var left = r.right - mw;
    if (left < 8) left = 8;
    var top = r.bottom + 2;
    if (top + mh > (window.innerHeight || 600) - 8) top = r.top - mh - 2;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.display = "block";
  }
  function closeRowMenu() {
    if (rowMenuEl) rowMenuEl.style.display = "none";
    rowMenuTask = null;
  }

  // ── 筛选下拉（body 单例：双击筛选按钮弹出，清空记录 / 全部取消）──
  var filterMenuEl = null;
  var filterMenuItems = null; // 下拉项配置
  function ensureFilterMenu() {
    if (filterMenuEl) return filterMenuEl;
    filterMenuEl = el("div", "mgr-row-menu mgr-filter-menu");
    document.body.appendChild(filterMenuEl);
    document.addEventListener("click", function (ev) {
      if (filterMenuEl && filterMenuEl.style.display !== "none" && !filterMenuEl.contains(ev.target)) {
        closeFilterMenu();
      }
    });
    return filterMenuEl;
  }
  function openFilterMenu(anchorEl, opts, ev) {
    filterMenuItems = opts;
    var menu = ensureFilterMenu();
    menu.innerHTML = "";
    (opts || []).forEach(function (it) {
      var o = el("button", "mgr-row-menu-opt", it.label);
      o.onclick = function (e) { e.stopPropagation(); closeFilterMenu(); if (it.onclick) it.onclick(); };
      menu.appendChild(o);
    });
    // 先显示但用 visibility 隐藏，量取真实宽高，避免 offsetWidth=0 兜底导致偏移
    menu.style.visibility = "hidden";
    menu.style.display = "block";
    var mw = menu.offsetWidth;
    var mh = menu.offsetHeight;
    var r = anchorEl.getBoundingClientRect();
    // 健壮性：锚点若已脱离布局（矩形全 0），改用指针坐标定位，
    // 否则居中计算会得到负数，被边界一把兜到最左侧。（2026-09-10）
    if (!r.width && !r.height && ev && ev.clientX) {
      r = { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY, width: 0, height: 0 };
    }
    var vw = window.innerWidth || 400;
    // 下拉优先在按钮正上方居中：bottom 贴按钮 top，水平中心对齐按钮中心
    var left = r.left + (r.width / 2) - (mw / 2);
    // 边界收敛：左右越界时贴边，但不退回 0（否则菜单会跑到卡片最左侧）
    var maxLeft = vw - 8 - mw;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    if (left < 8) left = Math.min(8, Math.max(0, r.left));
    var top = r.top - mh - 4;
    if (top < 8) top = r.top + r.height + 4; // 上方放不下改下方
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.visibility = "";
  }
  function closeFilterMenu() {
    if (filterMenuEl) filterMenuEl.style.display = "none";
    filterMenuItems = null;
  }

  // 清空记录：调用后端 /download/clear 清当前分类终态
  function clearStates(states) {
    if (!states || !states.length) return;
    apiFetch("/download/clear", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: states }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // 诊断：后端返回 diag 时一并展示（hasClear 等），便于定位模块缓存问题
        var diag = data && data.diag ? "  [diag:" + (data.diag.hasClear ? "clear=YES" : "clear=NO") + "/" + (data.diag.hasCancelAll ? "cancelAll=YES" : "cancelAll=NO") + "]" : "";
        if (data && data.ok) { hint("已清空 " + (data.removed ? data.removed.length : 0) + " 条记录"); notifyCards(null); poll(); }
        else { hint("清空失败：" + ((data && data.error) || "未知错误") + diag); }
      })
      .catch(function () { hint("清空失败：网络错误"); });
  }
  // 全部取消在途
  function cancelAllActive() {
    apiFetch("/download/cancel-all", { method: "POST", cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) { hint("已取消 " + (data.canceled ? data.canceled.length : 0) + " 个在途任务"); notifyCards(null); poll(); }
        else { hint("取消失败：" + ((data && data.error) || "未知错误")); }
      })
      .catch(function () { hint("取消失败：网络错误"); });
  }

  function renderFilterBar() {
    var bar = document.getElementById("mgr-filters");
    if (!bar) return;
    bar.innerHTML = "";
    var items = [
      ["all", "全部"],
      ["active", "在途"],
      ["done", "已完成"],
      ["failed", "失败/取消"],
    ];
    // 终态全集（供“全部”清空）
    var FINAL_ALL = ["done", "failed", "canceled", "interrupted"];
    // 各分类的条数：2026-09-20 起数字标在标签里（工具栏那行「N 完成 · N 异常」删掉了）
    var tally = {
      all: tasks.length,
      active: tasks.filter(function (t) { return t.state === "running" || t.state === "pending"; }).length,
      done: tasks.filter(function (t) { return t.state === "done"; }).length,
      failed: tasks.filter(function (t) { return t.state === "failed" || t.state === "canceled" || t.state === "interrupted"; }).length,
    };
    items.forEach(function (it) {
      var b = el("button", "mgr-filter" + (filter === it[0] ? " active" : ""), it[1] + " (" + tally[it[0]] + ")");
      b.onclick = function () { filter = it[0]; expanded = null; renderFilterBar(); render(); };
      // 双击弹出下拉：不同分类给不同操作（在途→全部取消；其余→清空记录）
      b.ondblclick = function (e) {
        e.stopPropagation();
        var opts = [];
        if (it[0] === "all") {
          opts.push({ label: "清空全部记录（已结束）", onclick: function () { clearStates(FINAL_ALL); } });
        } else if (it[0] === "active") {
          opts.push({ label: "全部取消", onclick: function () { cancelAllActive(); } });
        } else if (it[0] === "done") {
          opts.push({ label: "清空完成记录", onclick: function () { clearStates(["done"]); } });
        } else if (it[0] === "failed") {
          opts.push({ label: "清空失败/取消记录", onclick: function () { clearStates(["failed", "canceled", "interrupted"]); } });
        }
        if (!opts.length) return;
        openFilterMenu(b, opts, e);
      };
      bar.appendChild(b);
    });
  }

  // 搜索框：输入即筛选；点叉号清空恢复全部
  function renderSearchBar() {
    var wrap = document.getElementById("mgr-search");
    if (!wrap) return;
    wrap.innerHTML = "";
    var box = el("div", "mgr-search-box");
    var icon = el("span", "mgr-search-icon", "⌕");
    var input = el("input", "mgr-search-input");
    input.type = "text";
    input.placeholder = "搜索文件名 / 地址 / 路径…";
    input.value = search;
    input.oninput = function () { search = input.value.trim(); render(); };
    input.onkeydown = function (e) { if (e.key === "Escape") { search = ""; input.value = ""; render(); } };
    var clearBtn = el("button", "mgr-search-clear" + (search ? " show" : ""), "×");
    clearBtn.title = "清除搜索";
    clearBtn.onclick = function () { search = ""; input.value = ""; clearBtn.classList.remove("show"); render(); };
    box.appendChild(icon);
    box.appendChild(input);
    box.appendChild(clearBtn);
    wrap.appendChild(box);
  }

  // 设置菜单：右上角齿轮，点开是下载地址 / 默认限速 / 同时下载上限 / 停滞阈值
  function renderSettingsMenu() {
    var wrap = document.getElementById("mgr-settings");
    if (!wrap) return;
    wrap.innerHTML = "";
    var btn = el("button", "mgr-settings-btn");
    btn.title = "设置";
    // 内联 SVG：齿轮线性图标（stroke currentColor，跟随主题）
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="17" height="17"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    btn.onclick = function (e) {
      e.stopPropagation();
      var open = wrap.classList.toggle("open");
      if (open) {
        loadSettings(function () {
          var menu = wrap.querySelector(".mgr-settings-menu");
          if (menu) renderSettingsOptions(menu);
        });
      }
    };
    var menu = el("div", "mgr-settings-menu");
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    document.addEventListener("click", function closeMenu(ev) {
      if (!wrap.contains(ev.target)) {
        wrap.classList.remove("open");
        document.removeEventListener("click", closeMenu);
      }
    });
  }

  function closeSettingsMenu() {
    var w = document.getElementById("mgr-settings");
    if (w) w.classList.remove("open");
  }

  function renderSettingsOptions(menu) {
    menu.innerHTML = "";
    var modeDesc = settings.agentChooses ? "当前：助手选择下载地址" : (settings.defaultSaveDir ? "当前：" + settings.defaultSaveDir : "当前：插件默认目录");
    var desc = el("div", "mgr-settings-desc", modeDesc);
    menu.appendChild(desc);

    var opt1 = el("button", "mgr-settings-opt" + (!settings.agentChooses && settings.defaultSaveDir ? " active" : ""), "设置默认下载地址");
    opt1.title = "设置后所有文件统一下载到这里";
    opt1.onclick = function (e) {
      e.stopPropagation(); // 防止外部点击监听误关菜单
      // 宿主目录选择（hana.resources.pick / mode=directory）；宿主不可用时回退 prompt
      hana.resources.pick({ mode: "directory" })
        .then(function (res) {
          var dir = res && res.resources && res.resources[0] && res.resources[0].path;
          if (!dir) return;
          return apiFetch("/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ defaultSaveDir: dir, agentChooses: false }),
          }).then(function (r) { return r.json(); });
        })
        .then(function (data) {
          if (!data) return;
          if (data.ok) { settings = data.settings; renderSettingsOptions(menu); closeSettingsMenu(); hint("已设置默认下载目录"); }
          else hint("设置失败：" + (data.error || "未知错误"));
        })
        .catch(function () {
          // 宿主不可用 → prompt 手动输入
          var d = window.prompt("默认下载目录（绝对路径）", settings.defaultSaveDir || "");
          if (d == null) return;
          apiFetch("/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ defaultSaveDir: d.trim(), agentChooses: false }),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.ok) { settings = data.settings; renderSettingsOptions(menu); closeSettingsMenu(); hint("已设置默认下载目录"); }
              else hint("设置失败：" + (data.error || "未知错误"));
            })
            .catch(function () { hint("设置失败：网络错误"); });
        });
    };

    var opt2 = el("button", "mgr-settings-opt" + (settings.agentChooses ? " active" : ""), "助手选择下载地址");
    opt2.title = "下载位置由 Agent 自行决定，更自由";
    opt2.onclick = function (e) {
      e.stopPropagation(); // 防止外部点击监听误关菜单
      apiFetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentChooses: true }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) { settings = data.settings; renderSettingsOptions(menu); closeSettingsMenu(); hint("已切换为助手选择下载地址"); }
          else hint("设置失败：" + (data.error || "未知错误"));
        })
        .catch(function () { hint("设置失败：网络错误"); });
    };

    // 代理模式（2026-09-24）：一个按钮循环切换三档，写 config.json 的 proxy 字段。
    // auto = 国内源直连、国外源走代理（默认，通常不需要改）；always = 全走代理；never = 全直连。
    // 不关菜单，方便连续点着看效果。
    var PROXY_LABEL = { auto: "自动（国内直连 / 国外代理）", always: "始终走代理", never: "始终直连" };
    var PROXY_NEXT = { auto: "always", always: "never", never: "auto" };
    var curProxyMode = settings.proxyMode || "auto";
    var optProxy = el("button", "mgr-settings-opt active", "代理：" + PROXY_LABEL[curProxyMode]);
    optProxy.title = "点击切换：自动 → 始终走代理 → 始终直连。自动模式下国外源走代理、国内源直连（不依赖白名单）。";
    optProxy.onclick = function (e) {
      e.stopPropagation(); // 防止外部点击监听误关菜单
      var nextMode = PROXY_NEXT[curProxyMode] || "auto";
      apiFetch("/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyMode: nextMode }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            settings = data.settings;
            curProxyMode = settings.proxyMode || "auto";
            optProxy.textContent = "代理：" + PROXY_LABEL[curProxyMode];
            hint("已设置代理模式：" + PROXY_LABEL[curProxyMode]);
          } else hint("设置失败：" + (data.error || "未知错误"));
        })
        .catch(function () { hint("设置失败：网络错误"); });
    };

    // 数值型设置：内嵌输入框（App 卡片跑在宿主的 iframe 里，window.prompt 被屏蔽，点了没反应）
    // 0 一律表示「不限」：限速 0 = 不限速，并发 0 = 不限个数
    var opt3 = numberRow({
      label: "停滞判定阈值", unit: "ms", value: settings.stallTimeoutMs || 30000, min: 1000, step: 1000,
      title: "下载无新数据超过该时长就判定为停滞",
      save: function (v) { patchSettings({ stallTimeoutMs: v }, "已设置停滞阈值 " + v + " ms"); },
    });
    var opt4 = numberRow({
      label: "默认限速", unit: "KB/s", value: settings.speedLimit > 0 ? Math.round(settings.speedLimit / 1024) : 0, min: 0, step: 64,
      title: "任务自己没有单独限速时用这个值；0 表示不限速",
      save: function (v) { patchSettings({ speedLimit: Math.round(v * 1024) }, v > 0 ? "已设置默认限速 " + v + " KB/s" : "已取消默认限速"); },
    });
    var opt5 = numberRow({
      label: "同时下载上限", unit: "个", value: settings.maxConcurrent > 0 ? settings.maxConcurrent : 0, min: 0, step: 1,
      title: "同时处于下载中的任务数；超出的排队等待；0 表示不限",
      save: function (v) { patchSettings({ maxConcurrent: v }, v > 0 ? "已设置同时下载上限 " + v + " 个" : "已取消并发限制"); },
    });

    // ── 代理启停控制（2026-10-04）─────────────────────────────
    // 纪律：默认未授权；「使用现有代理」不受本开关影响（对齐裸 curl）。
    // 这里只控「启停梯子」这类改环境的动作。
    var optProxyCtl = el("button", "mgr-settings-opt", "代理启停：加载中…");
    var proxyCtlState = { enabled: false, launcher: null };
    function refreshProxyCtl() {
      apiFetch("/proxy-control/status")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || d.error) return;
          proxyCtlState.enabled = !!d.enabled;
          proxyCtlState.launcher = d.launcher || null;
          var nm = proxyCtlState.launcher ? proxyCtlState.launcher.name : "未配置梯子";
          optProxyCtl.textContent = "代理启停：" + (proxyCtlState.enabled ? "已授权" : "未授权") + "（" + nm + "）";
        })
        .catch(function () {});
    }
    optProxyCtl.title = "是否允许 Agent 启停本机梯子。默认关；「使用」现有代理不受此开关影响（机器开着代理就正常用，与 curl 一致）。";
    optProxyCtl.onclick = function (e) {
      e.stopPropagation();
      var next = !proxyCtlState.enabled;
      apiFetch("/proxy-control/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      })
        .then(function (r) { return r.json(); })
        .then(function () {
          refreshProxyCtl();
          hint(next ? "已授权：Agent 可以启停梯子" : "已收回授权：Agent 不能再启停梯子");
        })
        .catch(function () { hint("设置失败：网络错误"); });
    };
    refreshProxyCtl();

    // 扫描代理软件：找到候选后循环切换选哪个（与代理模式按钮同思路，不关菜单）
    var scanIdx = -1;
    var scanCache = [];
    var optScan = el("button", "mgr-settings-opt", "扫描代理软件");
    optScan.title = "在本机常见目录里找梯子（Clash / Verge / v2rayN 等）。多找到几个时再点一次切换。";
    optScan.onclick = function (e) {
      e.stopPropagation();
      if (scanCache.length && scanIdx >= 0) { scanIdx = (scanIdx + 1) % scanCache.length; applyScanPick(); return; }
      hint("扫描中…");
      apiFetch("/proxy-control/scan")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          scanCache = (d && d.candidates) || [];
          if (!scanCache.length) { hint("没有扫描到已知梯子；可手工在 config.json 写 proxyControl.launcher。"); return; }
          scanIdx = 0;
          applyScanPick();
        })
        .catch(function () { hint("扫描失败：网络错误"); });
    };
    function applyScanPick() {
      var c = scanCache[scanIdx];
      if (!c) return;
      apiFetch("/proxy-control/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launcher: { id: c.id, name: c.name, exe: c.exe, workDir: c.workDir, processName: c.processName, processNames: c.processNames, port: c.port, note: c.note } }),
      })
        .then(function (r) { return r.json(); })
        .then(function () {
          refreshProxyCtl();
          hint("已选：" + c.name + "（" + (scanIdx + 1) + "/" + scanCache.length + "）· " + c.exe);
        })
        .catch(function () { hint("保存失败：网络错误"); });
    }

    // 实测当前配置：起 → 探端口 → 停（恢复原状）；梯子已在跑时不动它
    var optVerify = el("button", "mgr-settings-opt", "实测当前配置");
    optVerify.title = "真起一次梯子、探端口、再停掉，验证配方可用。梯子已在运行时不会动它。";
    optVerify.onclick = function (e) {
      e.stopPropagation();
      if (!proxyCtlState.launcher) { hint("先扫描/选择梯子再实测"); return; }
      hint("实测中（最多 25 秒）…");
      apiFetch("/proxy-control/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launcher: proxyCtlState.launcher }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          hint((d && d.message) || (d && d.ok ? "实测通过" : "实测未通过"));
          refreshProxyCtl();
        })
        .catch(function () { hint("实测失败：网络错误"); });
    };

    menu.appendChild(opt1);
    menu.appendChild(opt2);
    menu.appendChild(optProxy);
    menu.appendChild(optProxyCtl);
    menu.appendChild(optScan);
    menu.appendChild(optVerify);
    menu.appendChild(opt3);
    menu.appendChild(opt4);
    menu.appendChild(opt5);
  }

  // 数值型设置行：标签 + 数字输入框 + 单位，回车或失焦即保存。
  // 不用 window.prompt 的原因：App 卡片跑在宿主的 iframe 里，prompt 被屏蔽，点了毫无反应
  //（2026-09-20 用户实测反馈「这三个点了没有效果」）。
  function numberRow(cfg) {
    var row = el("div", "mgr-settings-row");
    if (cfg.title) row.title = cfg.title;
    var min = cfg.min != null ? cfg.min : 0;
    var label = el("span", "mgr-settings-label", cfg.label);
    var input = document.createElement("input");
    input.type = "number";
    input.className = "mgr-settings-input";
    input.value = String(cfg.value);
    input.min = String(min);
    if (cfg.step != null) input.step = String(cfg.step);
    var unit = el("span", "mgr-settings-unit", cfg.unit || "");
    var commit = function () {
      var v = parseInt(input.value, 10);
      if (!isFinite(v) || v < min) { hint("请输入不小于 " + min + " 的整数"); input.value = String(cfg.value); return; }
      if (v === cfg.value) return;
      cfg.save(v);
    };
    input.onkeydown = function (e) { if (e.key === "Enter") { e.stopPropagation(); commit(); } };
    input.onblur = commit;
    // 阻止冒泡：菜单外有 document 级点击监听，不拦会把菜单关掉
    input.onclick = function (e) { e.stopPropagation(); };
    input.onmousedown = function (e) { e.stopPropagation(); };
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(unit);
    return row;
  }

  // 只提交设置，不重绘也不关菜单：数值项改完还能接着改别的
  function patchSettings(patch, okText) {
    apiFetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) { settings = data.settings || settings; hint(okText || "已保存"); }
        else hint("设置失败：" + ((data && data.error) || "未知错误"));
      })
      .catch(function () { hint("设置失败：网络错误"); });
  }

  // 设置项的统一保存路径：写引擎设置 → 刷新本地快照 → 重绘菜单
  function saveSetting(patch, menu, okText) {
    apiFetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.ok) {
          settings = data.settings || settings;
          renderSettingsOptions(menu);
          closeSettingsMenu();
          hint(okText || "已保存");
        } else hint("设置失败：" + ((data && data.error) || "未知错误"));
      })
      .catch(function () { hint("设置失败：网络错误"); });
  }

  function fmtLimit(v) {
    if (!v || v <= 0) return "不限";
    return fmtBytes(v) + "/s";
  }

  function loadSettings(cb) {
    apiFetch("/settings", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) { if (data.ok) settings = data.settings || {}; cb && cb(); })
      .catch(function () { cb && cb(); });
  }

  // ── 操作 ──
  function hint(text) {
    var h = el("div", "mgr-hint", text);
    document.body.appendChild(h);
    setTimeout(function () { h.remove(); }, 3000);
  }
  function openFile(t) {
    if (!t || !t.filePath) { hint("该任务没有可打开的文件路径"); return; }
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: t.filePath, mode: "open" }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) hint(d.error || "打开失败"); })
      .catch(function () { hint("打开失败：网络错误"); });
  }
  function reveal(t) {
    if (!t || !t.filePath) { hint("该任务没有可打开的文件路径"); return; }
    // 服务端 explorer /select 定位文件并打开所在文件夹（绕过宿主 platform 限制）
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: t.filePath }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) hint((d.error) || "打开文件夹失败"); })
      .catch(function () { hint("打开文件夹失败：网络错误"); });
  }
  // 删除单条记录；deleteFile=true 时连同磁盘产物一起删（服务端守护在途任务与工作目录）
  function forgetTask(t, deleteFile) {
    if (!t) return;
    if (t.state === "running" || t.state === "pending") { hint("任务仍在进行中，请先取消再删除"); return; }
    if (deleteFile) {
      var nm = t.fileName || t.filePath || "该文件";
      if (!window.confirm("删除记录并同时删除文件？\n\n" + nm + "\n\n此操作不可恢复。")) return;
    }
    apiFetch("/download/forget", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: t.taskId, deleteFile: !!deleteFile }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { hint((d && d.error) || "删除失败"); return; }
        notifyCards(t && t.taskId);
        if (d.fileError) hint("记录已删除，文件删除失败：" + d.fileError);
        else if (d.fileSkipped) hint("已删除记录，" + d.fileSkipped);
        else hint(deleteFile ? "已删除记录及文件" : "已删除记录");
        poll();
      })
      .catch(function () { hint("删除失败：网络错误"); });
  }
  function openFolder(dir) {
    apiFetch("/download/reveal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && !d.ok) hint((d.error) || "打开文件夹失败"); })
      .catch(function () { hint("打开文件夹失败：网络错误"); });
  }
  function copyPath(t) {
    try { hana.clipboard.writeText(t.filePath || ""); } catch (e) { /* 复制失败不弹窗 */ }
  }
  function cancelTask(t) {
    apiFetch("/download/cancel?taskId=" + encodeURIComponent(t.taskId), { method: "POST", cache: "no-store" })
      .then(function () { notifyCards(t && t.taskId); poll(); })
      .catch(function () {});
  }
  // 重试：走 App 的 /retry（不是引擎透传），App 会在受理后起一个终态守望，
  // 任务结束时往原会话投一条隐藏记录，让 agent 知道重试结果（2026-09-20）
  function retryTask(t) {
    if (!t) return;
    apiFetch("/download/retry", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: t.taskId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { hint((d && d.error) || "重试失败"); return; }
        hint(d.queued ? "已重新排队，等前面的任务结束" : "已重新开始");
        notifyCards(t && t.taskId); // 叫醒对应卡片：它此前停在终态，已不再快频轮询
        poll();
      })
      .catch(function () { hint("重试失败：网络错误"); });
  }

  // ── 轮询 ──
  var timer = null;
  function poll() {
    apiFetch("/download/list", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) return;
        var prevStates = {};
        tasks.forEach(function (t) { prevStates[t.taskId] = t.state; });
        tasks = data.tasks || [];
        // 展开项若已不存在则收起
        if (expanded && !tasks.some(function (t) { return t.taskId === expanded; })) expanded = null;
        var changed = tasks.some(function (t) { return prevStates[t.taskId] !== t.state; })
          || Object.keys(prevStates).length !== tasks.length;
        renderFilterBar();
        render();
        if (!changed) { /* 静默刷新，不重排视觉；render 已处理 */ }
      })
      .catch(function () { /* 网络错误静默重试 */ });
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function start() {
    if (timer) clearInterval(timer);
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  // ── 初始化 ──
  function init() {
    // 顶部工具条：搜索框 + 齿轮（计数已移到下方分类标签里）
    var toolbar = el("div", "mgr-toolbar");
    var settingsWrap = el("div", "mgr-settings");
    settingsWrap.id = "mgr-settings";
    var searchWrap = el("div", "mgr-search");
    searchWrap.id = "mgr-search";
    // 齿轮放最右（右上角）：搜索在左，设置靠右
    // （原来的「N 完成 · N 异常」计数已删，数字改标在下方分类标签里）
    toolbar.appendChild(searchWrap);
    toolbar.appendChild(settingsWrap);

    var filters = el("div", "mgr-filters");
    filters.id = "mgr-filters";
    var list = el("div", "mgr-list");
    list.id = "mgr-list";
    var root = document.getElementById("dl-root");
    if (!root) return;
    root.appendChild(toolbar);
    root.appendChild(filters);
    root.appendChild(list);

    renderSettingsMenu();
    renderSearchBar();

    // 每轮渲染后更新计数与搜索清除钮状态
    var origRender = render;
    render = function () {
      origRender();
      var cb = document.querySelector(".mgr-search-clear");
      if (cb) cb.classList.toggle("show", !!search);
    };

    start();
    reportSize();
    // resize 时重报一次高度（宿主裁剪/调整 iframe 后，body 内容不变则报告值稳定，无循环风险）
    window.addEventListener("resize", function () { reportSize(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
