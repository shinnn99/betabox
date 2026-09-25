import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
let rows = [], from = 0;
for (;;) {
  const { data } = await db.from('camera_recording_files').select('started_at, agent_id, camera_id')
    .eq('organization_id', org.id).gte('started_at','2026-09-08').order('started_at').range(from, from+999);
  rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break; from += 1000;
}
const byDay = new Map();
for (const r of rows) {
  const d = (r.started_at ?? '').slice(0,10);
  const s = byDay.get(d) ?? { co:0, khong:0 };
  if (r.agent_id) s.co++; else s.khong++;
  byDay.set(d, s);
}
console.log('ngay          co ma may kho   THIEU ma may kho');
for (const [d,s] of [...byDay].sort()) console.log(`${d}   ${String(s.co).padStart(12)}   ${String(s.khong).padStart(14)}${s.khong ? '   <-- khong tim lai duoc' : ''}`);
const thieu = rows.filter(r => !r.agent_id).length;
console.log(`\nTONG: ${thieu}/${rows.length} ban ghi thieu ma may kho`);
