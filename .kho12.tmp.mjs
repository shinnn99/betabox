import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: cams } = await db.from('cameras').select('id, camera_code, name, created_at').eq('organization_id', org.id);
const byId = new Map((cams ?? []).map(c => [c.id, c]));

// Vai tro camera tren ban
const { data: devs } = await db.from('station_devices').select('id, config_json, device_type').eq('organization_id', org.id).eq('device_type','camera');
const role = new Map();
for (const d of devs ?? []) {
  const cid = d.config_json?.camera_id;
  if (cid) role.set(cid, d.config_json?.role ?? '(chua dat)');
}
console.log('=== CAMERA CUA KHO ===');
for (const c of cams ?? []) console.log(`  ${c.camera_code.padEnd(12)} ${String(c.name ?? '').padEnd(28)} vai_tro=${role.get(c.id) ?? '(chua gan ban)'}  khai_bao=${(c.created_at ?? '').slice(0,10)}`);

// Segment theo camera theo ngay
let rows = [], from = 0;
for (;;) {
  const { data } = await db.from('camera_recording_files').select('camera_id, started_at')
    .eq('organization_id', org.id).gte('started_at','2026-09-01').order('started_at').range(from, from+999);
  rows.push(...(data ?? [])); if ((data ?? []).length < 1000) break; from += 1000;
}
const days = new Map();
for (const r of rows) {
  const d = (r.started_at ?? '').slice(0,10);
  const m = days.get(d) ?? new Map();
  m.set(r.camera_id, (m.get(r.camera_id) ?? 0) + 1);
  days.set(d, m);
}
const order = (cams ?? []).map(c => c.id);
console.log('\n=== SO SEGMENT MOI NGAY THEO CAMERA ===');
console.log('ngay         ' + (cams ?? []).map(c => c.camera_code.padStart(10)).join(''));
for (const [d, m] of [...days].sort()) {
  console.log(`${d}  ` + order.map(id => String(m.get(id) ?? 0).padStart(10)).join(''));
}
console.log('\n=== SEGMENT DAU TIEN / CUOI CUNG CUA TUNG CAMERA ===');
for (const c of cams ?? []) {
  const { data: first } = await db.from('camera_recording_files').select('started_at').eq('organization_id', org.id).eq('camera_id', c.id).order('started_at').limit(1);
  const { data: last } = await db.from('camera_recording_files').select('started_at').eq('organization_id', org.id).eq('camera_id', c.id).order('started_at',{ascending:false}).limit(1);
  console.log(`  ${c.camera_code.padEnd(12)} tu ${(first?.[0]?.started_at ?? 'chua co').slice(0,16)}  den ${(last?.[0]?.started_at ?? '').slice(0,16)}`);
}
