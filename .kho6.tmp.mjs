import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id').ilike('name','%Đại Kim%').single();
const { data: one } = await db.from('order_proof_clips').select('*').eq('organization_id', org.id).limit(1);
console.log('COT order_proof_clips: ' + Object.keys(one?.[0] ?? {}).join(', '));
const { data: recent } = await db.from('order_proof_clips').select('*').eq('organization_id', org.id).order('created_at',{ascending:false}).limit(12);
console.log('\n=== 12 CLIP GAN NHAT ===');
for (const c of recent ?? []) {
  console.log(`${(c.created_at ?? '').slice(0,19)}  ${String(c.status).padEnd(10)} bat_dau=${(c.clip_started_at ?? '').slice(0,19)}  loi=${String(c.fail_reason ?? c.error ?? '').slice(0,80)}`);
}
