// ============================================================
//  会员追踪 · 前端逻辑
//  数据来自后端接口 /api/members（所有访问者共享同一份）
// ============================================================
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_CLS = {
  "提交中": "info", "不处理": "muted", "冻结": "warning", "已处理": "good", "异常": "critical",
};
const ALL_STATUSES = ["提交中", "不处理", "冻结", "已处理", "异常"];
// 待处理页提供的状态按钮
const PENDING_ACTIONS = ["提交中", "不处理", "冻结"];
let pendSel = new Set();      // 待处理多选
let pendVisible = [];         // 当前可见的待处理编号（供全选用）
// 所有平台（按你给的两排）
const PLAT_ROWS = [
  ["XH", "SH", "YS", "JY", "HS", "RF", "LS", "OL", "XO", "XY"],
  ["FB", "SY", "LY", "MT", "JD", "ND", "YD"],
];
let ovPlat = "全部";
let pendPlat = "全部";
function buildPlatSeg(id, active) {
  const box = document.getElementById(id);
  if (!box) return;
  const btn = (p) => `<button data-plat="${p}" class="${p === active ? "is-active" : ""}">${p}</button>`;
  box.innerHTML =
    `<div class="plat-line">${btn("全部")}${PLAT_ROWS[0].map(btn).join("")}</div>` +
    `<div class="plat-line">${PLAT_ROWS[1].map(btn).join("")}</div>`;
}

let state = { members: [], today: "", statuses: ALL_STATUSES, user: null, config: { maxMembers: 0, groups: [] }, announcements: [] };
let pendGroup = "全部";
let editingMemberId = null;   // 待处理内联编辑中的会员
let freezingMemberId = null;  // 待处理正在填冻结内容的会员

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTime = (iso) => iso ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : "—";
const pill = (st) => `<span class="pill pill-${STATUS_CLS[st] || "muted"}">${st}</span>`;

// ---------- 主题 ----------
const root = document.documentElement;
const savedTheme = localStorage.getItem("theme");
if (savedTheme) root.setAttribute("data-theme", savedTheme);
$("#themeToggle").addEventListener("click", () => {
  const cur = root.getAttribute("data-theme");
  const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const next = cur === "dark" ? "light" : cur === "light" ? "dark" : (sysDark ? "light" : "dark");
  root.setAttribute("data-theme", next); localStorage.setItem("theme", next);
});

// ---------- Toast ----------
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 200); }, 2000);
}

// ---------- 后端接口 ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = "/login"; throw new Error("未登录"); }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}
async function loadMembers() {
  try {
    const d = await api("/api/members");
    state.members = d.members || [];
    state.today = d.today || "";
    state.statuses = d.statuses || ALL_STATUSES;
    if (d.config) state.config = d.config;
    state.announcements = d.announcements || [];
    if (d.user) { state.user = d.user; applyUserUI(); }
    populateGroups();
    stampUpdated();
  } catch (e) { toast("加载失败：" + e.message); }
}
function applyUserUI() {
  const u = state.user; if (!u) return;
  const el = $("#userInfo");
  if (el) el.textContent = `${u.nickname || u.username}`;
  const isAdmin = u.role === "admin";
  $$(".admin-only").forEach((x) => x.classList.toggle("hidden", !isAdmin));
}
function groupOptions(cur) {
  const gs = state.config.groups || [];
  return `<option value="">（无）</option>` +
    gs.map((g) => `<option value="${esc(g)}" ${g === cur ? "selected" : ""}>${esc(g)}</option>`).join("");
}
function populateGroups() {
  const gs = state.config.groups || [];
  const nsel = $("#newGroupSel"); if (nsel) { const c = nsel.value; nsel.innerHTML = groupOptions(c); }
  const bsel = $("#batchGroupSel");
  if (bsel) bsel.innerHTML = `<option value="">设组别…</option>` + gs.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("");
  const seg = $("#pendGroupSeg");
  if (seg) {
    const btn = (g, label) => `<button data-group="${esc(g)}" class="${pendGroup === g ? "is-active" : ""}">${esc(label || g)}</button>`;
    seg.innerHTML = btn("全部", "全部") + gs.map((g) => btn(g)).join("") + btn("（未分组）", "未分组");
  }
}
function stampUpdated() {
  const el = $("#lastUpdated");
  if (!el) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  el.textContent = `更新于 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
async function setStatus(id, status, note) {
  try {
    const body = { status };
    if (note !== undefined) body.note = note;
    await api(`/api/members/${encodeURIComponent(id)}/status`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await loadMembers();
    renderCurrent();
    toast(`已设为「${status}」`);
  } catch (e) { toast("操作失败：" + e.message); }
}
async function deleteMember(id, name) {
  if (!window.confirm(`确定删除会员「${name}」（${id}）？此操作不可撤销。`)) return;
  try {
    await api(`/api/members/${encodeURIComponent(id)}/delete`, { method: "POST" });
    await loadMembers();
    renderCurrent();
    toast("已删除");
  } catch (e) { toast("删除失败：" + e.message); }
}
async function batchDeleteIds(ids, after) {
  if (!ids.length) { toast("请先勾选会员"); return; }
  if (!window.confirm(`确定删除选中的 ${ids.length} 笔？此操作不可撤销。`)) return;
  try {
    const r = await api("/api/members/delete-batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (after) after();
    await loadMembers();
    renderCurrent();
    toast(`已删除 ${r.deleted} 笔`);
  } catch (e) { toast("删除失败：" + e.message); }
}

// ---------- 数据筛选 ----------
const pendingMembers = () => state.members.filter((m) => m.status === "提交中");
const countStatus = (s) => state.members.filter((m) => m.status === s).length;
// 统一的搜索匹配：平台/会员/最后登入时间/原因/备注/状态/编号
function matchMember(m, q) {
  q = q.trim().toLowerCase();
  if (!q) return true;
  return [m.platform, m.account, m.lastLogin, m.reason, m.remark, m.status, m.id]
    .some((v) => (v || "").toLowerCase().includes(q));
}
// 平台匹配：会员的平台栏可能含多个平台（如「HS YS JY」），只要包含该代码即命中
function platMatch(m, plat) {
  if (plat === "全部") return true;
  const tokens = String(m.platform || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return tokens.includes(plat.toUpperCase());
}

// ---------- 日期筛选（年/月）通用逻辑：历史 + 总览共用 ----------
const dateOf = (m) => (m.updatedAt || "").slice(0, 10);   // YYYY-MM-DD（按更新时间）
let histState = { scope: "today", year: "", month: "全部", status: "全部" };
let histSel = new Set();       // 历史多选
let histVisible = [];          // 历史当前可见编号
let ovDate = { scope: "all", year: "", month: "全部" };   // 总览日期，默认全部

function fillDateSelects(yearSel, monSel, st) {
  const curY = state.today.slice(0, 4);
  const years = Array.from(new Set(state.members.map((m) => dateOf(m).slice(0, 4)).filter(Boolean)));
  if (!years.includes(curY)) years.push(curY);
  years.sort().reverse();
  yearSel.innerHTML = years.map((y) => `<option value="${y}">${y}年</option>`).join("");
  yearSel.value = st.year || curY;
  monSel.innerHTML = `<option value="全部">全部月</option>` +
    Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, "0")}">${i + 1}月</option>`).join("");
  monSel.value = st.month;
}
function populateHistSelects() { fillDateSelects($("#histYear"), $("#histMonth"), histState); }
function resetHistFilter() {
  histState = { scope: "today", year: state.today.slice(0, 4), month: state.today.slice(5, 7), status: "全部" };
  populateHistSelects();
  $$("#histDateSeg button").forEach((b) => b.classList.toggle("is-active", b.dataset.scope === "today"));
  $$("#histStatusSeg button").forEach((b) => b.classList.toggle("is-active", b.dataset.st === "全部"));
  $("#histYear").hidden = true;
  $("#histMonth").hidden = true;
  $("#historySearch").value = "";
}
function inDateScope(m, sc, year, month) {
  const d = dateOf(m);
  if (sc === "all") return true;
  if (!d) return false;
  if (sc === "today") return d === state.today;
  if (sc === "month") return d.slice(0, 7) === state.today.slice(0, 7);
  if (sc === "year")  return d.slice(0, 4) === state.today.slice(0, 4);
  if (month === "全部") return d.slice(0, 4) === year;   // custom·整年
  return d.slice(0, 7) === `${year}-${month}`;            // custom·年月
}
const histDateMatch = (m) => inDateScope(m, histState.scope, histState.year, histState.month);
function scopeLabelOf(st) {
  return { today: "今日", month: "本月", year: "本年", all: "全部" }[st.scope] ||
    (st.month === "全部" ? `${st.year}年` : `${st.year}-${st.month}`);
}
const scopeLabel = () => scopeLabelOf(histState);

// ---------- 渲染：总览 ----------
let editingAnnId = null;
const annDate = (a) => (a.createdAt || "").slice(0, 16).replace("T", " ");
function annBoardHtml(a) {
  return `<div class="ann-item">
      <div class="ann-meta muted tiny">${annDate(a)}</div>
      <div class="ann-text">${esc(a.text).replace(/\n/g, "<br>")}</div>
    </div>`;
}
function annEditorHtml(a) {
  if (a.id === editingAnnId) {
    return `<div class="ann-item">
      <div class="ann-meta muted tiny">${annDate(a)}</div>
      <textarea class="ann-edit-input" rows="5">${esc(a.text)}</textarea>
      <div class="ann-actions">
        <button class="btn-primary btn-xs" data-annsave="${esc(a.id)}">保存</button>
        <button class="btn-ghost btn-xs" data-anncancel="1">取消</button>
      </div>
    </div>`;
  }
  return `<div class="ann-item">
      <div class="ann-meta muted tiny">${annDate(a)}</div>
      <div class="ann-text">${esc(a.text).replace(/\n/g, "<br>")}</div>
      <div class="ann-actions">
        <button class="btn-ghost btn-xs" data-annedit="${esc(a.id)}">编辑</button>
        <button class="btn-del btn-xs" data-anndel="${esc(a.id)}">删除</button>
      </div>
    </div>`;
}
function renderOverview() {
  const anns = state.announcements || [];
  const board = $("#announceBoard");
  if (board) {
    board.hidden = !anns.length;
    $("#announceContent").innerHTML = anns.map((a) => annBoardHtml(a)).join("");
  }
  const inPlat = state.members.filter((m) =>
    platMatch(m, ovPlat) &&
    inDateScope(m, ovDate.scope, ovDate.year, ovDate.month));
  const cnt = (s) => inPlat.filter((m) => m.status === s).length;
  const ctx = [ovPlat !== "全部" ? ovPlat : "", scopeLabelOf(ovDate) !== "全部" ? scopeLabelOf(ovDate) : ""]
    .filter(Boolean).join(" · ");
  const stats = [
    { label: "目前提交中的会员", value: cnt("提交中"), hint: ctx || "待处理" },
  ];
  (state.config.groups || []).forEach((g) => {
    const n = inPlat.filter((m) => m.status === "提交中" && (m.group || "") === g).length;
    stats.push({ label: `群组：${g}`, value: n, hint: (ctx ? ctx + " · " : "") + "提交中" });
  });
  $("#ovStats").innerHTML = stats.map((s) => `
    <div class="kpi">
      <div class="kpi-label">${s.label}</div>
      <div class="kpi-value">${s.value}<span class="kpi-unit"> 笔</span></div>
      <div class="muted tiny">${s.hint}</div>
    </div>`).join("");

  const rows = inPlat.slice()
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 10);
  $("#ovPendingBody").innerHTML = rows.length ? rows.map((m) => `
    <tr>
      <td class="nowrap">${esc(m.id)}</td>
      <td>${esc(m.platform) || "—"}</td>
      <td>${esc(m.account)}</td>
      <td><div class="cell-clip" title="${esc(m.reason)}">${esc(m.reason) || "—"}</div></td>
      <td><div class="cell-clip" title="${esc(m.remark)}">${esc(m.remark) || "—"}</div></td>
      <td>${pill(m.status)}</td>
      <td class="center nowrap">${fmtTime(m.updatedAt)}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty-row muted">暂无记录</td></tr>`;
}

// ---------- 渲染：待处理 ----------
function renderPending() {
  // 清理已不在提交中的选择
  const pendingIds = new Set(pendingMembers().map((m) => m.id));
  pendSel.forEach((id) => { if (!pendingIds.has(id)) pendSel.delete(id); });

  const q = ($("#pendingSearch").value || "").trim();
  let rows = pendingMembers();
  if (pendPlat !== "全部") rows = rows.filter((m) => platMatch(m, pendPlat));
  if (pendGroup === "（未分组）") rows = rows.filter((m) => !(m.group || "").trim());
  else if (pendGroup !== "全部") rows = rows.filter((m) => (m.group || "") === pendGroup);
  if (q) rows = rows.filter((m) => matchMember(m, q));
  pendVisible = rows.map((m) => m.id);
  const filtered = pendPlat !== "全部" || pendGroup !== "全部" || q;
  $("#pendingCount").textContent = `共 ${rows.length} 笔提交中${filtered ? "（已筛选）" : ""}`;
  const box = $("#pendingList");
  if (!rows.length) {
    const msg = filtered ? "没有匹配的记录" : "暂无提交中的会员";
    box.innerHTML = `<p class="empty-row muted" style="padding:32px;text-align:center">${msg}</p>`;
    updateBatchBar(); return;
  }
  const line = (label, val) => val ? `<div class="rec-sub muted">${label}：${esc(val)}</div>` : "";
  box.innerHTML = rows.map((m) =>
    m.id === editingMemberId ? memberEditHtml(m)
    : m.id === freezingMemberId ? memberFreezeHtml(m)
    : `
    <div class="rec ${pendSel.has(m.id) ? "is-sel" : ""}">
      <input type="checkbox" class="rec-check" data-check="${esc(m.id)}" ${pendSel.has(m.id) ? "checked" : ""} aria-label="选择">
      <div class="rec-main">
        <div class="rec-title">${esc(m.account)} <span class="muted">· ${esc(m.platform) || "无平台"}</span>${m.group ? ` <span class="group-tag">${esc(m.group)}</span>` : ""}</div>
        ${line("最后登入", m.lastLogin)}
        ${line("原因", m.reason)}
        ${line("备注", m.remark)}
        ${line("冻结内容", m.note)}
        <div class="rec-meta muted tiny">${esc(m.id)} · 更新 ${fmtTime(m.updatedAt)}</div>
      </div>
      <div class="rec-actions">
        <span class="rec-label muted tiny">设为</span>
        <div class="btn-group">
          ${PENDING_ACTIONS.map((st) => `<button class="chip chip-${STATUS_CLS[st]} ${m.status === st ? "is-active" : ""}" data-id="${esc(m.id)}" data-status="${st}">${st}</button>`).join("")}
        </div>
        <button class="btn-ghost btn-xs" data-medit="${esc(m.id)}">编辑</button>
        <button class="btn-del" data-del="${esc(m.id)}" data-name="${esc(m.account)}" title="删除">🗑</button>
      </div>
    </div>`).join("");
  updateBatchBar();
}
function memberEditHtml(m) {
  return `<div class="rec rec-editing">
    <div class="rec-edit">
      <div class="ef-grid">
        <label class="ef">平台<input class="mini-input" data-f="platform" value="${esc(m.platform)}"></label>
        <label class="ef">会员<input class="mini-input" data-f="account" value="${esc(m.account)}"></label>
        <label class="ef">最后登入时间<input class="mini-input" data-f="lastLogin" value="${esc(m.lastLogin)}"></label>
        <label class="ef">群组<select class="mini-input" data-f="group">${groupOptions(m.group)}</select></label>
      </div>
      <label class="ef">原因<textarea class="ann-edit-input" data-f="reason" rows="2">${esc(m.reason)}</textarea></label>
      <label class="ef">备注<textarea class="ann-edit-input" data-f="remark" rows="2">${esc(m.remark)}</textarea></label>
      <label class="ef">冻结内容<textarea class="ann-edit-input" data-f="note" rows="2">${esc(m.note || "")}</textarea></label>
      <div class="ann-actions">
        <button class="btn-primary btn-xs" data-medsave="${esc(m.id)}">保存</button>
        <button class="btn-ghost btn-xs" data-medcancel="1">取消</button>
      </div>
    </div>
  </div>`;
}
function memberFreezeHtml(m) {
  return `<div class="rec rec-editing">
    <div class="rec-edit">
      <div class="rec-title">${esc(m.account)} <span class="muted">· ${esc(m.platform) || "无平台"}</span> · <span style="color:var(--warning)">冻结</span></div>
      <label class="ef">冻结内容<textarea class="ann-edit-input" id="freezeNoteInput" rows="3" placeholder="输入冻结内容…">${esc(m.note || "")}</textarea></label>
      <div class="ann-actions">
        <button class="btn-primary btn-xs" data-freezeok="${esc(m.id)}">确认冻结</button>
        <button class="btn-ghost btn-xs" data-freezecancel="1">取消</button>
      </div>
    </div>
  </div>`;
}
function updateBatchBar() {
  const n = pendSel.size;
  const cnt = $("#batchCount"); if (cnt) cnt.textContent = `已选 ${n} 项`;
  const all = $("#pendAll");
  if (all) all.checked = pendVisible.length > 0 && pendVisible.every((id) => pendSel.has(id));
  const bar = $("#batchBar"); if (bar) bar.classList.toggle("has-sel", n > 0);
}
async function batchSetStatus(status, note) {
  const ids = [...pendSel];
  if (!ids.length) { toast("请先勾选会员"); return; }
  try {
    const body = { ids, status };
    if (note !== undefined) body.note = note;
    const r = await api("/api/members/status-batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    pendSel.clear();
    await loadMembers();
    renderCurrent();
    toast(`已将 ${r.updated} 笔设为「${status}」`);
  } catch (e) { toast("操作失败：" + e.message); }
}

// ---------- 渲染：历史 ----------
function renderHistory() {
  const allIds = new Set(state.members.map((m) => m.id));
  histSel.forEach((id) => { if (!allIds.has(id)) histSel.delete(id); });

  const q = ($("#historySearch").value || "").trim();
  let rows = state.members.slice().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  rows = rows.filter(histDateMatch);
  if (histState.status !== "全部") rows = rows.filter((m) => m.status === histState.status);
  if (q) rows = rows.filter((m) => matchMember(m, q));
  histVisible = rows.map((m) => m.id);
  $("#historyCount").textContent = `${scopeLabel()}${histState.status !== "全部" ? " · " + histState.status : ""} · 共 ${rows.length} 条`;
  $("#historyBody").innerHTML = rows.length ? rows.map((m) => `
    <tr class="${histSel.has(m.id) ? "row-sel" : ""}">
      <td class="chk-col"><input type="checkbox" class="hist-check" data-hcheck="${esc(m.id)}" ${histSel.has(m.id) ? "checked" : ""} aria-label="选择"></td>
      <td class="nowrap">${esc(m.id)}</td>
      <td>${esc(m.platform) || "—"}</td>
      <td>${esc(m.account)}</td>
      <td class="center nowrap">${esc(m.lastLogin) || "—"}</td>
      <td><div class="cell-wrap">${esc(m.reason) || "—"}</div></td>
      <td><div class="cell-wrap">${esc(m.remark) || "—"}${m.note ? `<br><span class="freeze-note">❄冻结内容：${esc(m.note)}</span>` : ""}</div></td>
      <td>${pill(m.status)}</td>
      <td class="center nowrap">${fmtTime(m.updatedAt)}</td>
      <td class="nowrap">
        <select class="status-sel" data-sid="${esc(m.id)}"><option value="">改状态…</option>${PENDING_ACTIONS.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
        <button class="btn-del" data-del="${esc(m.id)}" data-name="${esc(m.account)}" title="删除">🗑</button>
      </td>
    </tr>`).join("") : `<tr><td colspan="10" class="empty-row muted">没有匹配的记录</td></tr>`;
  updateHistBatchBar();
}
function updateHistBatchBar() {
  const cnt = $("#histBatchCount"); if (cnt) cnt.textContent = `已选 ${histSel.size} 项`;
  const all = $("#histAll");
  if (all) all.checked = histVisible.length > 0 && histVisible.every((id) => histSel.has(id));
}

// ---------- 视图路由 ----------
const META = {
  overview: { title: "总览",     sub: "会员提交状态一览" },
  pending:  { title: "待处理",   sub: "设置提交中会员的状态" },
  new:      { title: "新增",     sub: "新增提交会员" },
  history:  { title: "历史纪录", sub: "提交过的所有会员" },
  announce: { title: "公告编辑", sub: "编辑总览公告（管理员）" },
  accounts: { title: "账号管理", sub: "开设 / 删除账号（管理员）" },
  settings: { title: "设置",     sub: "群组与自动删除（管理员）" },
};
let currentView = "overview";

function renderCurrent() {
  if (currentView === "overview") renderOverview();
  else if (currentView === "pending") renderPending();
  else if (currentView === "history") renderHistory();
  else if (currentView === "accounts") renderAccounts();
  else if (currentView === "settings") renderSettings();
  else if (currentView === "announce") renderAnnounce();
  // new 视图是表单，无需渲染
}
function renderAnnounce() {
  const anns = state.announcements || [];
  $("#annCount").textContent = `共 ${anns.length} 条`;
  $("#annList").innerHTML = anns.length
    ? anns.map((a) => annEditorHtml(a)).join("")
    : `<p class="muted tiny" style="padding:12px">还没有公告</p>`;
}

// ---------- 渲染：账号管理 ----------
async function renderAccounts() {
  if (!state.user || state.user.role !== "admin") { showView("overview"); return; }
  try {
    const d = await api("/api/users");
    const users = d.users || [];
    $("#usersCount").textContent = `共 ${users.length} 个账号`;
    $("#usersBody").innerHTML = users.map((u) => `
      <tr>
        <td>${esc(u.username)}</td>
        <td>${esc(u.nickname) || "—"}</td>
        <td>${u.role === "admin" ? "管理员" : "一般人员"}</td>
        <td>
          <button class="btn-ghost btn-xs" data-setrole="${esc(u.username)}" data-role="${u.role === "admin" ? "staff" : "admin"}">${u.role === "admin" ? "设为一般" : "设为管理"}</button>
          <button class="btn-ghost btn-xs" data-setnick="${esc(u.username)}">改昵称</button>
          <button class="btn-ghost btn-xs" data-resetpw="${esc(u.username)}">改密码</button>
          <button class="btn-del btn-xs" data-deluser="${esc(u.username)}">删除</button>
        </td>
      </tr>`).join("");
  } catch (e) { toast(e.message); }
}

// ---------- 渲染：设置 ----------
let editGroups = [];
function renderSettings() {
  if (!state.user || state.user.role !== "admin") { showView("overview"); return; }
  editGroups = [...(state.config.groups || [])];
  renderGroupList();
  $("#maxMembersInput").value = state.config.maxMembers || 0;
}
function renderGroupList() {
  const box = $("#groupList");
  if (!box) return;
  box.innerHTML = editGroups.length
    ? editGroups.map((g, i) => `<span class="group-chip">${esc(g)}<button data-rmgroup="${i}" title="移除">×</button></span>`).join("")
    : `<span class="muted tiny">还没有群组，下面添加</span>`;
}

function showView(name) {
  if (!META[name]) name = "overview";
  currentView = name;
  $$(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
  $$("#nav .nav-item").forEach((a) => a.classList.toggle("is-active", a.dataset.view === name));
  $("#pageTitle").textContent = META[name].title;
  $("#pageSub").textContent = META[name].sub;
  if (name === "history") resetHistFilter();   // 每次进历史都回到「今日」
  renderCurrent();
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}

// ---------- 事件绑定 ----------
$("#nav").addEventListener("click", (e) => {
  const a = e.target.closest(".nav-item");
  if (!a) return;
  e.preventDefault(); showView(a.dataset.view);
});
document.addEventListener("click", (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) { showView(goto.dataset.goto); return; }
  const chip = e.target.closest(".chip[data-status]");
  if (chip && !chip.classList.contains("is-active")) {
    if (currentView === "pending" && chip.dataset.status === "冻结") {
      freezingMemberId = chip.dataset.id; editingMemberId = null;
      renderPending();
      const ta = $("#freezeNoteInput"); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      return;
    }
    setStatus(chip.dataset.id, chip.dataset.status); return;
  }
  const del = e.target.closest(".btn-del[data-del]");
  if (del) deleteMember(del.dataset.del, del.dataset.name);
});
$("#pendingSearch").addEventListener("input", renderPending);
$("#historySearch").addEventListener("input", renderHistory);

// 平台筛选：总览
$("#ovPlatSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-plat]"); if (!b) return;
  ovPlat = b.dataset.plat;
  $$("#ovPlatSeg button").forEach((x) => x.classList.toggle("is-active", x === b));
  renderOverview();
});
// 平台筛选：待处理
$("#pendPlatSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-plat]"); if (!b) return;
  pendPlat = b.dataset.plat;
  $$("#pendPlatSeg button").forEach((x) => x.classList.toggle("is-active", x === b));
  renderPending();
});

// 待处理：内联编辑
$("#pendingList").addEventListener("click", async (e) => {
  const ed = e.target.closest("[data-medit]");
  if (ed) {
    editingMemberId = ed.dataset.medit;
    renderPending();
    const inp = $('#pendingList .rec-editing input[data-f="account"]');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    return;
  }
  const cancel = e.target.closest("[data-medcancel]");
  if (cancel) { editingMemberId = null; renderPending(); return; }
  const fok = e.target.closest("[data-freezeok]");
  if (fok) {
    const id = fok.dataset.freezeok;
    const note = ($("#freezeNoteInput").value || "").trim();
    freezingMemberId = null;
    await setStatus(id, "冻结", note);
    return;
  }
  const fcancel = e.target.closest("[data-freezecancel]");
  if (fcancel) { freezingMemberId = null; renderPending(); return; }
  const save = e.target.closest("[data-medsave]");
  if (save) {
    const id = save.dataset.medsave;
    const payload = {};
    save.closest(".rec-editing").querySelectorAll("[data-f]").forEach((el) => { payload[el.dataset.f] = el.value; });
    if (!(payload.account || "").replace(/[^A-Za-z0-9]/g, "")) { toast("会员账号不能为空"); return; }
    try {
      await api(`/api/members/${encodeURIComponent(id)}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      editingMemberId = null;
      await loadMembers(); renderCurrent(); toast("已保存");
    } catch (err) { toast("保存失败：" + err.message); }
  }
});
// 待处理：多选勾选
$("#pendingList").addEventListener("change", (e) => {
  const cb = e.target.closest(".rec-check[data-check]");
  if (!cb) return;
  const id = cb.dataset.check;
  if (cb.checked) pendSel.add(id); else pendSel.delete(id);
  const rec = cb.closest(".rec"); if (rec) rec.classList.toggle("is-sel", cb.checked);
  updateBatchBar();
});
// 全选（当前可见）
$("#pendAll").addEventListener("change", (e) => {
  if (e.target.checked) pendVisible.forEach((id) => pendSel.add(id));
  else pendVisible.forEach((id) => pendSel.delete(id));
  renderPending();
});
// 批量设为状态
$("#batchActions").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-batch]"); if (!b) return;
  if (b.dataset.batch === "冻结") {
    if (!pendSel.size) { toast("请先勾选会员"); return; }
    $("#batchFreeze").hidden = false;
    $("#batchFreezeNote").focus();
    return;
  }
  batchSetStatus(b.dataset.batch);
});
$("#batchFreezeCancel").addEventListener("click", () => { $("#batchFreeze").hidden = true; });
$("#batchFreezeOk").addEventListener("click", async () => {
  const note = $("#batchFreezeNote").value.trim();
  $("#batchFreeze").hidden = true;
  await batchSetStatus("冻结", note);
  $("#batchFreezeNote").value = "";
});
// 待处理：批量删除
$("#pendBatchDel").addEventListener("click", () => batchDeleteIds([...pendSel], () => pendSel.clear()));

// 历史：多选勾选
$("#historyBody").addEventListener("change", async (e) => {
  const cb = e.target.closest(".hist-check[data-hcheck]");
  if (cb) {
    const id = cb.dataset.hcheck;
    if (cb.checked) histSel.add(id); else histSel.delete(id);
    const tr = cb.closest("tr"); if (tr) tr.classList.toggle("row-sel", cb.checked);
    updateHistBatchBar();
    return;
  }
  const sel = e.target.closest(".status-sel[data-sid]");
  if (sel && sel.value) {
    const id = sel.dataset.sid, status = sel.value;
    sel.value = "";
    await setStatus(id, status);
  }
});
$("#histAll").addEventListener("change", (e) => {
  if (e.target.checked) histVisible.forEach((id) => histSel.add(id));
  else histVisible.forEach((id) => histSel.delete(id));
  renderHistory();
});
$("#histBatchDel").addEventListener("click", () => batchDeleteIds([...histSel], () => histSel.clear()));

// 退出登录
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch (e) {}
  location.href = "/login";
});
// 公告：发布
$("#postAnnounceBtn").addEventListener("click", async () => {
  const text = $("#announceInput").value.trim();
  if (!text) { toast("内容不能为空"); return; }
  try {
    await api("/api/announcements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    $("#announceInput").value = "";
    await loadMembers(); renderCurrent(); toast("已发布");
  } catch (e) { toast("发布失败：" + e.message); }
});
// 公告：内联编辑 / 删除
$("#annList").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-anndel]");
  if (del) {
    if (!window.confirm("确定删除这条公告？")) return;
    try { await api(`/api/announcements/${encodeURIComponent(del.dataset.anndel)}/delete`, { method: "POST" }); editingAnnId = null; await loadMembers(); renderCurrent(); toast("已删除"); }
    catch (err) { toast(err.message); }
    return;
  }
  const ed = e.target.closest("[data-annedit]");
  if (ed) {
    editingAnnId = ed.dataset.annedit;
    renderAnnounce();
    const ta = $("#annList .ann-edit-input");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return;
  }
  const cancel = e.target.closest("[data-anncancel]");
  if (cancel) { editingAnnId = null; renderAnnounce(); return; }
  const save = e.target.closest("[data-annsave]");
  if (save) {
    const id = save.dataset.annsave;
    const ta = save.closest(".ann-item").querySelector(".ann-edit-input");
    const text = (ta.value || "").trim();
    if (!text) { toast("内容不能为空"); return; }
    try {
      await api(`/api/announcements/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      editingAnnId = null;
      await loadMembers(); renderCurrent(); toast("已更新");
    } catch (err) { toast(err.message); }
  }
});

// 自行修改密码（任何登录用户）
$("#changePwBtn").addEventListener("click", async () => {
  if (!state.user) return;
  const pw = window.prompt("设置你的新密码（至少 4 位）：");
  if (pw == null) return;
  if (pw.trim().length < 4) { toast("密码至少 4 位"); return; }
  const pw2 = window.prompt("再输入一次新密码确认：");
  if (pw2 == null) return;
  if (pw !== pw2) { toast("两次输入不一致"); return; }
  try {
    await api(`/api/users/${encodeURIComponent(state.user.username)}/password`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    toast("密码已修改，下次登录用新密码");
  } catch (e) { toast("修改失败：" + e.message); }
});

// 待处理：群组筛选
$("#pendGroupSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-group]"); if (!b) return;
  pendGroup = b.dataset.group;
  $$("#pendGroupSeg button").forEach((x) => x.classList.toggle("is-active", x === b));
  renderPending();
});
// 待处理：批量设群组
$("#batchGroupBtn").addEventListener("click", async () => {
  const ids = [...pendSel];
  if (!ids.length) { toast("请先勾选会员"); return; }
  const group = $("#batchGroupSel").value;
  try {
    const r = await api("/api/members/group-batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, group }),
    });
    pendSel.clear(); await loadMembers(); renderCurrent();
    toast(`已将 ${r.updated} 笔设为组别「${group || "无"}」`);
  } catch (e) { toast("操作失败：" + e.message); }
});

// 账号管理：新增账号
$("#userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = { username: f.username.value.trim(), nickname: f.nickname.value.trim(), password: f.password.value, role: f.role.value };
  if (!payload.username || payload.password.length < 4) { toast("用户名不能为空，密码至少4位"); return; }
  try {
    await api("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    f.reset();
    toast("已新增账号");
    renderAccounts();
  } catch (err) { toast("新增失败：" + err.message); }
});
// 账号管理：删除 / 改密码
$("#usersBody").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-deluser]");
  if (del) {
    const name = del.dataset.deluser;
    if (!window.confirm(`确定删除账号「${name}」？`)) return;
    try { await api(`/api/users/${encodeURIComponent(name)}/delete`, { method: "POST" }); toast("已删除"); renderAccounts(); }
    catch (err) { toast(err.message); }
    return;
  }
  const rp = e.target.closest("[data-resetpw]");
  if (rp) {
    const name = rp.dataset.resetpw;
    const pw = window.prompt(`为「${name}」设置新密码（至少4位）：`);
    if (pw == null) return;
    if (pw.trim().length < 4) { toast("密码至少4位"); return; }
    const pw2 = window.prompt("再输入一次新密码确认：");
    if (pw2 == null) return;
    if (pw !== pw2) { toast("两次输入不一致"); return; }
    try { await api(`/api/users/${encodeURIComponent(name)}/password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) }); toast(`已把「${name}」密码改为：${pw}`); }
    catch (err) { toast(err.message); }
    return;
  }
  const sr = e.target.closest("[data-setrole]");
  if (sr) {
    const name = sr.dataset.setrole, role = sr.dataset.role;
    const label = role === "admin" ? "管理员" : "一般人员";
    if (!window.confirm(`确定把「${name}」改为${label}？`)) return;
    try {
      await api(`/api/users/${encodeURIComponent(name)}/role`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
      toast(`已改为${label}`); renderAccounts();
      if (name === state.user.username) { state.user.role = role; applyUserUI(); }
    } catch (err) { toast(err.message); }
    return;
  }
  const nk = e.target.closest("[data-setnick]");
  if (nk) {
    const name = nk.dataset.setnick;
    const nick = window.prompt(`为「${name}」设置昵称（留空则清除）：`);
    if (nick == null) return;
    try {
      await api(`/api/users/${encodeURIComponent(name)}/nickname`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: nick.trim() }) });
      toast("已改昵称"); renderAccounts();
      if (name === state.user.username) { state.user.nickname = nick.trim(); applyUserUI(); }
    } catch (err) { toast(err.message); }
  }
});

// 设置：群组编辑（增删即时保存到后端）
async function saveGroups(groups) {
  try {
    const d = await api("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups }),
    });
    state.config = d.config || state.config;
    editGroups = [...(state.config.groups || [])];
    populateGroups();
    renderGroupList();
    return true;
  } catch (e) { toast("保存失败：" + e.message); return false; }
}
$("#groupAddBtn").addEventListener("click", async () => {
  const inp = $("#groupInput");
  const g = inp.value.trim();
  if (!g) return;
  if (editGroups.includes(g)) { toast("群组已存在"); return; }
  if (await saveGroups([...editGroups, g])) { inp.value = ""; toast(`已添加群组「${g}」`); }
});
$("#groupInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#groupAddBtn").click(); } });
$("#groupList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rmgroup]"); if (!b) return;
  const next = editGroups.filter((_, i) => i !== Number(b.dataset.rmgroup));
  if (await saveGroups(next)) toast("已移除群组");
});
// 设置：保存
$("#saveConfigBtn").addEventListener("click", async () => {
  const maxMembers = parseInt($("#maxMembersInput").value, 10);
  try {
    await api("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: editGroups, maxMembers: isNaN(maxMembers) ? 0 : maxMembers }),
    });
    await loadMembers();
    toast("已保存设置");
  } catch (e) { toast("保存失败：" + e.message); }
});

// 历史筛选：日期范围
$("#histDateSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scope]"); if (!b) return;
  histState.scope = b.dataset.scope;
  $$("#histDateSeg button").forEach((x) => x.classList.toggle("is-active", x === b));
  const custom = histState.scope === "custom";
  $("#histYear").hidden = !custom;
  $("#histMonth").hidden = !custom;
  renderHistory();
});
// 历史筛选：状态
$("#histStatusSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-st]"); if (!b) return;
  histState.status = b.dataset.st;
  $$("#histStatusSeg button").forEach((x) => x.classList.toggle("is-active", x === b));
  renderHistory();
});
// 历史筛选：自订年月
function toCustomScope() {
  histState.scope = "custom";
  $$("#histDateSeg button").forEach((x) => x.classList.toggle("is-active", x.dataset.scope === "custom"));
  $("#histYear").hidden = false; $("#histMonth").hidden = false;
}
$("#histYear").addEventListener("change", (e) => { histState.year = e.target.value; toCustomScope(); renderHistory(); });
$("#histMonth").addEventListener("change", (e) => { histState.month = e.target.value; toCustomScope(); renderHistory(); });
$("#refreshBtn").addEventListener("click", () => autoRefreshNow(true));

// 总览日期筛选
$("#ovDateSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-scope]"); if (!b) return;
  ovDate.scope = b.dataset.scope;
  $$("#ovDateSeg button").forEach((x) => x.classList.toggle("is-active", x === b));
  const custom = ovDate.scope === "custom";
  $("#ovYear").hidden = !custom;
  $("#ovMonth").hidden = !custom;
  renderOverview();
});
function ovToCustom() {
  ovDate.scope = "custom";
  $$("#ovDateSeg button").forEach((x) => x.classList.toggle("is-active", x.dataset.scope === "custom"));
  $("#ovYear").hidden = false; $("#ovMonth").hidden = false;
}
$("#ovYear").addEventListener("change", (e) => { ovDate.year = e.target.value; ovToCustom(); renderOverview(); });
$("#ovMonth").addEventListener("change", (e) => { ovDate.month = e.target.value; ovToCustom(); renderOverview(); });

// 自动刷新：固定 10 分钟 + 倒数计时
const AUTO_MS = 10 * 60 * 1000;
let nextRefreshAt = Date.now() + AUTO_MS;
let refreshing = false;
function scheduleRefresh() { nextRefreshAt = Date.now() + AUTO_MS; }
async function autoRefreshNow(manual) {
  if (refreshing) return;
  refreshing = true;
  scheduleRefresh();
  try { await loadMembers(); renderCurrent(); if (manual) toast("已刷新"); }
  finally { refreshing = false; }
}
// 每秒更新倒数；归零时自动刷新
setInterval(() => {
  const el = $("#countdown"); if (!el) return;
  const remain = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
  el.textContent = `${String(Math.floor(remain / 60)).padStart(2, "0")}:${String(remain % 60).padStart(2, "0")} 后刷新`;
  if (remain <= 0) autoRefreshNow(false);
}, 1000);

// ---------- 批量新增：解析粘贴文本 ----------
const BULK_LABELS = { "平台": "platform", "会员": "account", "最后登入时间": "lastLogin", "原因": "reason", "备注": "remark" };
function parseBulk(text) {
  const members = [];
  let cur = null, lastKey = null;
  const flush = () => { if (cur && (cur.account || "").trim()) members.push(cur); cur = null; lastKey = null; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || /^[-—－_=]{3,}$/.test(line)) { flush(); continue; }  // 空行或分隔线
    const m = line.match(/^(平台|会员|最后登入时间|原因|备注)\s*[:：]\s*(.*)$/);
    if (m) { if (!cur) cur = {}; lastKey = BULK_LABELS[m[1]]; cur[lastKey] = m[2]; }
    else if (cur && lastKey) { cur[lastKey] += "\n" + line; }  // 续行并入上一字段
  }
  flush();
  return members;
}
// 拆分多账号并剃除中文字（账号只会有英文+数字）
function splitAccounts(a) {
  return String(a || "").split(/[\s,，、/|]+/)
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
}
function updateBulkPreview() {
  const parsed = parseBulk($("#bulkInput").value);
  // 会员含多个账号时逐一分笔，预览按分笔后的数量显示
  const list = [];
  parsed.forEach((m) => splitAccounts(m.account).forEach((a) => list.push({ ...m, account: a })));
  $("#bulkCount").textContent = `已识别 ${list.length} 笔`;
  $("#bulkPreview").innerHTML = list.map((m, i) => `
    <div class="prev-item">
      <span class="prev-idx">${i + 1}</span>
      <div class="prev-body">
        <div class="prev-title">${esc(m.account) || '<span class="prev-warn">（缺会员账号，将跳过）</span>'} <span class="muted">· ${esc(m.platform) || "无平台"}</span></div>
        <div class="muted tiny">${esc(m.reason) || "无原因"}</div>
      </div>
    </div>`).join("");
  return list;
}
$("#bulkInput").addEventListener("input", updateBulkPreview);
$("#bulkClear").addEventListener("click", () => { $("#bulkInput").value = ""; updateBulkPreview(); });
$("#bulkSubmit").addEventListener("click", async () => {
  const list = parseBulk($("#bulkInput").value);
  if (!list.length) { toast("没识别到会员，检查格式或至少填「会员」"); return; }
  try {
    const r = await api("/api/members/bulk", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: list }),
    });
    $("#bulkInput").value = ""; updateBulkPreview();
    await loadMembers();
    toast(`已新增 ${r.added} 笔`);
    showView("pending");
  } catch (err) { toast("新增失败：" + err.message); }
});

// ---------- 单笔新增 ----------
$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    platform: f.platform.value.trim(),
    account: f.account.value.trim(),
    lastLogin: f.lastLogin.value.trim(),
    reason: f.reason.value.trim(),
    remark: f.remark.value.trim(),
    group: f.group ? f.group.value : "",
  };
  if (!payload.account) { toast("「会员」不能为空"); f.account.focus(); return; }
  try {
    const r = await api("/api/members", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    f.reset();
    await loadMembers();
    toast(`已新增 ${r.added || 1} 笔，进入待处理`);
    showView("pending");
  } catch (err) { toast("新增失败：" + err.message); }
});

// 新增页：单笔 / 批量 切换
$("#newTabs").addEventListener("click", (e) => {
  const b = e.target.closest(".subtab");
  if (!b) return;
  $$("#newTabs .subtab").forEach((x) => x.classList.toggle("is-active", x === b));
  $$('.view[data-view="new"] .tab-pane').forEach((p) => (p.hidden = p.dataset.tab !== b.dataset.tab));
});

// ---------- 启动 ----------
(async function init() {
  await loadMembers();
  buildPlatSeg("ovPlatSeg", ovPlat);
  buildPlatSeg("pendPlatSeg", pendPlat);
  ovDate.year = state.today.slice(0, 4);
  fillDateSelects($("#ovYear"), $("#ovMonth"), ovDate);
  scheduleRefresh();   // 启动 10 分钟自动刷新倒数
  showView((location.hash || "#overview").slice(1));
})();
