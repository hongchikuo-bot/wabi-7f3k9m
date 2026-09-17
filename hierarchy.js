// Hierarchy Module - 階層定義/節點 CRUD、樹狀渲染
import { supabase } from './supabase-client.js';

// 新增節點
export async function createLevelNode(levelId, data) {
  const { data: result, error } = await supabase
    .from('hierarchy_nodes')
    .insert([{ ...data, level_id: levelId }])
    .select()
    .single();
  if (error) throw error;
  return result;
}

// 取得節點路徑（從根到該節點）
export function getNodePath(nodeMap, nodeId) {
  const path = [];
  let current = nodeMap.get(nodeId);
  while (current) {
    path.unshift(current);
    current = current.parent_id ? nodeMap.get(current.parent_id) : null;
  }
  return path;
}

// 取得節點子孫（所有下層節點）
export function getNodeDescendants(nodeMap, nodeId) {
  const descendants = [];
  const children = [...nodeMap.values()].filter(n => n.parent_id === nodeId);
  for (const child of children) {
    descendants.push(child);
    descendants.push(...getNodeDescendants(nodeMap, child.id));
  }
  return descendants;
}

// 渲染樹狀結構（HTML）
export function renderTree(nodeMap, levelId) {
  const roots = [...nodeMap.values()].filter(n => n.level_id === levelId && !n.parent_id);
  if (roots.length === 0) return '<p>暫無資料</p>';
  const ul = document.createElement('ul');
  roots.forEach(root => { ul.appendChild(renderNode(root, nodeMap)); });
  return ul.outerHTML;
}

// 遞迴渲染單節點
function renderNode(node, nodeMap) {
  const children = [...nodeMap.values()].filter(n => n.parent_id === node.id);
  const li = document.createElement('li');
  li.innerHTML = `<span>${node.name}</span>`;
  if (children.length > 0) {
    const childUl = document.createElement('ul');
    children.forEach(child => { childUl.appendChild(renderNode(child, nodeMap)); });
    li.appendChild(childUl);
  }
  return li;
}
