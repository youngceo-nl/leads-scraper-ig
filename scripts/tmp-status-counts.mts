import { createAdminClient } from "@/lib/supabase/admin";
const admin = createAdminClient();
const { data } = await admin.from("leads").select("status");
const counts: Record<string, number> = {};
for (const r of data ?? []) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log(JSON.stringify(counts));
