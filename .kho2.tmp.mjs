import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id, name').ilike('name', '%Đại Kim%').single();
console.log('Kho: ' + org.name + '\n');

const { data: agents, error: ae } = await db.from('warehouse_agents').select('*').eq('organization_id', org.id);
if (ae) console.log('loi doc may kho: ' + ae.message);
for (const a of agents ?? []) {
  const keys = Object.keys(a).filter(k => /version|seen|status|code/i.test(k));
  console.log('MAY KHO ' + a.code + ': ' + keys.map(k => `${k}=${a[k]}`).join('  '));
}

// File ghi hinh con lai, theo ngay
const { data: files, error: fe } = await db.from('camera_recording_files')
  .select('started_at, retention_class, return_capture_id, deleted_at')
  .eq('organization_id', org.id)
  .gte('started_at', '2026-09-10')
  .order('started_at');
if (fe) { console.log('loi doc file ghi hinh: ' + fe.message); }
else {
  const byDay = new Map();
  for (const f of files ?? []) {
    const d = (f.started_at ?? '').slice(0,10);
    const s = byDay.get(d) ?? { tong:0, return_short:0, co_nhan:0, da_xoa:0 };
    s.tong++;
    if (f.retention_class === 'return_short') s.return_short++;
    if (f.return_capture_id) s.co_nhan++;
    if (f.deleted_at) s.da_xoa++;
    byDay.set(d, s);
  }
  console.log('\n=== FILE GHI HINH THEO NGAY (ban ghi tren he thong) ===');
  console.log('ngay        tong   han-7-ngay  co-nhan-hoan  da-danh-dau-xoa');
  for (const [d, s] of [...byDay].sort()) {
    console.log(`${d}  ${String(s.tong).padStart(5)}  ${String(s.return_short).padStart(10)}  ${String(s.co_nhan).padStart(12)}  ${String(s.da_xoa).padStart(15)}`);
  }
}
