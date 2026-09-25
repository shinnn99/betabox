import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: orgs } = await db.from('organizations').select('id, name, retention_days, return_retention_days').order('name');
console.log('=== TO CHUC ===');
for (const o of orgs ?? []) console.log(`${(o.name ?? '').padEnd(22)} han chung=${o.retention_days ?? 'CHUA DAT'} ngay | han hoan=${o.return_retention_days ?? 'chua dat (=7)'}`);

const { data: agents } = await db.from('warehouse_agents').select('id, code, organization_id, status, last_seen_at, version').order('code');
console.log('\n=== MAY KHO ===');
for (const a of agents ?? []) {
  const o = (orgs ?? []).find(x => x.id === a.organization_id);
  console.log(`${a.code.padEnd(20)} ${(o?.name ?? '').padEnd(20)} ban=${a.version ?? '?'} lan cuoi=${a.last_seen_at ?? 'chua bao gio'}`);
}
