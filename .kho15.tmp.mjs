import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: cams } = await db.from('cameras').select('id, camera_code').eq('organization_id', org.id);
const { data: devs } = await db.from('station_devices').select('id, device_code, config_json, status, created_at').eq('organization_id', org.id).eq('device_type','camera').order('created_at');
console.log('=== CAC BAN GHI THIET BI CAMERA ===');
for (const d of devs ?? []) {
  const c = (cams ?? []).find(x => x.id === d.config_json?.camera_id);
  console.log(`  ${String(d.device_code ?? d.id.slice(0,8)).padEnd(18)} camera=${(c?.camera_code ?? '?').padEnd(10)} vai_tro=${String(d.config_json?.role ?? '-').padEnd(14)} trang_thai=${d.status ?? '-'}  tao=${(d.created_at ?? '').slice(0,10)}`);
}
// Thu muc trong duong dan file cua tung camera
console.log('\n=== THU MUC THUC SU TRONG DUONG DAN FILE ===');
for (const c of cams ?? []) {
  const { data } = await db.from('camera_recording_files').select('file_path').eq('organization_id', org.id).eq('camera_id', c.id).limit(1);
  const thuMuc = (data?.[0]?.file_path ?? '').split('/')[0];
  console.log(`  camera ${c.camera_code.padEnd(12)} -> thu muc "${thuMuc || '(khong co file)'}"${thuMuc && thuMuc !== c.camera_code ? '   <== TEN KHAC MA CAMERA' : ''}`);
}
