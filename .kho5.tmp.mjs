import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id, name').ilike('name','%Đại Kim%').single();
const { data: one, error: e0 } = await db.from('agent_log_events').select('*').eq('organization_id', org.id).limit(1);
if (e0) { console.log('loi: ' + e0.message); process.exit(0); }
console.log('COT: ' + Object.keys(one?.[0] ?? {}).join(', '));
const { data: rows } = await db.from('agent_log_events').select('*').eq('organization_id', org.id).order('created_at', { ascending: false }).limit(400);
console.log('tong ban ghi doc duoc: ' + (rows?.length ?? 0));
const hits = (rows ?? []).filter(r => JSON.stringify(r).match(/disk.?guard|cleanup|xo[áa]|retention/i));
console.log('\n=== DONG NOI VE DON DEP / DUNG LUONG (' + hits.length + ') ===');
for (const r of hits.slice(0, 18)) {
  const msg = r.message ?? r.line ?? JSON.stringify(r.payload ?? {});
  console.log(`${(r.created_at ?? '').slice(0,19)}  ${(r.level ?? '').padEnd(5)}  ${String(msg).slice(0,150)}`);
}
if (hits.length === 0) {
  console.log('(khong co dong nao) — 5 dong gan nhat bat ky:');
  for (const r of (rows ?? []).slice(0,5)) console.log(`${(r.created_at ?? '').slice(0,19)}  ${String(r.message ?? JSON.stringify(r)).slice(0,130)}`);
}
