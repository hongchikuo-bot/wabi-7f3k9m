// Items Module - 項目 CRUD、即時訂閱
import { supabase } from './supabase-client.js';
import { getMyProjectRole, canManageItems, canDeleteItem } from './permissions.js';

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
  const myRole = await getMyRole(projectId);
  const canDo = canManageItems(null, myRole);
  if (!canDo) throw new Error('你沒有建立項目的權限');
  const { data: result, error } = await supabase
    .from('items')
    .insert([{ ...data, project_id: projectId }])
    .select()
    .single();
  if (error) throw error;
  return result;
}

// 更新項目
export async function updateItem(id, data) {
  const myRole = await getMyProjectRole(data.project_id);
  if (!canManageItems(null, myRole)) throw new Error('你沒有編輯項目的權限');
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
  const item = await supabase.from('items').select('project_id').eq('id', id).single();
  const myRole = await getMyRole(item.data.project_id);
  if (!canDeleteItem(null, myRole)) throw new Error('你沒有刪除項目的權限');
  const { error } = await supabase.from('items').delete().eq('id', id);
  if (error) throw error;
}

// 即時訂閱項目變更
export function subscribeItems(projectId, callback) {
  return supabase
    .channel('items-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, callback)
    .subscribe();
}
