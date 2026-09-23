// Project Module - 專案 CRUD、成員管理、資料存取
import { supabase } from './supabase-client.js';
import {
  getMyGlobalRole, getMyProjectRole, isAdmin, getProjectRoleLabel,
  canCreateProjectCurrent, canDeleteItemCurrent, canManageItemsCurrent
} from './permissions.js';

// 快取自己的 user id（inviteMember 要寫 invited_by 用）
let currentUserIdCache = null;

// 取得所有專案
export async function getProjects() {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// 取得單一專案
export async function getProject(id) {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

// 取得當前活動專案
export function getCurrentProject() {
  return window._currentProject || null;
}

// 切換活動專案
export function setCurrentProject(project) {
  window._currentProject = project;
}

// 建立專案
export async function createProject(name, desc) {
  const globalRole = await getMyGlobalRole();
  if (!canCreateProjectCurrent(globalRole)) {
    throw new Error('你沒有建立專案的權限');
  }
  // ⚠️ owner_id 一定要帶！資料庫有觸發器會用 new.owner_id 寫入 project_members，
  // owner_id 是 NULL 時會直接 23502（null value in column "user_id"）而整個建立失敗。
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('請先登入');
  const { data, error } = await supabase
    .from('projects')
    .insert([{ name, description: desc, owner_id: user.id }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 刪除專案
export async function deleteProject(id) {
  const globalRole = await getMyGlobalRole();
  if (!isAdmin(globalRole)) {
    throw new Error('只有管理者可以刪除專案');
  }
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// 取得專案成員
export async function getProjectMembers(projectId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('*')
    .eq('project_id', projectId);
  if (error) throw error;
  return data;
}

// 取得專案成員（含用戶名稱）
// ⚠️ 兩個資料庫陷阱（實測 project_members 的真實欄位）：
//   1. 這張表是「複合主鍵 (project_id, user_id)」，**沒有 id、沒有 created_at、沒有 email**
//      → 不能用 .order('created_at')，會 400 被 catch 吃掉、成員清單靜默空白
//   2. profiles 的 SELECT 政策只允許讀「自己」或「全域管理者」讀全部，
//      不能對 profiles 用關聯嵌入（select('*, profiles(...))，非 admin 會直接錯誤
export async function getProjectMembersWithNames(projectId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('*')
    .eq('project_id', projectId);
  if (error) throw error;
  const members = data || [];
  const ids = members.map(m => m.user_id).filter(Boolean);
  const map = {};
  if (ids.length) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, display_name, email, role, status')
      .in('id', ids);
    (profs || []).forEach(p => { map[p.id] = p; });
  }
  return members.map(m => ({ ...m, profile: map[m.user_id] || null }));
}

// 用 Email 找帳號（⚠️ 只有全域管理者讀得到別人的 profile）
export async function findProfileByEmail(email) {
  const e = String(email || '').trim();
  if (!e) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, status')
    .ilike('email', e)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// 找出某人是否已是這個專案的成員
export async function findMember(projectId, userId) {
  const { data, error } = await supabase
    .from('project_members')
    .select('*')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// 加入專案（自己加入）
export async function joinProject(projectId, role = 'viewer') {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('請先登入');
  const { data, error } = await supabase
    .from('project_members')
    .upsert([{ project_id: projectId, user_id: user.id, role }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 邀請成員（專案管理者／全域管理者用）
// 原本是直接把 email 塞進 project_members，但資料庫的權限判斷一律用 user_id，
// 而且 project_members 有 UNIQUE(project_id, user_id) / (project_id, email)，
// 直接寫 email 會撞唯一鍵或讓 user_id 是 NULL。所以改成：
//   Email → 查 profiles 拿 user_id → 寫入（已存在就改角色）
export async function inviteMember(projectId, email, role = 'viewer') {
  const globalRole = await getMyGlobalRole();
  const projectRole = await getMyProjectRole(projectId);
  if (!(isAdmin(globalRole) || projectRole === 'owner')) {
    throw new Error('只有專案管理者或全域管理者可以新增成員');
  }
  const target = String(email || '').trim();
  if (!target) throw new Error('請輸入成員的 Email');

  const profile = await findProfileByEmail(target);
  if (!profile) {
    throw new Error(`找不到「${target}」這個帳號。請先請他從登入頁「申請帳號」，你再到「審核申請」批准，然後回來這裡加入成員。`);
  }
  if (profile.status !== 'approved') {
    const stage = { pending: '待審核', rejected: '已拒絕' }[profile.status] || profile.status;
    throw new Error(`「${profile.display_name || profile.email}」目前是「${stage}」，還沒開通。請先到「審核申請」批准。`);
  }

  const existing = await findMember(projectId, profile.id);
  if (existing) {
    if (existing.role === role) {
      throw new Error(`「${profile.display_name || profile.email}」已經是這個專案的成員了（${getProjectRoleLabel(role)}）`);
    }
    const { data, error } = await supabase
      .from('project_members')
      .update({ role })
      .eq('project_id', projectId)
      .eq('user_id', profile.id)
      .select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('找不到這筆成員資料，沒有更新到任何列');
    return { member: data[0], profile, updated: true };
  }

  // ⚠️ 只寫真實存在的欄位（沒有 email！）＋ invited_by 留下「誰邀請的」痕跡
  const me = currentUserIdCache || (await supabase.auth.getUser()).data.user?.id || null;
  currentUserIdCache = me;
  const { data, error } = await supabase
    .from('project_members')
    .insert([{
      project_id: projectId,
      user_id: profile.id,
      role,
      ...(me ? { invited_by: me } : {})
    }])
    .select()
    .single();
  if (error) throw error;
  return { member: data, profile, updated: false };
}

// 這個專案有幾位 owner（用來防止把最後一位管理者移除／降級）
async function countOwners(projectId) {
  const { data } = await supabase
    .from('project_members')
    .select('user_id')
    .eq('project_id', projectId)
    .eq('role', 'owner');
  return data || [];
}

// 改變成員角色
// ⚠️ project_members 是複合主鍵 (project_id, user_id)，沒有 id 欄，
// 所以只能用這兩個欄位定位一列。
export async function updateMemberRoleRow(projectId, userId, role) {
  const globalRole = await getMyGlobalRole();
  const projectRole = await getMyProjectRole(projectId);
  if (!(isAdmin(globalRole) || projectRole === 'owner')) {
    throw new Error('只有專案管理者可以改變成員角色');
  }
  if (role !== 'owner') {
    const owners = await countOwners(projectId);
    if (owners.length === 1 && owners[0].user_id === userId) {
      throw new Error('這是最後一位專案管理者，不能降級。請先指定另一位專案管理者。');
    }
  }
  const { data, error } = await supabase
    .from('project_members')
    .update({ role })
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .select();
  if (error) throw error;
  if (!data || !data.length) throw new Error('找不到這筆成員資料，沒有更新到任何列');
  return data[0];
}

// 移除成員
export async function removeMemberRow(projectId, userId) {
  const globalRole = await getMyGlobalRole();
  const projectRole = await getMyProjectRole(projectId);
  if (!(isAdmin(globalRole) || projectRole === 'owner')) {
    throw new Error('只有專案管理者可以移除成員');
  }
  const owners = await countOwners(projectId);
  if (owners.length === 1 && owners[0].user_id === userId) {
    throw new Error('這是最後一位專案管理者，不能移除。請先指定另一位專案管理者。');
  }
  const { error } = await supabase
    .from('project_members')
    .delete()
    .eq('project_id', projectId)
    .eq('user_id', userId);
  if (error) throw error;
}

// 移除成員（舊簽章：projectId + userId，與上面等價）
export async function removeMember(projectId, userId) {
  return removeMemberRow(projectId, userId);
}

// ===== 地點樹（簡化後：不再需要使用者管理「階層」）=====

// 取得（必要時建立）這個專案的「地點」階層。
// 資料庫的 hierarchy_nodes.level_id 是 NOT NULL，所以底層還是需要一個階層列，
// 但 UI 完全不提它 —— 使用者只看到一棵「地點」樹。
// 名稱重複不再靠階層區分，而是靠 parent_id（路徑）。
export async function ensureDefaultLevel(projectId) {
  const { data, error } = await supabase
    .from('hierarchy_levels')
    .select('id')
    .eq('project_id', projectId)
    .order('level_index')
    .limit(1);
  if (error) throw error;
  if (data && data.length) return data[0].id;

  const { data: created, error: cErr } = await supabase
    .from('hierarchy_levels')
    .insert([{
      project_id: projectId,
      name: '地點',
      singular_name: '地點',
      plural_name: '地點',
      level_index: 1,
      sort_order: 1
    }])
    .select()
    .single();
  if (cErr) throw cErr;
  return created.id;
}

// ===== 複製地點子樹 =====
// 使用者的樓層結構是重複的（每層都有客廳／臥室），所以需要「一鍵複製整層」。
// 不依賴 crypto.randomUUID（非 secure context 會沒有），自己備一個。
const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });

// 回傳 { nodes, items }：複製了幾個地點、幾個項目
export async function duplicateNodeSubtree({
  projectId, levelId, rootNode, allNodes, itemsByNode,
  newName, newParentId, withItems
}) {
  // 1. 收集子樹：深度優先，父一定排在子前面
  const ordered = [];
  const collect = n => {
    ordered.push(n);
    allNodes.filter(c => c.parent_id === n.id).forEach(collect);
  };
  collect(rootNode);

  // 2. 先產生所有新 id，再組 rows —— 子節點才指得到「複製後的新父」
  const idMap = new Map();
  ordered.forEach(n => idMap.set(n.id, uuid()));

  const nodeRows = ordered.map(n => ({
    id: idMap.get(n.id),
    project_id: projectId,
    level_id: levelId,
    name: n.id === rootNode.id ? newName : n.name,
    description: n.description || null,
    parent_id: n.id === rootNode.id
      ? (newParentId || null)
      : (idMap.get(n.parent_id) || null)
  }));

  const { error: nErr } = await supabase.from('hierarchy_nodes').insert(nodeRows);
  if (nErr) throw nErr;

  // 3. 選擇性複製項目：只複製名稱，狀態／費用／負責人一律清空
  //    （每層的面積與進度都不一樣，複製費用會是錯的）
  let itemCount = 0;
  if (withItems) {
    const itemRows = [];
    ordered.forEach(n => {
      (itemsByNode[n.id] || []).forEach(it => itemRows.push({
        project_id: projectId,
        node_id: idMap.get(n.id),
        title: it.title,
        status: null,
        // 工項要帶著 —— 這是跨樓層彙總的依據
        work_type: it.work_type || null
      }));
    });
    if (itemRows.length) {
      const { error: iErr } = await supabase.from('items').insert(itemRows);
      if (iErr) throw new Error(`地點已複製，但項目複製失敗：${iErr.message}`);
      itemCount = itemRows.length;
    }
  }
  return { nodes: nodeRows.length, items: itemCount };
}

// ===== 工程紀錄（後台「進度歷程」用）=====

// 各項目各有幾筆紀錄（一次撈完，前端自己數，避免 N+1 查詢）
export async function getLogCountByItem(projectId) {
  const { data, error } = await supabase
    .from('project_logs')
    .select('item_id')
    .eq('project_id', projectId);
  if (error) throw error;
  const counts = {};
  (data || []).forEach(r => {
    if (r.item_id) counts[r.item_id] = (counts[r.item_id] || 0) + 1;
  });
  return counts;
}

// 某個項目的所有紀錄（由舊到新，含照片）——這就是「一個項目的完整生命週期」
export async function getItemLogs(itemId) {
  const base = 'id, log_date, log_time, location, main_description, progress_status, '
             + 'issues_found, resolution, notes, created_at';
  const cols = withRec => base + (withRec ? ', recorder_name' : '') + ', '
    + (withRec ? 'log_photos(id, photo_url, photo_description, sort_order, recorder_name)'
               : 'log_photos(id, photo_url, photo_description, sort_order)');
  const run = sel => supabase
    .from('project_logs')
    .select(sel)
    .eq('item_id', itemId)
    // 時間軸由舊到新：第一筆＝起點，最後一筆＝最新
    .order('log_date', { ascending: true })
    .order('created_at', { ascending: true });

  // 紀錄人是後加的欄位：先試有紀錄人的版本，欄位還沒加就自動退回舊版
  // （不要因為一個新欄位讓整個「進度歷程」打不開）
  let { data, error } = await run(cols(true));
  if (error) ({ data, error } = await run(cols(false)));
  if (error) throw error;
  return data || [];
}

// ===== 項目 CRUD =====

// 取得專案內所有項目
export async function getItems(projectId) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

// 建立項目
export async function createItem(projectId, data) {
  const canManage = await canManageItemsCurrent(projectId);
  if (!canManage) throw new Error('你沒有建立項目的權限');
  const { data: result, error } = await supabase
    .from('items')
    .insert([{ ...data, project_id: projectId }])
    .select()
    .single();
  if (error) throw error;
  return result;
}

// ===== 階層節點 =====

// 取得專案內所有節點（hierarchy_nodes 有自己的 project_id，可一次撈完）
export async function getNodesByProject(projectId) {
  const { data, error } = await supabase
    .from('hierarchy_nodes')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order');
  if (error) throw error;
  return data;
}

// 建立節點
export async function createNode(data) {
  const canManage = await canManageItemsCurrent(data.project_id);
  if (!canManage) throw new Error('你沒有建立節點的權限');
  const { data: created, error } = await supabase
    .from('hierarchy_nodes')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return created;
}

// 更新項目
export async function updateItem(id, data) {
  const canManage = await canManageItemsCurrent(data.project_id || null);
  if (!canManage) throw new Error('你沒有編輯項目的權限');
  // 註：解構出的變數不能也叫 data（與參數同名 → SyntaxError）
  const { data: updated, error } = await supabase
    .from('items')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return updated;
}

// 刪除項目
export async function deleteItem(id) {
  const canDelete = await canDeleteItemCurrent(id);
  if (!canDelete) throw new Error('你沒有刪除項目的權限');
  const { error } = await supabase
    .from('items')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// 取得單一項目
export async function getItem(id) {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

// ===== 階層 =====

// 取得專案階層定義（用 level_index 排序，不是 sort_order）
export async function getHierarchyLevels(projectId) {
  const { data, error } = await supabase
    .from('hierarchy_levels')
    .select('*')
    .eq('project_id', projectId)
    .order('level_index');
  if (error) throw error;
  return data;
}

// 建立階層定義（必填：level_index / name / singular_name / plural_name）
export async function createHierarchyLevel(projectId, data) {
  const canManage = await canManageItemsCurrent(projectId);
  if (!canManage) throw new Error('你沒有管理階層的權限');
  const payload = {
    project_id: projectId,
    name: data.name,
    singular_name: data.singular_name || data.name,
    plural_name: data.plural_name || data.name,
    level_index: data.level_index,
    sort_order: data.sort_order ?? data.level_index
  };
  const { data: created, error } = await supabase
    .from('hierarchy_levels')
    .insert([payload])
    .select()
    .single();
  if (error) throw error;
  return created;
}

// 更新階層定義
export async function updateHierarchyLevel(id, data) {
  const { data: updated, error } = await supabase
    .from('hierarchy_levels')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return updated;
}

// 刪除階層定義（呼叫端必須先刪掉底下的節點與項目）
export async function deleteHierarchyLevel(id) {
  const { error } = await supabase.from('hierarchy_levels').delete().eq('id', id);
  if (error) throw error;
}

// 更新節點
export async function updateNodeRow(id, data) {
  const { data: updated, error } = await supabase
    .from('hierarchy_nodes')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return updated;
}

// 批次刪除節點（.in 需要非空陣列，呼叫端要先確認）
export async function deleteNodeRows(ids) {
  if (!ids.length) return 0;
  const { error } = await supabase.from('hierarchy_nodes').delete().in('id', ids);
  if (error) throw error;
  return ids.length;
}

// 更新項目
export async function updateItemRow(id, data) {
  const { data: updated, error } = await supabase
    .from('items')
    .update(data)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return updated;
}

// 批次刪除項目
export async function deleteItemRows(ids) {
  if (!ids.length) return 0;
  const { error } = await supabase.from('items').delete().in('id', ids);
  if (error) throw error;
  return ids.length;
}

// 取得階層節點
export async function getHierarchyNodes(levelId) {
  const { data, error } = await supabase
    .from('hierarchy_nodes')
    .select('*')
    .eq('level_id', levelId)
    .order('sort_order');
  if (error) throw error;
  return data;
}
