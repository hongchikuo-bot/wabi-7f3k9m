// Profiles Module - 全局帳號管理、申請狀態、角色
import { supabase } from './supabase-client.js';

// 建立或更新 profile（註冊時自動呼叫）
export async function createProfile(userId, displayName, email, globalRole = 'user') {
  const { data, error } = await supabase
    .from('profiles')
    .upsert([{ id: userId, display_name: displayName, email, role: globalRole, status: 'pending' }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 取得我的 profile
export async function getMyProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();
  if (error) throw error;
  return data;
}

// 取得我的全局角色
export async function getMyGlobalRole() {
  const profile = await getMyProfile();
  return profile?.role || null;
}

// 檢查申請是否已批准
export async function isApproved() {
  const profile = await getMyProfile();
  return profile?.status === 'approved';
}

// 取得所有待審核申請（管理者用）
export async function getPendingApplications() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// 批准申請（管理者用）
export async function approveApplication(userId, globalRole = 'user') {
  const { data, error } = await supabase
    .from('profiles')
    .update({ status: 'approved', role: globalRole })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 拒絕申請（管理者用）
export async function rejectApplication(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ status: 'rejected' })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 設定角色（管理者用）
export async function setUserRole(userId, globalRole) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ role: globalRole })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
}
