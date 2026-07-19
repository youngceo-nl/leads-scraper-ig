# email-outbound

## Supabase access

The Supabase JS client (service role key in `.env.local`) supports data queries (SELECT, INSERT, UPDATE, DELETE) but **cannot run DDL** (ALTER TABLE, CREATE TABLE).

For schema migrations:
- `npx supabase` is available in this repo
- To push migrations: `npx supabase login` → `npx supabase link --project-ref mxngjwyfomahzswcgkwu` → `npx supabase db push`
- Until linked, the user must run migration SQL manually via the Supabase dashboard SQL editor
- Migration files live in `supabase/migrations/`

Data queries work fine — use `createClient` from `@/lib/supabase/admin` with a `.mts` script in the project root and `npx tsx <script>`, then delete the script after.
