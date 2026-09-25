import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();

const { data: agents } = await db.from('warehouse_agents').select('id, code, status, created_at, last_seen_at').eq('organization_id', org.id).order('created_at');
console.log('=== MAY KHO KHAI TRONG HE THONG ===');
for (const a of agents ?? []) console.log(`  ${a.code.padEnd(22)} id=${a.id.slice(0,8)} trang_thai=${a.status} tao=${(a.created_at??'').slice(0,10)} lan_cuoi=${(a.last_seen_at??'').slice(0,19)}`);

const { data: cam } = await db.from('cameras').select('id, camera_code, agent_id').eq('organization_id', org.id).eq('camera_code','dahua_01').single();
console.log(`\ncamera dahua_01 dang gan may kho id=${String(cam.agent_id).slice(0,8)}`);

// agent_id tren cac segment ngay 17 vs ngay 23-24
for (const [nhan, tu, den] of [['ngay 17/09','2026-09-17','2026-09-18'], ['ngay 23/09','2026-09-23','2026-09-24'], ['ngay 24/09','2026-09-24','2026-09-25']]) {
  const { data } = await db.from('camera_recording_files').select('agent_id').eq('organization_id', org.id).eq('camera_id', cam.id).gte('started_at', tu).lt('started_at', den).limit(2000);
  const dem = new Map();
  for (const r of data ?? []) dem.set(r.agent_id, (dem.get(r.agent_id) ?? 0) + 1);
  console.log(`${nhan}: ` + [...dem].map(([id,n]) => `${String(id).slice(0,8)} = ${n} segment`).join(' | '));
}
