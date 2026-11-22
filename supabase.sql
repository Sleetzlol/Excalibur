-- Run this once in Supabase: SQL Editor > New query > paste > Run.
-- The server keeps all accounts in a single row of this table.
create table if not exists public.kv (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
-- Only your server should touch this table. Turning on row level security with no policies
-- blocks the public (anon) key completely; the server uses the service_role key, which bypasses it.
alter table public.kv enable row level security;
