// 看板共用邏輯（公開頁 index.html 與後台 entries.html 都用 <script src="board.js"> 引入）
//
// 為什麼要共用：兩邊要呈現「狀態 → 工項 → 紀錄」的同一套結構，
// 邏輯各寫一份一定會走鐘（分組順序、開案天數、排序規則…）。
//
// ⚠️ 這是 classic script（不是 module）：
//    index.html 的 inline script 是 classic、entries.html 的是 module，
//    只有 classic 能被兩邊同時用 <script src> 載入。
//    載入順序：board.js 一定要放在兩個頁面的主 script **之前**
//    （module 是 deferred，會等 classic 跑完，所以 entries.html 也拿得到）。
//
// 這裡只放**純函式與常數**（不碰 DOM），所以可以直接丟進 vm 測試。

// 一個「工項」＝一條時間軸。分組看的是**工項的狀態**（items.status），
// 不是單筆紀錄的 progress_status（那是寫入當下的快照）。
const STATUS_ORDER = ['', 'in_progress', 'paused', 'completed'];
const GROUP_TITLE = { '': '開案（待辦）', in_progress: '進行中', paused: '暫停', completed: '已完成' };
const STATUS_LABEL = { '': '開案', completed: '已完成', in_progress: '進行中', paused: '暫停' };
const STATUS_CLASS = { '': 'opened', completed: 'done', in_progress: 'doing', paused: 'paused' };
// 已完成＝做完的，預設收起來，資料多時才找得到東西
const COLLAPSED_BY_DEFAULT = { completed: true };

function daysSince(d) {
    if (!d) return null;
    const ms = Date.now() - new Date(String(d) + 'T00:00:00').getTime();
    if (isNaN(ms)) return null;
    return ms < 0 ? 0 : Math.floor(ms / 86400000);
}

function fmtMonthDay(d) {
    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${Number(m[2])}/${Number(m[3])}` : String(d || '');
}

// 待辦事項：一筆紀錄的 resolution 可能是一行一項
function todoLines(v) {
    if (!v) return [];
    return String(v).split(/\r?\n/)
        .map(s => s.replace(/^[\s\-–—•・*]+/, '').trim())
        .filter(Boolean);
}

// 報價單列表：items.quotes 是 jsonb 陣列 [{ name, url }]；也可能是字串（保險 parse）
function quoteList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v) {
        try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
    }
    return [];
}

// 開案時間＝**卡片建立日** 與 **最早那筆紀錄的日期** 取較早的。
// 為什麼：卡片可能是今天才補建的（例如舊紀錄事後才補上工項），
// 那時候「開案」其實是紀錄那天，不是今天。
function openingOf(sorted, last) {
    const earliestLog = (sorted[0] && sorted[0].log_date) || '';
    const created = String((last && last.item_created_at) || '').slice(0, 10);
    if (!created) return earliestLog;
    if (!earliestLog) return created;
    return created < earliestLog ? created : earliestLog;
}

// 純函式（方便測試）：把紀錄整理成 狀態 → 工項 → 紀錄 三層
// 每筆紀錄要有的欄位：id, log_date, item_id, item_status, item_title,
//                     node_name/location, photos[], recorder_name
// 後台會多帶一個 src（原始 entry），編輯表單要用。
function buildTree(logs) {
    const byItem = new Map();
    for (const l of (logs || [])) {
        if (!l.item_id) continue;
        if (!byItem.has(l.item_id)) byItem.set(l.item_id, []);
        byItem.get(l.item_id).push(l);
    }
    const groups = STATUS_ORDER.map(st => ({ status: st, title: GROUP_TITLE[st], items: [] }));
    const byStatus = new Map(groups.map(g => [g.status, g]));
    for (const [itemId, list] of byItem) {
        // 舊 → 新
        const sorted = [...list].sort((a, b) =>
            String(a.log_date || '').localeCompare(String(b.log_date || '')));
        const last = sorted[sorted.length - 1];
        // 工項狀態：null / 不認識的值都算「開案」。
        // ⚠️ 不要退回用紀錄的 progress_status —— 那是「寫入當下的快照」，
        //    拿它當工項現在的狀態，會讓「開案」的工項跑到「進行中 / 已完成」那一欄。
        const raw = last.item_status;
        const st = STATUS_ORDER.indexOf(raw) >= 0 ? raw : '';
        let shots = 0;
        for (const l of sorted) shots += (l.photos ? l.photos.length : 0);
        byStatus.get(st).items.push({
            itemId, status: st,
            title: last.item_title || '（未命名工項）',
            loc: last.node_name || last.location || '',
            logs: sorted, shots,
            byNames: [...new Set(sorted.map(x => x.recorder_name).filter(Boolean))],
            opening: openingOf(sorted, last),
            days: daysSince(openingOf(sorted, last)),
            maintenance: !!last.maintenance,
            next_maintenance_at: last.next_maintenance_at || null,
            quotes: quoteList(last.quotes),
        });
    }
    for (const g of groups) {
        // 未完成：開案最久的排上面（放越久越要看到）；已完成：最新的排上面
        g.items.sort((a, b) => g.status === 'completed'
            ? String(b.opening).localeCompare(String(a.opening))
            : String(a.opening).localeCompare(String(b.opening)));
    }
    // 看板固定四欄（空的也留著，才看得出整個結構；空欄顯示 —）
    const shown = groups.slice();

    // 沒有指定工項的紀錄（只記現場狀況）也不能消失 —— 收在最後一組，各自一列
    const loose = (logs || []).filter(l => !l.item_id)
        .sort((a, b) => String(b.log_date || '').localeCompare(String(a.log_date || '')));
    if (loose.length) {
        shown.push({
            status: '_loose', title: '未歸類（只記現場狀況）',
            items: loose.map(l => ({
                itemId: 'log:' + l.id, status: '_loose',
                title: (l.main_description || '').split('\n')[0].slice(0, 24) || '現場狀況',
                loc: l.node_name || l.location || '',
                logs: [l], shots: (l.photos ? l.photos.length : 0),
                byNames: l.recorder_name ? [l.recorder_name] : [],
                opening: l.log_date || '', days: daysSince(l.log_date),
            })),
        });
    }
    return shown;
}
