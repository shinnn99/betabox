import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id, name').ilike('name','%Đại Kim%').single();

let rows = [], from = 0;
for (;;) {
  const { data, error } = await db.from('camera_recording_files')
    .select('started_at, retention_class, return_capture_id, status, file_size_bytes')
    .eq('organization_id', org.id).gte('started_at','2026-09-08')
    .order('started_at').range(from, from + 999);
  if (error) { console.log('loi: '+error.message); break; }
  rows.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
  from += 1000;
}
const byDay = new Map();
for (const f of rows) {
  const d = (f.started_at ?? '').slice(0,10);
  const s = byDay.get(d) ?? { tong:0, short:0, nhan:0, gb:0, trangthai:new Set() };
  s.tong++; s.gb += (f.file_size_bytes ?? 0)/1073741824;
  if (f.retention_class === 'return_short') s.short++;
  if (f.return_capture_id) s.nhan++;
  s.trangthai.add(f.status);
  byDay.set(d, s);
}
console.log('=== BAN GHI FILE GHI HINH THEO NGAY (' + rows.length + ' dong) ===');
console.log('ngay          so file   dung luong   han-7-ngay  co-nhan-hoan  trang thai');
for (const [d,s] of [...byDay].sort())
  console.log(`${d}   ${String(s.tong).padStart(6)}   ${s.gb.toFixed(1).padStart(7)} GB  ${String(s.short).padStart(9)}  ${String(s.nhan).padStart(12)}  ${[...s.trangthai].join(',')}`);
