import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();

let pe = [], from = 0;
for (;;) {
  const { data } = await db.from('packing_events').select('scanned_at, proof_camera_id, proof_qr_camera_id, event_kind, status')
    .eq('organization_id', org.id).gte('scanned_at','2026-09-01').order('scanned_at').range(from, from+999);
  pe.push(...(data ?? [])); if ((data ?? []).length < 1000) break; from += 1000;
}
const d = new Map();
for (const e of pe) {
  const k = (e.scanned_at ?? '').slice(0,10);
  const s = d.get(k) ?? { don:0, co_toan_canh:0, co_qr:0 };
  s.don++; if (e.proof_camera_id) s.co_toan_canh++; if (e.proof_qr_camera_id) s.co_qr++;
  d.set(k, s);
}
console.log('=== DON THEO NGAY VA CAMERA DUOC GAN ===');
console.log('ngay          so don   co camera toan canh   co camera QR');
for (const [k,s] of [...d].sort()) console.log(`${k}   ${String(s.don).padStart(6)}   ${String(s.co_toan_canh).padStart(18)}   ${String(s.co_qr).padStart(12)}`);

const { data: clips } = await db.from('order_proof_clips').select('created_at, angles_present, status').eq('organization_id', org.id).gte('created_at','2026-09-01').order('created_at');
const ang = new Map();
for (const c of clips ?? []) {
  const k = JSON.stringify(c.angles_present ?? null) + ' / ' + c.status;
  ang.set(k, (ang.get(k) ?? 0) + 1);
}
console.log('\n=== CLIP DA CAT (goc hinh co trong clip / trang thai) ===');
for (const [k,n] of [...ang].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
