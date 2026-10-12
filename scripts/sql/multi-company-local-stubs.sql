-- =============================================================================
-- LOKÁLNE (PGlite) minimálne stuby produkčných tabuliek, ktoré
-- scripts/sql/entitlements-local-baseline.sql nemá, ale funkcie z
-- 20261012140000_multi_company_workspaces.sql (zrušenie firmy, chat, AI kvóta,
-- autor záznamov) ich používajú. Iba stĺpce, ktoré funkcie čítajú/mažú.
-- ON DELETE pravidlá voči companies zrkadlia produkciu (read-only audit 2026-10-12).
-- NIKDY sa nespúšťa proti produkcii ani stagingu.
-- =============================================================================
create table if not exists public.user_legal_acceptances (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  document_type text, version text, accepted_at timestamptz not null default now());
create table if not exists public.ai_scan_usage (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid, endpoint text, created_at timestamptz not null default now());
create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  type text not null, created_by uuid, direct_user_low uuid, direct_user_high uuid, name text,
  created_at timestamptz not null default now());
create unique index if not exists chat_conversations_direct_unique on public.chat_conversations (company_id, direct_user_low, direct_user_high) where type = 'direct';
create table if not exists public.chat_conversation_members (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  company_id uuid not null references public.companies(id), user_id uuid not null,
  primary key (conversation_id, user_id));
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null, body text, created_at timestamptz not null default now());
create table if not exists public.chat_attachments (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.chat_message_references (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.document_attachments (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  document_id uuid, user_id uuid, storage_bucket text, storage_path text);
create table if not exists public.document_links (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.document_review_log (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.inventory_photos (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), user_id uuid, file_path text);
create table if not exists public.machine_photos (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), user_id uuid, file_path text);
create table if not exists public.vehicle_photos (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id), user_id uuid, storage_path text);
create table if not exists public.machine_services (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.vehicle_services (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.vehicle_vignettes (id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id));
create table if not exists public.invoice_payments (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  recorded_by uuid references auth.users(id));
create table if not exists public.invoice_events (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  actor_user_id uuid references auth.users(id));
alter table public.company_billing_profile add column if not exists logo_path text;
-- 20261012150000: IČO / krajina v billing profile (prod stĺpce z 20260916120000)
-- a auth.sessions (session_active_company → FK on delete cascade ako v prod).
alter table public.company_billing_profile add column if not exists ico text;
alter table public.company_billing_profile add column if not exists country_code text;
create table if not exists auth.sessions (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now());
