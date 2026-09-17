// App Module - 前端主邏輯、UI 互動、狀態管理
import { supabase } from './supabase-client.js';
import * as auth from './auth.js';
import * as profiles from './profiles.js';
import * as project from './project.js';
import * as hierarchy from './hierarchy.js';
import * as permissions from './permissions.js';

// ===== 狀態 =====
let currentUser = null;
let currentGlobalRole = null;
let currentProject = null;
let isAdminMode = false;

// ===== UI Elements =====
const $ = id => document.getElementById(id);
const esc = v => (v === null || v === undefined) ? '' : String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ===== 金額處理 =====
// 一律用 Number 轉（DB 的 numeric 回來是字串），整數就不顯示小數
const money = v => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const isInt = Math.abs(n - Math.round(n)) < 0.005;
  return 'NT$' + n.toLocaleString('zh-TW', {
    minimumFractionDigits: isInt ? 0 : 2,
    maximumFractionDigits: isInt ? 0 : 2
  });
};

// 差額：有實際就用實際-預估，否則不顯示
const diffText = (est, fin) => {
  if (fin === null || fin === undefined || fin === '' ) return '';
  if (est === null || est === undefined || est === '') return '';
  const d = Number(fin) - Number(est);
  if (!isFinite(d)) return '';
  const sign = d > 0 ? '+' : (d < 0 ? '−' : '');
  return sign + money(Math.abs(d)).replace('NT$', 'NT$');
};

const totalOf = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);

const PAY_LABEL = {
  unpaid: ['未付', 'paused'],
  deposit_paid: ['已付訂金', 'doing'],
  partial_paid: ['部分付款', 'doing'],
  settled: ['已結清', 'done']
};

// ===== 初始化 =====
export async function init() {
  setupAuthListener();
  await checkExistingSession();
}

// 監聽登入狀態變化
function setupAuthListener() {
  // ⚠️ CDN 的 supabase-js ESM 版本沒有 onAuthStateChanged。
  // 直接呼叫會 TypeError，中斷整個 init()（後台會完全沒初始化）。
  // 所以先檢查存在才註冊；登入後改用直接呼叫 setupUser() 來更新畫面。
  if (typeof supabase.auth.onAuthStateChanged !== 'function') {
    console.warn('onAuthStateChanged 不存在，改用直接呼叫 setupUser()');
    return;
  }
  supabase.auth.onAuthStateChanged(async (session) => {
    if (session?.user) {
      currentUser = session.user;
      await setupUser();
    } else {
      currentUser = null;
      currentGlobalRole = null;
      isAdminMode = false;
      showLoginPage();
    }
  });
}

// 檢查現有 session
async function checkExistingSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    await setupUser();
  } else {
    showLoginPage();
  }
}

// 設定用戶（登入後呼叫）
async function setupUser() {
  const profile = await profiles.getMyProfile();
  if (!profile) return;
  currentGlobalRole = profile.role;

  if (profile.status !== 'approved') {
    showPendingNotice();
    return;
  }

  isAdminMode = currentGlobalRole === 'admin';
  // ⚠️ 一定要在這裡顯示後台頁面。原本只有在「按登入鈕」的流程才呼叫 showAppPage()，
  // 所以重新載入頁面時（session 還在）會卡在登入頁 —— 明明已登入卻看到登入表單。
  showAppPage();
  updateUserUI();
  loadProjects();
}

// 更新用戶介面
function updateUserUI() {
  const header = $('userRoleBadge');
  if (header) {
    const roleLabels = { admin: '管理者', user: '使用者', viewer: '檢視者' };
    header.textContent = roleLabels[currentGlobalRole] || currentGlobalRole;
    header.style.display = 'inline-block';
  }
  // 管理者顯示「審核申請」按鈕
  const approveBtn = $('applicationsMenuItem');
  if (approveBtn) {
    approveBtn.style.display = isAdminMode ? 'block' : 'none';
  }
}

// ===== 頁面切換 =====
function showLoginPage() {
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('appPage').style.display = 'none';
}

function showAppPage() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('appPage').style.display = 'block';
}

function showPendingNotice() {
  document.getElementById('loginPage').style.display = 'flex';
  $('pendingNotice').style.display = 'block';
  $('appPage').style.display = 'none';
}

// ===== 區塊切換 =====
const SECTIONS = ['projectsSection', 'newProjectSection', 'itemsSection',
                  'applicationsSection'];

function showSection(id) {
  SECTIONS.forEach(s => $(s)?.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
}

// 專案列表
export function showProjects() {
  showSection('projectsSection');
  loadProjects();
}

// 新增專案表單
export function showNewProjectForm() {
  showSection('newProjectSection');
}

// 建立專案
export async function createNewProject() {
  const name = $('newProjectName')?.value.trim();
  const desc = $('newProjectDesc')?.value.trim();
  if (!name) return showToast('請輸入專案名稱', 'error');
  try {
    await project.createProject(name, desc);
    $('newProjectName').value = '';
    $('newProjectDesc').value = '';
    showToast('專案已建立', 'success');
    showProjects();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 關閉 Modal
export function closeModal() {
  $('applicationsModal')?.classList.add('hidden');
}

// ===== 登入/註冊事件 =====
export function setupAuthHandlers() {
  $('signupForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('signupName').value.trim();
    const email = $('signupEmail').value.trim();
    const password = $('signupPassword').value;
    try {
      await auth.register(name, email, password);
      showPendingNotice();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('signinForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('signinEmail').value.trim();
    const password = $('signinPassword').value;
    try {
      await auth.login(email, password);
      showAppPage();
      await setupUser();   // 不依賴 onAuthStateChanged 事件，直接更新畫面
    } catch (err) {
      if (err.message === 'ACCOUNT_PENDING') {
        showPendingNotice();
      } else {
        showToast(err.message, 'error');
      }
    }
  });
}

// ===== 專案載入 =====
export async function loadProjects() {
  if (!isAdminMode) return;
  const projects = await project.getProjects();
  renderProjectList(projects);
}

function renderProjectList(projects) {
  const container = $('projectList');
  if (!container) return;
  container.innerHTML = '';
  if (!projects.length) {
    container.innerHTML = '<div class="empty">尚無專案，請先「新增專案」。</div>';
    return;
  }
  projects.forEach(p => {
    const div = document.createElement('div');
    div.className = 'project-card';
    div.innerHTML = `<h3>${esc(p.name)}</h3><p>${esc(p.description || '')}</p>`;
    div.onclick = () => switchToProject(p.id);
    container.appendChild(div);
  });
}

// ===== 切換專案 =====
export async function switchToProject(projectId) {
  try {
    const projectData = await project.getProject(projectId);
    project.setCurrentProject(projectData);
    currentProject = projectData;
    $('projectTitle').textContent = projectData.name;
    showSection('itemsSection');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== 專案結構：階層 → 節點 → 項目 → 成員 =====
let currentLevels = [];
let currentNodes = [];
let currentItems = [];
let currentMembers = [];
let currentMembersError = null;
let currentLogCounts = {};   // item_id → 有幾筆工程紀錄（顯示在「進度歷程」按鈕上）

export async function loadStructure() {
  if (!currentProject) return;
  const pid = currentProject.id;
  const [levels, nodes, items, members, logCounts] = await Promise.all([
    project.getHierarchyLevels(pid),
    project.getNodesByProject(pid),
    project.getItems(pid),
    // 成員清單失敗（例如沒有讀取權限）不該讓整個結構頁掛掉，
    // 但也不能靜默變空 —— 把錯誤留下來顯示，否則會誤判成「還沒加入成員」
    project.getProjectMembersWithNames(pid)
      .catch(err => { console.warn('成員載入失敗', err); return { __error: err.message }; }),
    // 各項目的紀錄筆數：失敗只影響按鈕上的數字，不該擋住整個結構頁
    project.getLogCountByItem(pid).catch(err => { console.warn('紀錄筆數載入失敗', err); return {}; })
  ]);
  currentLevels = levels || [];
  currentNodes = nodes || [];
  currentItems = items || [];
  currentMembers = Array.isArray(members) ? members : [];
  currentMembersError = (members && members.__error) || null;
  currentLogCounts = (logCounts && !logCounts.__error) ? logCounts : {};
  // 註：不再渲染「階層」卡片 —— 簡化後使用者只看得到一棵地點樹
  renderNodes();
  renderProjectItems();
  fillStructureSelects();
  renderCostSummary();
  bindStructureActions();
  renderMembers();
}

// ===== ④ 專案成員 =====
// 誰能管成員：全域管理者 或 該專案的 owner（與資料庫 RLS 一致）
async function canManageMembers() {
  if (!currentProject) return false;
  try {
    const g = await permissions.getMyGlobalRole();
    if (g === 'admin') return true;
    const p = await permissions.getMyProjectRole(currentProject.id);
    return p === 'owner';
  } catch (err) {
    return false;
  }
}

const GLOBAL_ROLE_LABEL = { admin: '管理者', user: '使用者', viewer: '檢視者' };
const STAGE_LABEL = { pending: '待審核', approved: '已批准', rejected: '已拒絕' };

async function renderMembers() {
  const box = $('membersContainer');
  if (!box) return;
  const form = $('newMemberEmail') ? $('newMemberEmail').closest('.inline-form') : null;
  const canManage = await canManageMembers();
  if (form) form.style.display = canManage ? '' : 'none';

  // 載入失敗要講出來，不能靜默空白（會被誤判成「還沒加入成員」）
  if (currentMembersError) {
    box.innerHTML = '<div class="empty">成員載入失敗：' + esc(currentMembersError) + '</div>';
    return;
  }
  if (!currentMembers.length) {
    box.innerHTML = '<div class="empty">這個專案目前沒有成員。'
      + (canManage ? '' : '（只有專案管理者可以新增成員）') + '</div>';
    return;
  }
  const roleOpts = sel => [['owner', '專案管理者'], ['editor', '編輯者'], ['viewer', '檢視者']]
    .map(([v, l]) => `<option value="${v}"${sel === v ? ' selected' : ''}>${l}</option>`).join('');

  box.innerHTML = currentMembers.map(m => {
    const p = m.profile || {};
    // ⚠️ project_members 是複合主鍵，沒有 id 欄 —— 用 user_id 當這一列的識別
    const uid = m.user_id || '';
    const name = p.display_name || uid || '（未知帳號）';
    const mail = p.email || '';
    const gLabel = GLOBAL_ROLE_LABEL[p.role];
    const stage = (p.status && p.status !== 'approved')
      ? `<span class="chip paused">${esc(STAGE_LABEL[p.status] || p.status)}</span>` : '';
    const joined = m.joined_at
      ? `<span class="chip">加入：${esc(String(m.joined_at).slice(0, 10))}</span>` : '';
    const actions = !uid
      ? `<span class="row-actions"><span class="chip paused">沒有 user_id，無法管理</span></span>`
      : canManage
        ? `<span class="row-actions">`
          + `<select class="status-select" onchange="changeMemberRole('${esc(uid)}', this.value)">${roleOpts(m.role)}</select>`
          + `<button class="btn-sm btn-danger" onclick="removeMemberFromProject('${esc(uid)}')">移除</button>`
          + `</span>`
        : `<span class="row-actions"><span class="chip">${esc(permissions.getProjectRoleLabel(m.role))}</span></span>`;
    return `
    <div class="level-card">
      <strong>${esc(name)}</strong>
      ${mail ? `<span class="chip">${esc(mail)}</span>` : ''}
      ${gLabel ? `<span class="chip">全域：${gLabel}</span>` : ''}
      ${joined}
      ${stage}
      ${actions}
    </div>`;
  }).join('');
}

// 加入成員：Email → 查帳號 → 寫入（全部在 project.inviteMember 裡處理）
export async function inviteMemberFromForm() {
  if (!currentProject) return;
  const email = ($('newMemberEmail')?.value || '').trim();
  const role = $('newMemberRole')?.value || 'editor';
  if (!email) return showToast('請輸入成員的 Email', 'error');
  try {
    const res = await project.inviteMember(currentProject.id, email, role);
    $('newMemberEmail').value = '';
    const who = res.profile.display_name || res.profile.email || email;
    showToast(res.updated
      ? `已把「${who}」改成${permissions.getProjectRoleLabel(role)}`
      : `已加入成員：${who}（${permissions.getProjectRoleLabel(role)}）`, 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ⚠️ 參數是 user_id（不是 row id），因為這張表沒有 id 欄
export async function changeMemberRole(userId, role) {
  if (!currentProject) return;
  try {
    await project.updateMemberRoleRow(currentProject.id, userId, role);
    showToast('角色已改為' + permissions.getProjectRoleLabel(role), 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
  await loadStructure();
}

export async function removeMemberFromProject(userId) {
  if (!currentProject) return;
  const m = currentMembers.find(x => x.user_id === userId);
  const name = (m && ((m.profile || {}).display_name || (m.profile || {}).email)) || '這位成員';
  if (!confirm('確定要把「' + name + '」從這個專案移除嗎？\n\n'
    + '他還是可以登入，但看不到、也不能編輯這個專案。')) return;
  try {
    await project.removeMemberRow(currentProject.id, userId);
    showToast('已移除成員', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 這三個是用 inline onclick / onchange 呼叫的，一定要掛到 window
window.inviteMemberFromForm = inviteMemberFromForm;
window.changeMemberRole = changeMemberRole;
window.removeMemberFromProject = removeMemberFromProject;

// ===== 費用總表（整個專案）=====
function renderCostSummary() {
  const box = $('costSummary');
  if (!box) return;
  if (!currentItems.length) { box.innerHTML = ''; return; }
  const est = totalOf(currentItems, 'estimated_cost');
  const fin = totalOf(currentItems, 'final_cost');
  const paid = totalOf(currentItems, 'paid_amount');
  const unpaid = fin - paid;
  const withCost = currentItems.filter(i => i.estimated_cost !== null || i.final_cost !== null).length;
  box.innerHTML = `
    <div class="cost-summary">
      <span class="cost-head">工程費用總表</span>
      <span class="cost-cell">項目 <strong>${currentItems.length}</strong> 項（有填費用 ${withCost} 項）</span>
      <span class="cost-cell">預估 <strong>${money(est)}</strong></span>
      <span class="cost-cell">實際 <strong>${money(fin)}</strong></span>
      <span class="cost-cell">差額 <strong class="${fin - est > 0 ? 'over' : (fin - est < 0 ? 'under' : '')}">${fin || est ? diffText(est, fin) || '—' : '—'}</strong></span>
      <span class="cost-cell">已付 <strong>${money(paid)}</strong></span>
      <span class="cost-cell">未結 <strong class="${unpaid > 0 ? 'over' : ''}">${fin ? money(unpaid) : '—'}</strong></span>
    </div>`;
}

// ===== 進度歷程（單一項目的時間軸）=====
// 「以項目為中心」的視角：把散落在不同日期的紀錄，依時間串成一條線，
// 就不用在日曆裡翻找，一眼看到這個項目從起點到最新的完整過程。
const STATUS_CLS = { completed: 'done', in_progress: 'doing', paused: 'paused' };

export async function openItemTimeline(itemId) {
  const item = currentItems.find(i => i.id === itemId);
  $('timelineTitle').textContent = '進度歷程 — ' + (item ? item.title : '');
  $('timelineBody').innerHTML = '<div class="empty">載入中…</div>';
  $('timelineModal').classList.remove('hidden');
  try {
    const logs = await project.getItemLogs(itemId);
    renderTimeline(item, logs);
  } catch (err) {
    $('timelineBody').innerHTML = '<div class="msg error">讀取失敗：' + esc(err.message) + '</div>';
  }
}

export function closeTimeline() {
  $('timelineModal')?.classList.add('hidden');
}

function renderTimeline(item, logs) {
  const box = $('timelineBody');
  const stLabel = { completed: '已完成', in_progress: '進行中', paused: '暫停' };

  if (!logs.length) {
    box.innerHTML = `<div class="empty">這個項目還沒有任何紀錄。<br><br>
      到「工程紀錄」頁選這個項目上傳第一張照片，就會成為它的<strong>起點</strong>。</div>`;
    return;
  }

  const photoCount = logs.reduce((n, l) => n + ((l.log_photos || []).length), 0);
  const first = logs[0], last = logs[logs.length - 1];
  const st = item ? (stLabel[item.status] || '未設定') : '—';
  const span = first.log_date === last.log_date
    ? esc(first.log_date)
    : `${esc(first.log_date)} → ${esc(last.log_date)}`;

  const summary = `<div class="tl-summary">
      <span>目前狀態 <strong>${esc(st)}</strong></span>
      <span>紀錄 <strong>${logs.length}</strong> 筆</span>
      <span>照片 <strong>${photoCount}</strong> 張</span>
      <span>期間 <strong>${span}</strong></span>
    </div>`;

  const body = logs.map((l, i) => {
    const isFirst = i === 0;
    const isLast = i === logs.length - 1;
    const cls = 'tl-item' + (isFirst ? ' first' : '') + (isLast && !isFirst ? ' last' : '');
    const badge = isFirst ? '<span class="chip first">起點</span>'
      : (isLast ? '<span class="chip last">最新</span>' : '');
    const t = l.log_time ? ' ' + String(l.log_time).slice(0, 5) : '';
    const photos = (l.log_photos || []).slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const photoHtml = photos.length
      ? `<div class="tl-photos">${photos.map(p => `
          <figure>
            <img src="${esc(p.photo_url)}" alt="" onerror="this.style.visibility='hidden'">
            ${p.photo_description ? `<figcaption>${esc(p.photo_description)}</figcaption>` : ''}
          </figure>`).join('')}</div>`
      : '';
    const extra = [
      l.issues_found ? `<div class="tl-extra"><b>發現問題：</b>${esc(l.issues_found)}</div>` : '',
      l.resolution ? `<div class="tl-extra"><b>解決方案：</b>${esc(l.resolution)}</div>` : '',
      l.notes ? `<div class="tl-extra"><b>備註：</b>${esc(l.notes)}</div>` : ''
    ].join('');

    return `
    <div class="${cls}">
      <div class="tl-head">
        ${badge}
        <span class="date">${esc(l.log_date)}</span>${esc(t)}
        ${l.progress_status
          ? `<span class="chip ${STATUS_CLS[l.progress_status] || ''}">${esc(stLabel[l.progress_status] || '')}</span>`
          : ''}
        ${l.location ? `<span class="chip">${esc(l.location)}</span>` : ''}
        <span class="chip">${photos.length} 張</span>
      </div>
      ${l.main_description ? `<div class="tl-desc">${esc(l.main_description)}</div>` : ''}
      ${extra}
      ${photoHtml}
    </div>`;
  }).join('');

  box.innerHTML = summary + `<div class="timeline">${body}</div>`;
}

// Modal 的 inline onclick 要用，必須掛到 window
window.closeTimeline = closeTimeline;
window.openItemTimeline = openItemTimeline;

// 渲染完後綁定按鈕（每次重繪都要重綁）
function bindStructureActions() {
  const on = (sel, attr, fn) => document.querySelectorAll(sel).forEach(b => {
    b.onclick = () => fn(b.getAttribute(attr));
  });
  on('[data-add-child]', 'data-add-child', startAddChild);
  // 批次建立
  on('[data-do-batch]', 'data-do-batch', doBatchCreate);
  on('[data-cancel-batch]', 'data-cancel-batch', closeBatchForm);
  on('[data-bt-all]', 'data-bt-all', () => {
    document.querySelectorAll('.bt-node').forEach(c => { c.checked = true; });
    updateBatchCount();
  });
  on('[data-bt-none]', 'data-bt-none', () => {
    document.querySelectorAll('.bt-node').forEach(c => { c.checked = false; });
    updateBatchCount();
  });
  document.querySelectorAll('.bt-node').forEach(c => { c.onchange = updateBatchCount; });
  if ($('bt-titles')) $('bt-titles').oninput = updateBatchCount;
  on('[data-copy-node]', 'data-copy-node', startCopyNode);
  on('[data-do-copy]', 'data-do-copy', doCopyNode);
  on('[data-cancel-copy]', 'data-cancel-copy', cancelCopyNode);
  on('[data-edit-node]', 'data-edit-node', startEditNode);
  on('[data-save-node]', 'data-save-node', saveNode);
  on('[data-cancel-node]', 'data-cancel-node', cancelEditNode);
  on('[data-del-node]', 'data-del-node', deleteNode);
  on('[data-edit-item]', 'data-edit-item', startEditItem);
  on('[data-save-item]', 'data-save-item', saveItem);
  on('[data-cancel-item]', 'data-cancel-item', cancelEditItem);
  on('[data-del-item]', 'data-del-item', deleteItem);
  on('[data-item-timeline]', 'data-item-timeline', openItemTimeline);
  document.querySelectorAll('[data-item-status]').forEach(s => {
    s.onchange = () => changeItemStatus(s.getAttribute('data-item-status'), s.value);
  });
}

// ===== 地點樹 =====
// 簡化後的核心：不再管「階層」，所有地點都是同一棵樹，只看 parent_id。
// 這樣愛分幾層就幾層，而且不會再有節點因為「爸爸在別的階層」而消失。
function buildNodeTree(nodes) {
  const childrenOf = new Map();
  nodes.forEach(n => {
    const k = n.parent_id || '';
    if (!childrenOf.has(k)) childrenOf.set(k, []);
    childrenOf.get(k).push(n);
  });
  const seen = new Set();
  const walk = (node, depth) => {
    if (seen.has(node.id)) return null;          // 資料異常時防無限迴圈
    seen.add(node.id);
    const kids = (childrenOf.get(node.id) || [])
      .map(k => walk(k, depth + 1)).filter(Boolean);
    return { node, depth, kids };
  };
  const tree = (childrenOf.get('') || []).map(n => walk(n, 0)).filter(Boolean);
  // 孤兒（parent 指向已刪除的節點）也要列出來，絕不讓它消失
  nodes.forEach(n => {
    if (!seen.has(n.id)) {
      const t = walk(n, 0);
      if (t) tree.push({ ...t, orphan: true });
    }
  });
  return tree;
}

// 攤平成「由上到下」的清單（下拉選單、縮排顯示都用它）
function flattenTree(tree, out = []) {
  tree.forEach(t => {
    out.push({ node: t.node, depth: t.depth, orphan: t.orphan });
    flattenTree(t.kids, out);
  });
  return out;
}

const INDENT = d => '　'.repeat(Math.min(d, 6));   // 最多縮 6 層，免得跑版

// 正在行內編輯的地點 id（null = 沒有）
let editingNodeId = null;
// 正在「複製結構」的地點 id
let copyingNodeId = null;

function renderNodes() {
  const box = $('nodesContainer');
  if (!box) return;
  if (!currentNodes.length) {
    box.innerHTML = '<div class="empty">還沒有地點。從下面新增第一個（例如「1F」）。</div>';
    return;
  }
  const tree = buildNodeTree(currentNodes);

  const nodeHtml = t => {
    const n = t.node;
    if (editingNodeId === n.id) return `<li>${nodeEditForm(n)}</li>`;
    if (copyingNodeId === n.id) return `<li>${copyForm(n)}</li>`;
    const mine = currentItems.filter(i => i.node_id === n.id);
    const count = mine.length;
    const est = totalOf(mine, 'estimated_cost');
    const fin = totalOf(mine, 'final_cost');
    const cost = count
      ? `<span class="chip money">${money(est)}${fin ? ' → ' + money(fin) : ''}</span>`
      : '';
    return `<li><strong>${esc(n.name)}</strong>`
      + (t.orphan ? '<span class="chip paused">上層已刪除</span>' : '')
      + (n.description ? `<span class="chip">${esc(n.description)}</span>` : '')
      + (count ? `<span class="chip">${count} 項目</span>` : '')
      + cost
      + `<span class="row-actions">`
      + `<button class="btn-sm btn-ghost" data-add-child="${esc(n.id)}">＋ 子地點</button>`
      + `<button class="btn-sm btn-ghost" data-copy-node="${esc(n.id)}">複製</button>`
      + `<button class="btn-sm btn-ghost" data-edit-node="${esc(n.id)}">編輯</button>`
      + `<button class="btn-sm btn-danger" data-del-node="${esc(n.id)}">刪除</button>`
      + `</span>`
      + (t.kids.length ? `<ul>${t.kids.map(nodeHtml).join('')}</ul>` : '')
      + '</li>';
  };

  box.innerHTML = `<div class="node-card"><ul class="tree">${tree.map(nodeHtml).join('')}</ul></div>`;
}

function statusChip(status) {
  const map = {
    completed: ['已完成', 'done'],
    in_progress: ['進行中', 'doing'],
    paused: ['暫停', 'paused']
  };
  const [label, cls] = map[status] || ['未設定', ''];
  return `<span class="chip ${cls}">${label}</span>`;
}

// 目前正在編輯費用的項目 id（null = 沒有）
let editingItemId = null;

// ===== 依工項彙總（跨樓層看同一個工項的總帳）=====
// 同一個工項在 1F、2F 各自是一筆項目（進度與費用不同），
// 但在這裡可以把它們收在一起看總金額與總進度。
let itemView = 'node';   // 'node' = 依地點（樹）／'work' = 依工項

function syncViewToggle() {
  const btn = $('viewToggleBtn');
  if (btn) btn.textContent = itemView === 'node' ? '依工項彙總' : '← 回依地點';
}

export function toggleItemView() {
  itemView = itemView === 'node' ? 'work' : 'node';
  renderProjectItems();
  bindStructureActions();
}

// 工項名稱：沒填 work_type 就退回用「項目名稱」——所以不填也能彙總
const workTypeOf = i => String(i.work_type || i.title || '（未命名）').trim();

function renderItemsByWorkType(box, nodeName, statusOptions, payOptions) {
  const groups = new Map();
  currentItems.forEach(i => {
    const k = workTypeOf(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-TW'));

  box.innerHTML = sorted.map(([wt, list]) => {
    const est = totalOf(list, 'estimated_cost');
    const fin = totalOf(list, 'final_cost');
    const done = list.filter(i => i.status === 'completed').length;

    const rows = list.map(i => {
      // 編輯直接在原地展開，不用切回樹狀檢視
      if (editingItemId === i.id) return itemEditForm(i, nodeName, payOptions);
      const opts = statusOptions.map(([v, l]) =>
        `<option value="${v}"${(i.status || '') === v ? ' selected' : ''}>${l}</option>`).join('');
      const hasFin = i.final_cost !== null && i.final_cost !== undefined && i.final_cost !== '';
      return `
      <div class="wt-row">
        <span class="wt-loc">${esc(nodeName(i.node_id))}</span>
        <select class="status-select" data-item-status="${esc(i.id)}">${opts}</select>
        <span class="chip money">${money(i.estimated_cost)}</span>
        ${hasFin ? `<span class="chip money">→ ${money(i.final_cost)}</span>` : ''}
        <span class="row-actions">
          <button class="btn-sm btn-ghost" data-item-timeline="${esc(i.id)}">歷程${currentLogCounts[i.id] ? ` (${currentLogCounts[i.id]})` : ''}</button>
          <button class="btn-sm btn-ghost" data-edit-item="${esc(i.id)}">編輯</button>
        </span>
      </div>`;
    }).join('');

    return `
    <div class="item-card wt-group">
      <div class="item-head">
        <strong>${esc(wt)}</strong>
        <span class="row-actions">
          <span class="chip">${list.length} 個地點</span>
          ${done ? `<span class="chip done">已完成 ${done}</span>` : ''}
          <span class="chip money">預估 ${money(est)}</span>
          ${fin ? `<span class="chip money">實際 ${money(fin)}</span>` : ''}
        </span>
      </div>
      ${rows}
    </div>`;
  }).join('');
}

window.toggleItemView = toggleItemView;

function renderProjectItems() {
  const box = $('itemsContainer');
  if (!box) return;
  if (!currentItems.length) {
    box.innerHTML = '<div class="empty">尚未建立項目。</div>';
    return;
  }
  const nodeName = id => {
    const n = currentNodes.find(x => x.id === id);
    if (!n) return '（節點已不存在）';
    const parts = [n.name];
    let cur = n, guard = 0;
    while (cur && cur.parent_id && guard++ < 30) {
      cur = currentNodes.find(x => x.id === cur.parent_id);
      if (cur) parts.unshift(cur.name);
    }
    return parts.join(' / ');
  };
  const statusOptions = [
    ['', '（未設定）'], ['in_progress', '進行中'], ['completed', '已完成'], ['paused', '暫停']
  ];
  const payOptions = [
    ['', '（未設定）'], ['unpaid', '未付'], ['deposit_paid', '已付訂金'],
    ['partial_paid', '部分付款'], ['settled', '已結清']
  ];

  syncViewToggle();
  if (itemView === 'work') {
    renderItemsByWorkType(box, nodeName, statusOptions, payOptions);
    return;
  }

  box.innerHTML = (batchOpen ? batchForm() : '') + currentItems.map(i => {
    if (editingItemId === i.id) return itemEditForm(i, nodeName, payOptions);
    const logCount = currentLogCounts[i.id] || 0;

    const opts = statusOptions.map(([v, l]) =>
      `<option value="${v}"${(i.status || '') === v ? ' selected' : ''}>${l}</option>`).join('');
    const pay = PAY_LABEL[i.payment_status] || ['未設定', ''];
    const diff = diffText(i.estimated_cost, i.final_cost);
    const over = diff && Number(i.final_cost) > Number(i.estimated_cost);
    const tel = i.assignee_phone ? String(i.assignee_phone).replace(/[^\d+]/g, '') : '';

    return `
    <div class="item-card">
      <div class="item-head">
        <strong>${esc(i.title)}</strong>
        <span class="row-actions">
          <button class="btn-sm btn-ghost" data-item-timeline="${esc(i.id)}">進度歷程${logCount ? ` (${logCount})` : ''}</button>
          <button class="btn-sm btn-ghost" data-edit-item="${esc(i.id)}">編輯</button>
          <button class="btn-sm btn-danger" data-del-item="${esc(i.id)}">刪除</button>
        </span>
      </div>
      <div class="item-meta">
        <select class="status-select" data-item-status="${esc(i.id)}">${opts}</select>
        <span class="chip">節點：${esc(nodeName(i.node_id))}</span>
      </div>
      <div class="item-money">
        <span class="money-label">負責人</span>
        <span>${i.assignee ? esc(i.assignee) : '—'}</span>
        ${tel ? `<a class="tel" href="tel:${esc(tel)}">${esc(i.assignee_phone)}</a>` : ''}
        <span class="money-sep">｜</span>
        <span class="money-label">預估</span><span>${money(i.estimated_cost)}</span>
        <span class="money-label">實際</span><span>${money(i.final_cost)}</span>
        ${diff ? `<span class="money-label">差額</span><span class="${over ? 'over' : 'under'}">${diff}</span>` : ''}
        <span class="money-sep">｜</span>
        <span class="chip ${pay[1]}">${pay[0]}</span>
        ${i.paid_amount !== null && i.paid_amount !== undefined
            ? `<span class="money-label">已付</span><span>${money(i.paid_amount)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// 行內編輯表單（6 個欄位用 prompt 太煩，直接展開成小表單）
function itemEditForm(i, nodeName, payOptions) {
  const payOpts = payOptions.map(([v, l]) =>
    `<option value="${v}"${(i.payment_status || '') === v ? ' selected' : ''}>${l}</option>`).join('');
  const fld = (id, label, val, type = 'text', extra = '') =>
    `<label class="ef"><span>${label}</span>
       <input id="${id}" type="${type}" value="${esc(val === null || val === undefined ? '' : val)}" ${extra}>
     </label>`;
  return `
  <div class="item-card editing">
    <div class="item-head">
      <strong>編輯項目</strong>
      <span class="row-actions">
        <button class="btn-sm" data-save-item="${esc(i.id)}">儲存</button>
        <button class="btn-sm btn-ghost" data-cancel-item="${esc(i.id)}">取消</button>
      </span>
    </div>
    <div class="edit-grid">
      ${fld('ef-title', '項目名稱', i.title)}
      ${fld('ef-worktype', '工項（彙總用）', i.work_type)}
      ${fld('ef-assignee', '負責人', i.assignee)}
      ${fld('ef-phone', '電話', i.assignee_phone, 'text', 'inputmode="tel"')}
      ${fld('ef-est', '預估費用', i.estimated_cost, 'number', 'min="0" step="1"')}
      ${fld('ef-fin', '實際費用', i.final_cost, 'number', 'min="0" step="1"')}
      ${fld('ef-paid', '已付金額', i.paid_amount, 'number', 'min="0" step="1"')}
      <label class="ef"><span>付款狀態</span><select id="ef-pay">${payOpts}</select></label>
      <div class="ef ef-note">節點：${esc(nodeName(i.node_id))}</div>
    </div>
  </div>`;
}

// ===== 編輯項目（行內表單）=====
export function startEditItem(itemId) {
  editingItemId = itemId;
  renderProjectItems();
  bindStructureActions();
}

export function cancelEditItem() {
  editingItemId = null;
  renderProjectItems();
  bindStructureActions();
}

export async function saveItem(itemId) {
  if (!(await ensureCanManage())) return;
  const num = id => {
    const v = $(id) ? $(id).value : '';
    return (v === '' || v === null || v === undefined) ? null : Number(v);
  };
  const title = ($('ef-title') ? $('ef-title').value : '').trim();
  if (!title) return showToast('項目名稱不能空白', 'error');
  const est = num('ef-est'), fin = num('ef-fin'), paid = num('ef-paid');
  for (const [v, label] of [[est, '預估費用'], [fin, '實際費用'], [paid, '已付金額']]) {
    if (v !== null && (!isFinite(v) || v < 0)) return showToast(label + '必須是 0 以上的數字', 'error');
  }
  try {
    await project.updateItemRow(itemId, {
      title,
      work_type: ($('ef-worktype') ? $('ef-worktype').value : '').trim() || null,
      assignee: ($('ef-assignee') ? $('ef-assignee').value : '').trim() || null,
      assignee_phone: ($('ef-phone') ? $('ef-phone').value : '').trim() || null,
      estimated_cost: est,
      final_cost: fin,
      paid_amount: paid,
      payment_status: $('ef-pay') ? ($('ef-pay').value || null) : null
    });
    editingItemId = null;
    showToast('項目已更新', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function fillStructureSelects() {
  // 下拉全部改成「一棵樹 + 縮排」，不再按階層分組
  const flat = flattenTree(buildNodeTree(currentNodes));
  const opts = flat.map(f =>
    `<option value="${esc(f.node.id)}">${INDENT(f.depth)}${esc(f.node.name)}`
    + (f.orphan ? '（上層已刪除）' : '') + '</option>').join('');

  // 新增地點的「上層」：留空＝頂層地點
  const pn = $('newNodeParent');
  if (pn) pn.innerHTML = '<option value="">無（＝頂層地點）</option>' + opts;

  // 新增項目的「地點」
  const ino = $('newItemNode');
  if (ino) ino.innerHTML = '<option value="">選擇地點…</option>' + opts;

  // 用過的工項做成建議清單（避免「主牆塗漿」與「主牆手工塗漿」被當成兩種）
  const dl = $('workTypeList');
  if (dl) {
    const types = [...new Set(currentItems.map(i => i.work_type).filter(Boolean))]
      .sort((a, b) => String(a).localeCompare(String(b), 'zh-TW'));
    dl.innerHTML = types.map(t => `<option value="${esc(t)}"></option>`).join('');
  }
}

// ===== 建立：階層 =====
export async function createLevel() {
  if (!currentProject) return;
  const name = ($('newLevelName')?.value || '').trim();
  if (!name) return showToast('請輸入階層名稱', 'error');
  const singular = ($('newLevelSingular')?.value || '').trim() || name;
  const plural = ($('newLevelPlural')?.value || '').trim() || name;
  let idx = parseInt($('newLevelIndex')?.value, 10);
  if (!idx || idx < 1) idx = currentLevels.reduce((m, l) => Math.max(m, l.level_index || 0), 0) + 1;
  try {
    await project.createHierarchyLevel(currentProject.id, {
      name, singular_name: singular, plural_name: plural, level_index: idx
    });
    ['newLevelName', 'newLevelSingular', 'newLevelPlural', 'newLevelIndex']
      .forEach(id => { if ($(id)) $(id).value = ''; });
    showToast('階層已建立', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== 建立：地點（簡化後不再需要選階層）=====
export async function createNode() {
  if (!currentProject) return;
  const name = ($('newNodeName')?.value || '').trim();
  const desc = ($('newNodeDesc')?.value || '').trim();
  const parentId = $('newNodeParent')?.value || null;
  if (!name) return showToast('請輸入地點名稱', 'error');
  try {
    // 底層還是需要一個 level_id（欄位是 NOT NULL），但使用者看不到
    const levelId = await project.ensureDefaultLevel(currentProject.id);
    await project.createNode({
      project_id: currentProject.id,
      level_id: levelId,
      name,
      description: desc || null,
      parent_id: parentId
    });
    ['newNodeName', 'newNodeDesc'].forEach(id => { if ($(id)) $(id).value = ''; });
    if ($('newNodeParent')) $('newNodeParent').value = '';
    showToast('地點已新增', 'success');
    await loadStructure();
  } catch (err) {
    let extra = '';
    if (err.code === '23505' || /duplicate key/i.test(err.message || '')) {
      extra = '\n\n→ 資料庫還有「名稱不能重複」的限制，所以第二個「客廳」被擋下。\n'
            + '請跑一次解除的 SQL（我訊息裡有），或先取不同的名字。';
    }
    showToast(err.message + extra, 'error');
  }
}

// 「＋ 子地點」：把上層下拉預先選好，游標跳到名稱欄
export function startAddChild(nodeId) {
  const nd = currentNodes.find(n => n.id === nodeId);
  const pn = $('newNodeParent');
  if (pn) pn.value = nodeId;
  const dayName = nd ? nd.name : '';
  showToast(`在「${dayName}」底下新增——請填名稱再按「新增地點」`, 'success');
  const el = $('newNodeName');
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus();
  }
}

// ===== 建立：項目 =====
// 注意 items 表的主欄位是 title，不是 name（舊版程式讀 item.name 會顯示空白）
export async function createProjectItem() {
  if (!currentProject) return;
  const nodeId = $('newItemNode')?.value;
  const title = ($('newItemTitle')?.value || '').trim();
  const workType = ($('newItemWorkType')?.value || '').trim() || null;
  const status = $('newItemStatus')?.value || null;
  const assignee = ($('newItemAssignee')?.value || '').trim() || null;
  const estRaw = $('newItemEst')?.value;
  const est = (estRaw === '' || estRaw === null || estRaw === undefined) ? null : Number(estRaw);
  if (!nodeId) return showToast('請選擇所屬地點', 'error');
  if (!title) return showToast('請輸入項目名稱', 'error');
  if (est !== null && (!isFinite(est) || est < 0)) return showToast('預估費用必須是 0 以上的數字', 'error');
  try {
    await project.createItem(currentProject.id, {
      node_id: nodeId, title, status, assignee, estimated_cost: est, work_type: workType
    });
    ['newItemTitle', 'newItemAssignee', 'newItemEst', 'newItemWorkType']
      .forEach(id => { if ($(id)) $(id).value = ''; });
    showToast('項目已建立', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== 權限檢查（前端先擋，資料庫 RLS 才是真正的關卡）=====
async function ensureCanManage() {
  if (!currentProject) return false;
  try {
    const ok = await permissions.canManageItemsCurrent(currentProject.id);
    if (!ok) {
      showToast('你沒有這個專案的編輯權限', 'error');
      return false;
    }
    return true;
  } catch (err) {
    showToast(err.message, 'error');
    return false;
  }
}

// ===== 編輯：階層 =====
export async function editLevel(levelId) {
  const lv = currentLevels.find(l => l.id === levelId);
  if (!lv || !(await ensureCanManage())) return;
  const name = prompt('階層名稱（例：樓層）', lv.name);
  if (name === null) return;
  if (!name.trim()) return showToast('名稱不能空白', 'error');
  const idxStr = prompt('序號（數字，決定顯示順序）', lv.level_index);
  if (idxStr === null) return;
  const idx = parseInt(idxStr, 10);
  if (!idx || idx < 1) return showToast('序號必須是 1 以上的數字', 'error');
  try {
    const n = name.trim();
    await project.updateHierarchyLevel(levelId, {
      name: n,
      // 單數／複數若原本與舊名相同，就跟著新名一起改（保持「單複數預設等於名稱」的行為）
      singular_name: (lv.singular_name === lv.name || !lv.singular_name) ? n : lv.singular_name,
      plural_name: (lv.plural_name === lv.name || !lv.plural_name) ? n : lv.plural_name,
      level_index: idx,
      sort_order: idx
    });
    showToast('階層已更新', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== 刪除：階層（連同節點與項目，由下往上刪）=====
export async function deleteLevel(levelId) {
  const lv = currentLevels.find(l => l.id === levelId);
  if (!lv || !(await ensureCanManage())) return;
  const children = currentNodes.filter(n => n.level_id === levelId);
  const childIds = children.map(n => n.id);
  const childItems = currentItems.filter(i => childIds.includes(i.node_id));
  const msg = `確定要刪除階層「${lv.name}」嗎？\n\n`
    + `會一併刪除底下的：\n`
    + `　節點 ${children.length} 個\n`
    + `　項目 ${childItems.length} 筆\n\n`
    + `紀錄與照片以外的所有結構資料都會永久刪除，無法復原。`;
  if (!confirm(msg)) return;
  try {
    await project.deleteItemRows(childItems.map(i => i.id));
    await project.deleteNodeRows(childIds);
    await project.deleteHierarchyLevel(levelId);
    showToast(`已刪除階層「${lv.name}」及其下 ${children.length} 節點、${childItems.length} 項目`, 'success');
    await loadStructure();
  } catch (err) {
    showToast('刪除失敗：' + err.message, 'error');
  }
}

// 取得某節點的所有子孫節點 id（含自己）
function nodeWithDescendants(nodeId) {
  const out = [nodeId];
  const walk = id => currentNodes.filter(n => n.parent_id === id).forEach(c => { out.push(c.id); walk(c.id); });
  walk(nodeId);
  return out;
}

// ===== 批次建立項目（多個地點 × 多個工項）=====
// 使用者的樓層是重複的：同一個工項在每層都要建一次，逐筆點太慢。
let batchOpen = false;

// HTML 的 inline onclick 要用（函式宣告會提升，這裡先掛沒問題）
window.openBatchForm = openBatchForm;

function batchForm() {
  const flat = flattenTree(buildNodeTree(currentNodes));
  const boxes = flat.map(f => `
    <label class="check-line batch-line">
      <input type="checkbox" class="bt-node" value="${esc(f.node.id)}">
      <span>${INDENT(f.depth)}${esc(f.node.name)}</span>
    </label>`).join('');
  return `
  <div class="item-card editing" style="margin-bottom:16px">
    <div class="item-head">
      <strong>批次建立項目</strong>
      <span class="row-actions">
        <button class="btn-sm" data-do-batch="1">建立</button>
        <button class="btn-sm btn-ghost" data-cancel-batch="1">取消</button>
      </span>
    </div>
    <p class="hint">勾選地點（可多選），下面一行寫一個工項，交叉相乘全部建立。</p>
    <div class="sub-label">地點
      <button class="btn-sm btn-ghost" style="padding:2px 8px;font-size:11px" data-bt-all="1">全選</button>
      <button class="btn-sm btn-ghost" style="padding:2px 8px;font-size:11px" data-bt-none="1">全不選</button>
    </div>
    <div class="batch-nodes">${boxes || '<div class="empty">還沒有地點，請先到 ① 建立。</div>'}</div>
    <label class="ef" style="margin-top:12px"><span>工項（一行一個）</span>
      <textarea id="bt-titles" rows="4"
        placeholder="主牆手工塗漿&#10;地板海島型鋪設&#10;天花板紙漿燈槽"></textarea></label>
    <p class="hint" id="bt-count">已選 0 個地點 × 0 個工項 ＝ 0 個項目</p>
  </div>`;
}

function updateBatchCount() {
  const el = $('bt-count');
  if (!el) return;
  const n = document.querySelectorAll('.bt-node:checked').length;
  const t = parseTitles().length;
  el.textContent = `已選 ${n} 個地點 × ${t} 個工項 ＝ ${n * t} 個項目`;
}

const parseTitles = () => ($('bt-titles')?.value || '')
  .split('\n').map(s => s.trim()).filter(Boolean);

export function openBatchForm() {
  batchOpen = true;
  renderProjectItems();
  bindStructureActions();
}

export function closeBatchForm() {
  batchOpen = false;
  renderProjectItems();
  bindStructureActions();
}

export async function doBatchCreate() {
  if (!(await ensureCanManage())) return;
  const nodeIds = [...document.querySelectorAll('.bt-node:checked')].map(c => c.value);
  const titles = parseTitles();
  if (!nodeIds.length) return showToast('請至少勾選一個地點', 'error');
  if (!titles.length) return showToast('請至少寫一個工項（一行一個）', 'error');

  // 交叉相乘：每個地點 × 每個工項
  // 因為使用者輸入的就是「工項名稱」，所以 work_type 直接等於它 ——
  // 這樣建完馬上就能用「依工項彙總」看總帳，不必再逐筆補。
  const rows = [];
  nodeIds.forEach(nid => titles.forEach(t => rows.push({
    project_id: currentProject.id,
    node_id: nid,
    title: t,
    status: null,
    work_type: t
  })));

  const btn = document.querySelector('[data-do-batch]');
  if (btn) { btn.disabled = true; btn.textContent = '建立中…'; }
  try {
    const { error } = await supabase.from('items').insert(rows);
    if (error) throw error;
    batchOpen = false;
    showToast(`✅ 已建立 ${rows.length} 個項目（${nodeIds.length} 個地點 × ${titles.length} 個工項）。`, 'success');
    await loadStructure();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '建立'; }
    showToast(err.message, 'error');
  }
}

// ===== 複製結構（樓層重複時最省力）=====
function copyForm(n) {
  const flat = flattenTree(buildNodeTree(currentNodes));
  const ids = new Set(nodeWithDescendants(n.id));
  // 不能複製到「自己或自己的子孫」底下（會變成奇怪的遞迴結構）
  const opts = flat.filter(f => !ids.has(f.node.id))
    .map(f => `<option value="${esc(f.node.id)}"${f.node.id === n.parent_id ? ' selected' : ''}>`
            + `${INDENT(f.depth)}${esc(f.node.name)}</option>`).join('');
  const sub = ids.size - 1;
  const itemCount = currentItems.filter(i => ids.has(i.node_id)).length;
  return `
  <div class="item-card editing">
    <div class="item-head">
      <strong>複製「${esc(n.name)}」</strong>
      <span class="row-actions">
        <button class="btn-sm" data-do-copy="${esc(n.id)}">複製</button>
        <button class="btn-sm btn-ghost" data-cancel-copy="${esc(n.id)}">取消</button>
      </span>
    </div>
    <p class="hint">
      會連同底下的 <strong>${sub}</strong> 個子地點一起複製
      ${itemCount ? `，以及掛在上面的 <strong>${itemCount}</strong> 個項目` : ''}。
    </p>
    <div class="edit-grid">
      <label class="ef"><span>新名稱</span>
        <input id="cp-name" placeholder="例：2F"></label>
      <label class="ef"><span>放在哪個上層底下</span>
        <select id="cp-parent"><option value="">無（＝頂層）</option>${opts}</select></label>
    </div>
    ${itemCount ? `
    <label class="check-line" style="margin-top:10px">
      <input type="checkbox" id="cp-items">
      <span>連項目一起複製（<strong>只複製名稱</strong>；狀態、費用、負責人會清空）</span>
    </label>` : ''}
  </div>`;
}

export function startCopyNode(nodeId) {
  copyingNodeId = nodeId;
  editingNodeId = null;
  renderNodes();
  bindStructureActions();
}

export function cancelCopyNode() {
  copyingNodeId = null;
  renderNodes();
  bindStructureActions();
}

export async function doCopyNode(nodeId) {
  if (!(await ensureCanManage())) return;
  const src = currentNodes.find(n => n.id === nodeId);
  if (!src) return;
  const newName = ($('cp-name')?.value || '').trim();
  if (!newName) return showToast('請輸入新名稱（例如 2F）', 'error');
  const newParentId = $('cp-parent')?.value || null;
  const withItems = !!$('cp-items')?.checked;

  const btn = document.querySelector('[data-do-copy]');
  if (btn) { btn.disabled = true; btn.textContent = '複製中…'; }
  try {
    const levelId = await project.ensureDefaultLevel(currentProject.id);
    // 先把項目按地點分組，避免在複製函式裡重複查資料庫
    const itemsByNode = {};
    currentItems.forEach(i => {
      if (i.node_id) (itemsByNode[i.node_id] = itemsByNode[i.node_id] || []).push(i);
    });
    const res = await project.duplicateNodeSubtree({
      projectId: currentProject.id,
      levelId,
      rootNode: src,
      allNodes: currentNodes,
      itemsByNode,
      newName,
      newParentId,
      withItems
    });
    copyingNodeId = null;
    showToast(`✅ 已複製「${newName}」：${res.nodes} 個地點`
      + (res.items ? `、${res.items} 個項目` : '') + '。', 'success');
    await loadStructure();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '複製'; }
    let extra = '';
    if (err.code === '23505' || /duplicate key/i.test(err.message || '')) {
      extra = '\n\n→ 資料庫有「名稱不能重複」的限制，所以複製出來的同名子地點被擋。\n'
            + '請跑一次解除的 SQL，或複製後手動改名字。';
    }
    showToast(err.message + extra, 'error');
  }
}

// ===== 編輯：地點（行內表單，順便可以改「上層」＝搬家）=====
// 原本用 prompt() 只能改名稱與說明，沒辦法調上層；改成行內表單後
// 「舊資料重新掛到正確樓層底下」就做得到了。
function nodeEditForm(n) {
  const flat = flattenTree(buildNodeTree(currentNodes));
  // 不能把上層設成自己或自己的子孫（會造成循環、整棵樹壞掉）
  const banned = new Set([n.id]);
  const markDesc = id => {
    currentNodes.filter(x => x.parent_id === id).forEach(c => {
      if (!banned.has(c.id)) { banned.add(c.id); markDesc(c.id); }
    });
  };
  markDesc(n.id);
  const opts = flat.filter(f => !banned.has(f.node.id))
    .map(f => `<option value="${esc(f.node.id)}"${f.node.id === n.parent_id ? ' selected' : ''}>`
            + `${INDENT(f.depth)}${esc(f.node.name)}</option>`).join('');
  return `
  <div class="item-card editing">
    <div class="item-head">
      <strong>編輯地點</strong>
      <span class="row-actions">
        <button class="btn-sm" data-save-node="${esc(n.id)}">儲存</button>
        <button class="btn-sm btn-ghost" data-cancel-node="${esc(n.id)}">取消</button>
      </span>
    </div>
    <div class="edit-grid">
      <label class="ef"><span>名稱</span>
        <input id="ne-name" value="${esc(n.name)}"></label>
      <label class="ef"><span>上層地點（＝搬家）</span>
        <select id="ne-parent"><option value="">無（＝頂層）</option>${opts}</select></label>
      <label class="ef"><span>說明（選填）</span>
        <input id="ne-desc" value="${esc(n.description || '')}"></label>
    </div>
  </div>`;
}

export function startEditNode(nodeId) {
  editingNodeId = nodeId;
  renderNodes();
  bindStructureActions();
}

export function cancelEditNode() {
  editingNodeId = null;
  renderNodes();
  bindStructureActions();
}

export async function saveNode(nodeId) {
  if (!(await ensureCanManage())) return;
  const name = ($('ne-name')?.value || '').trim();
  if (!name) return showToast('名稱不能空白', 'error');
  try {
    await project.updateNodeRow(nodeId, {
      name,
      description: ($('ne-desc')?.value || '').trim() || null,
      parent_id: $('ne-parent')?.value || null
    });
    editingNodeId = null;
    showToast('地點已更新', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== 刪除：節點（連同子孫節點與項目）=====
export async function deleteNode(nodeId) {
  const nd = currentNodes.find(n => n.id === nodeId);
  if (!nd || !(await ensureCanManage())) return;
  const ids = nodeWithDescendants(nodeId);
  const childIds = ids.filter(id => id !== nodeId);
  const items = currentItems.filter(i => ids.includes(i.node_id));
  const msg = `確定要刪除節點「${nd.name}」嗎？\n\n`
    + (childIds.length ? `會一併刪除底下的節點 ${childIds.length} 個\n` : '')
    + (items.length ? `以及掛在上面的項目 ${items.length} 筆\n` : '')
    + `\n永久刪除，無法復原。`;
  if (!confirm(msg)) return;
  try {
    await project.deleteItemRows(items.map(i => i.id));
    await project.deleteNodeRows(ids);
    showToast(`已刪除節點「${nd.name}」`, 'success');
    await loadStructure();
  } catch (err) {
    showToast('刪除失敗：' + err.message, 'error');
  }
}

// ===== 刪除：項目 =====
export async function deleteItem(itemId) {
  const it = currentItems.find(i => i.id === itemId);
  if (!it || !(await ensureCanManage())) return;
  const nodeName = (currentNodes.find(n => n.id === it.node_id) || {}).name || '（未知節點）';
  if (!confirm(`確定要刪除項目「${it.title}」嗎？\n\n所屬節點：${nodeName}\n\n永久刪除，無法復原。`)) return;
  try {
    await project.deleteItemRows([itemId]);
    showToast('項目已刪除', 'success');
    await loadStructure();
  } catch (err) {
    showToast('刪除失敗：' + err.message, 'error');
  }
}

// ===== 項目狀態快速切換（工地上最常用）=====
export async function changeItemStatus(itemId, status) {
  if (!(await ensureCanManage())) return;
  try {
    await project.updateItemRow(itemId, { status: status || null });
    const labels = { '': '未設定', in_progress: '進行中', completed: '已完成', paused: '暫停' };
    showToast('狀態已改為「' + (labels[status] || status) + '」', 'success');
    await loadStructure();
  } catch (err) {
    showToast(err.message, 'error');
    await loadStructure();
  }
}

// ===== 管理者：審核申請 =====
export async function loadApplications() {
  if (!isAdminMode) return;
  showSection('applicationsSection');
  const applications = await profiles.getPendingApplications();
  renderApplications(applications);
}

function renderApplications(applications) {
  const container = $('applicationsList');
  if (!container) return;
  container.innerHTML = '';
  applications.forEach(app => {
    const div = document.createElement('div');
    div.className = 'application-card';
    div.innerHTML = `
      <p><strong>${app.display_name}</strong> (${app.email})</p>
      <select class="role-select" data-user-id="${app.id}">
        <option value="user">使用者</option>
        <option value="viewer">檢視者</option>
      </select>
      <button onclick="handleApprove('${app.id}')">批准</button>
      <button onclick="handleReject('${app.id}')">拒絕</button>
    `;
    container.appendChild(div);
  });
}

// 批准申請
export async function handleApprove(userId) {
  const select = document.querySelector(`.role-select[data-user-id="${userId}"]`);
  const role = select?.value || 'user';
  try {
    await profiles.approveApplication(userId, role);
    showToast('已批准', 'success');
    loadApplications();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// 拒絕申請
export async function handleReject(userId) {
  try {
    await profiles.rejectApplication(userId);
    showToast('已拒絕', 'success');
    loadApplications();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ===== Toast 通知 =====
function showToast(message, type = 'error') {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ===== 匯出（inline onclick 需要）=====
window.showToast = showToast;
window.handleApprove = handleApprove;
window.handleReject = handleReject;
window.loadApplications = loadApplications;
window.switchToProject = switchToProject;
window.showProjects = showProjects;
window.showNewProjectForm = showNewProjectForm;
window.createNewProject = createNewProject;
window.closeModal = closeModal;
window.createLevel = createLevel;
window.createNode = createNode;
window.createProjectItem = createProjectItem;
window.startAddChild = startAddChild;
window.startEditNode = startEditNode;
window.saveNode = saveNode;
window.cancelEditNode = cancelEditNode;
window.deleteNode = deleteNode;
window.editItem = startEditItem;
window.startEditItem = startEditItem;
window.saveItem = saveItem;
window.cancelEditItem = cancelEditItem;
window.deleteItem = deleteItem;
window.changeItemStatus = changeItemStatus;
window.logout = async () => {
  try { await auth.logout(); } catch (e) { /* 已登出 */ }
  $('pendingNotice')?.classList.add('hidden');
  showLoginPage();
};

// ===== 啟動（原本 init() 從未被呼叫，所以整個後台從未初始化）=====
setupAuthHandlers();
init();
