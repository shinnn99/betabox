import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>/^[A-Z]/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim()];}));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: org } = await db.from('organizations').select('id, name').ilike('name', '%Đại Kim%').single();
const { data: one } = await db.from('camera_recording_files').select('*').eq('organization_id', org.id).limit(1);
console.log('COT camera_recording_files: ' + Object.keys(one?.[0] ?? {}).join(', '));
