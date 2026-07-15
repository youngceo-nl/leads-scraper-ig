import { createAdminClient } from "@/lib/supabase/admin";
const admin = createAdminClient();
const { data } = await admin.from("crawl_jobs").select("status, profiles_scraped, qualified_count, rejected_count, new_leads, error_message, finished_at").eq("id", process.argv[2]).single();
console.log(JSON.stringify(data));
