import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: cams } = await db.from('cameras').select('id, camera_code, name, status, agent_id').eq('organization_id', org.id);
const { data: devs } = await db.from('station_devices').select('id, config_json, device_type, device_code').eq('organization_id', org.id).eq('device_type','camera');
const { data: asg } = await db.from('station_device_assignments').select('device_id, station_id, assigned_at, unassigned_at').eq('organization_id', org.id);
const { data: st } = await db.from('packing_stations').select('id, code, name');
console.log('=== TRANG THAI TUNG CAMERA ===');
for (const c of cams ?? []) {
  const dev = (devs ?? []).find(d => d.config_json?.camera_id === c.id);
  const a = (asg ?? []).filter(x => x.device_id === dev?.id).sort((p,q)=> (p.assigned_at<q.assigned_at?1:-1))[0];
  const ban = a ? (st ?? []).find(s => s.id === a.station_id)?.code : null;
  const dangGan = a && !a.unassigned_at;
  console.log(`${c.camera_code.padEnd(12)} trang_thai=${String(c.status).padEnd(8)} vai_tro=${String(dev?.config_json?.role ?? '(khong co thiet bi)').padEnd(14)} ban=${ban ?? '-'} ${dangGan ? '<= DANG GAN' : (a ? 'da go luc ' + (a.unassigned_at ?? '').slice(0,10) : 'chua tung gan')}`);
}
// Ban ghi tro toi file cua camera da ngung dung
for (const code of ['dahua_01','hik_3']) {
  const c = (cams ?? []).find(x => x.camera_code === code);
  if (!c) continue;
  const { count } = await db.from('camera_recording_files').select('id', { count: 'exact', head: true }).eq('organization_id', org.id).eq('camera_id', c.id);
  const { data: last } = await db.from('camera_recording_files').select('file_path, started_at').eq('organization_id', org.id).eq('camera_id', c.id).order('started_at',{ascending:false}).limit(1);
  console.log(`\n${code}: ${count} ban ghi file trong he thong, moi nhat ${(last?.[0]?.started_at ?? '').slice(0,16)}`);
  console.log(`   duong dan mau: ${last?.[0]?.file_path ?? '(khong co)'}`);
}
