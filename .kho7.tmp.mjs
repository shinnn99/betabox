import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: fails } = await db.from('order_proof_clips')
  .select('created_at, waybill_code, status, error_message, packing_event_id, camera_id, source_files, progress_state')
  .eq('organization_id', org.id).eq('status','failed').order('created_at',{ascending:false}).limit(6);
console.log('=== CAC LAN CAT CLIP THAT BAI GAN NHAT ===');
for (const f of fails ?? []) {
  console.log(`\n${(f.created_at ?? '').slice(0,19)}  don=${f.waybill_code}`);
  console.log('  loi: ' + String(f.error_message ?? '(trong)').slice(0,300));
  console.log('  tien trinh: ' + String(f.progress_state ?? '').slice(0,120));
  if (f.packing_event_id) {
    const { data: pe } = await db.from('packing_events').select('scanned_at, work_started_at, work_ended_at, status, event_kind').eq('id', f.packing_event_id).maybeSingle();
    if (pe) console.log(`  don quet luc: ${(pe.scanned_at ?? '').slice(0,19)}  loai=${pe.event_kind}  trang_thai=${pe.status}`);
  }
}
