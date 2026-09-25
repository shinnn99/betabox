import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: fails } = await db.from('order_proof_clips')
  .select('created_at, waybill_code, status, error_message, packing_event_id, camera_id, qr_camera_id, source_files, cut_mode, generation_params')
  .eq('organization_id', org.id).gte('created_at','2026-09-25').order('created_at',{ascending:false});
for (const f of fails ?? []) {
  console.log(`\n${(f.created_at ?? '').slice(0,19)}  don=${f.waybill_code}  trang_thai=${f.status}`);
  console.log('  loi: ' + String(f.error_message ?? '(TRONG — khong ghi ly do)').slice(0,400));
  console.log('  che do cat: ' + String(f.cut_mode ?? '') + '  | so file nguon: ' + (Array.isArray(f.source_files) ? f.source_files.length : String(f.source_files ?? '')));
  if (f.packing_event_id) {
    const { data: pe } = await db.from('packing_events')
      .select('scanned_at, work_started_at, work_ended_at, event_kind, status, proof_camera_id')
      .eq('id', f.packing_event_id).maybeSingle();
    if (pe) console.log(`  don: quet ${(pe.scanned_at ?? '').slice(0,19)} | lam viec ${(pe.work_started_at ?? '').slice(0,19)} -> ${(pe.work_ended_at ?? '').slice(0,19)} | loai=${pe.event_kind}`);
  }
  // Segment con ban ghi trong khung gio do khong?
  if (f.camera_id && f.packing_event_id) {
    const { data: pe2 } = await db.from('packing_events').select('work_started_at, scanned_at, work_ended_at').eq('id', f.packing_event_id).maybeSingle();
    const from = pe2?.work_started_at ?? pe2?.scanned_at;
    if (from) {
      const { data: segs } = await db.from('camera_recording_files')
        .select('file_name, started_at, retention_class, return_capture_id')
        .eq('organization_id', org.id).eq('camera_id', f.camera_id)
        .gte('started_at', new Date(new Date(from).getTime()-10*60000).toISOString())
        .lte('started_at', new Date(new Date(pe2?.work_ended_at ?? from).getTime()+10*60000).toISOString());
      console.log(`  segment con ban ghi quanh khung gio: ${segs?.length ?? 0}` + (segs?.length ? ` (vd ${segs[0].file_name}, han=${segs[0].retention_class})` : ''));
    }
  }
}
