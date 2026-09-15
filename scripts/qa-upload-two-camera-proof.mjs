import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

function parseEnv(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const env = parseEnv(await readFile(new URL("../.env.local", import.meta.url), "utf8"));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase admin environment is incomplete");

const file = await readFile(
  new URL(
    "../.tmp/qa-recordings/_clips/7c6397de-fa86-4fb9-9cd5-d61ea252acc7.pip-qa.mp4",
    import.meta.url,
  ),
);
const objectPath =
  "00000000-0000-0000-0000-000000000001/7c6397de-fa86-4fb9-9cd5-d61ea252acc7/0c82d0a2-d9af-41cf-95e0-cf94d546e77a.mp4";
const admin = createClient(url, key, { auth: { persistSession: false } });
const { error } = await admin.storage
  .from("proof-clips-transient")
  .upload(objectPath, file, { contentType: "video/mp4", upsert: true });
if (error) throw error;
console.log(JSON.stringify({ ok: true, objectPath, bytes: file.byteLength }));
