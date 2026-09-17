// Permissions Module - 雙層 RBAC 權限判斷
// 全局角色：admin / user / viewer
// 專案內角色：owner / editor / viewer
//
// ⚠️ 這個模組一定要 import supabase，否則呼叫 getMyGlobalRole() 會直接
// ReferenceError: supabase is not defined（整個後台一按「新增專案」就爆）。
import { supabase } from './supabase-client.js';

export const GLOBAL_ROLES = { ADMIN: 'admin', USER: 'user', VIEWER: 'viewer' };
export const PROJECT_ROLES = { OWNER: 'owner', EDITOR: 'editor', VIEWER: 'viewer' };

// 取得全局角色
export async function getMyGlobalRole() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  return profile?.role || null;
}

// 取得專案內角色
export async function getMyProjectRole(projectId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: member } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .single();
  return member?.role || null;
}

// 專案內角色標籤
export function getProjectRoleLabel(role) {
  const labels = { owner: '專案管理者', editor: '編輯者', viewer: '檢視者' };
  return labels[role] || role;
}

// 全局角色判斷
export function isAdmin(globalRole) { return globalRole === GLOBAL_ROLES.ADMIN; }
export function isUser(globalRole) { return globalRole === GLOBAL_ROLES.USER; }
export function isViewer(globalRole) { return globalRole === GLOBAL_ROLES.VIEWER; }

// 專案權限：是否可管理階層
export function canManageHierarchy(globalRole, projectRole) {
  if (isAdmin(globalRole)) return true;
  if (projectRole === PROJECT_ROLES.OWNER) return true;
  return false;
}

// 專案權限：是否可管理項目
export function canManageItems(globalRole, projectRole) {
  if (isAdmin(globalRole)) return true;
  if (projectRole === PROJECT_ROLES.OWNER || projectRole === PROJECT_ROLES.EDITOR) return true;
  return false;
}

// 專案權限：是否可刪除項目
export function canDeleteItem(globalRole, projectRole) {
  return isAdmin(globalRole) || projectRole === PROJECT_ROLES.OWNER;
}

// 專案權限：是否可建立項目
export function canCreateItem(globalRole, projectRole) {
  return canManageItems(globalRole, projectRole);
}

// 專案內是否可建立專案
export function canCreateProjectCurrent(globalRole) {
  return isAdmin(globalRole) || isUser(globalRole);
}

// 專案內是否可刪除項目（當前用戶針對該項目）
export async function canDeleteItemCurrent(itemId) {
  const globalRole = await getMyGlobalRole();
  const { data: item } = await supabase.from('items').select('project_id').eq('id', itemId).single();
  if (!item) return false;
  const projectRole = await getMyProjectRole(item.project_id);
  return canDeleteItem(globalRole, projectRole);
}

// 專案內是否可管理項目（當前用戶針對該專案）
export async function canManageItemsCurrent(projectId) {
  const globalRole = await getMyGlobalRole();
  const projectRole = await getMyProjectRole(projectId);
  return canManageItems(globalRole, projectRole);
}

// 專案內是否可刪除項目（當前用戶針對該專案）
// 註：原本這個函式與上面的 canDeleteItemCurrent 同名，造成重複匯出的
// SyntaxError，整個模組無法載入 → 後台全掛。改名為 canDeleteItemInProject。
export async function canDeleteItemInProject(projectId) {
  const globalRole = await getMyGlobalRole();
  const projectRole = await getMyProjectRole(projectId);
  return canDeleteItem(globalRole, projectRole);
}
