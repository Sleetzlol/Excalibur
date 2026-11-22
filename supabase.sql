-- Run this once in Supabase: SQL Editor > New query > paste > Run. It is safe to run again.
-- The server keeps all accounts in a single row of this table.
create table if not exists public.kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Only your server should touch this table. Row level security with no policies blocks the public
-- (anon / publishable) key completely; the server's secret key bypasses it.
alter table public.kv enable row level security;

-- Make sure the server's role is allowed to use the table (newer Supabase projects do not always do this for you).
grant usage on schema public to service_role;
grant all on table public.kv to service_role;
