import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: clip } = await db.from('order_proof_clips')
  .select('camera_id, qr_camera_id, packing_event_id, created_at')
  .eq('organization_id', org.id).eq('status','failed').gte('created_at','2026-09-25')
  .order('created_at',{ascending:false}).limit(1).single();
const { data: pe } = await db.from('packing_events')
  .select('id, scanned_at, work_started_at, work_ended_at, proof_camera_id, proof_qr_camera_id, station_id')
  .eq('id', clip.packing_event_id).single();
const start = new Date(new Date(pe.work_started_at ?? pe.scanned_at).getTime() - 60000).toISOString();
const end = new Date(new Date(pe.work_ended_at ?? pe.scanned_at).getTime() + 60000).toISOString();
console.log(`Don ngay 17/09 | cua so clip: ${start.slice(0,19)} -> ${end.slice(0,19)}`);
console.log(`camera clip dung = ${clip.camera_id}`);
console.log(`camera cua don   = ${pe.proof_camera_id}  (khop: ${clip.camera_id === pe.proof_camera_id ? 'CO' : 'KHONG'})`);

const count = async (label, apply) => {
  let q = db.from('camera_recording_files').select('id, agent_id, source, file_name, started_at', { count: 'exact' })
    .eq('organization_id', org.id).lt('started_at', end).or(`ended_at.is.null,ended_at.gt."${start}"`);
  q = apply(q);
  const { data, count: c, error } = await q.limit(3);
  console.log(`${label.padEnd(46)} ${error ? 'LOI ' + error.message : (c ?? 0) + ' segment' + (data?.[0] ? '  vd ' + data[0].file_name + ' source=' + data[0].source : '')}`);
};
console.log('\n=== DEM SEGMENT TRONG CUA SO, NOI LONG DAN TUNG DIEU KIEN ===');
await count('dung dung bo loc cua he thong (camera+source=agent)', q => q.eq('camera_id', clip.camera_id).eq('source','agent'));
await count('bo dieu kien source=agent', q => q.eq('camera_id', clip.camera_id));
await count('doi sang camera cua don', q => q.eq('camera_id', pe.proof_camera_id ?? clip.camera_id).eq('source','agent'));
await count('moi camera trong kho', q => q);

const { data: cams } = await db.from('cameras').select('id, camera_code, name').eq('organization_id', org.id);
console.log('\n=== CAMERA CUA KHO ===');
for (const c of cams ?? []) console.log(`  ${c.camera_code.padEnd(14)} ${c.name ?? ''}  id=${c.id.slice(0,8)}`);
