// Supabase Client - 統一設定與初始化
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = 'https://mnhtegouhzfhigydvgwd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ZMU29KQPn0xuBadGJq6Zwg_cHpWe7ZZ';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
