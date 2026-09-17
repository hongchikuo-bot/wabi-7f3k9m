// Auth Module - 申請制登入（註冊 + 登入 + 審核狀態）
import { supabase } from './supabase-client.js';
import { createProfile, getMyProfile, getMyGlobalRole, isApproved, getPendingApplications, approveApplication } from './profiles.js';

// 註冊（申請制）
export async function register(name, email, password) {
  const { data, error } = await supabase.auth.signUp({
    email, password, options: {
      data: { full_name: name, display_name: name }
    }
  });
  if (error) throw error;
  // 自動建立 profile（狀態 pending）
  const profile = await createProfile(data.user.id, name, email);
  return { user: data.user, profile };
}

// 登入
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const approved = await isApproved();
  const profile = await getMyProfile();
  if (!approved) {
    throw new Error('ACCOUNT_PENDING');
  }
  return { user: data.user, profile };
}

// 登出
export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// 取得當前用戶
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// 取得待審核申請列表（管理者用）
export async function loadApplications() {
  return getPendingApplications();
}

// 批准申請（管理者用）
export async function handleApprove(userId, role) {
  return approveApplication(userId, role);
}
