-- =============================================================================
-- Push notifikácie v telefóne (aj keď je Esblu zatvorené) — Web Push / PWA.
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration (supabase/MIGRATIONS.md). NIKDY db push.
-- Kým nie je aplikované (a nie sú nastavené VAPID kľúče), appka push iba
-- neponúkne — nič iné sa nemení.
--
-- ČO VZNIKÁ
-- ---------
-- 1. push_subscriptions      zariadenia používateľa (endpoint + kľúče
--                            prehliadača), viazané na používateľa A firmu.
-- 2. notification_preferences ktoré upozornenia chce (chat, termíny), či smie
--                            byť text správy na zamknutej obrazovke, okná dní.
-- 3. notification_deliveries denník odoslaných upozornení (deduplikácia —
--                            ten istý termín ani tá istá správa sa nepošle 2x).
--
-- BEZPEČNOSŤ
-- ----------
-- - ŽIADNA z troch tabuliek nemá priamy prístup pre klienta (anon ani
--   authenticated): RLS zapnuté, žiadne politiky, všetky privilégiá odobraté.
--   Appka ich z prehliadača nečíta ani nezapisuje — registrácia zariadenia
--   ide cez /api/push/subscribe (overený používateľ, firma z AKTÍVNEHO
--   členstva) a odosielanie iba cez server (service role).
-- - Endpoint je unikátny. Server NEPREPÍŠE aktívny endpoint iného
--   používateľa (odmietne bez prezradenia vlastníka); iba zrušený
--   (odhlásenie) alebo vlastný riadok sa smie prevziať.
-- - Žiadne nové SECURITY DEFINER funkcie, žiadne granty pre anon/authenticated.
-- =============================================================================

begin;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_secret text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  revoked_at timestamptz,
  constraint push_subscriptions_endpoint_unique unique (endpoint),
  constraint push_subscriptions_endpoint_https check (endpoint ~ '^https://'),
  constraint push_subscriptions_endpoint_length check (length(endpoint) <= 2048),
  constraint push_subscriptions_keys_shape check (length(p256dh) between 40 and 200 and length(auth_secret) between 10 and 100)
);

create index if not exists push_subscriptions_company_user_idx
  on public.push_subscriptions (company_id, user_id) where revoked_at is null;

-- Iba server (service role). Klient nemá žiadny priamy prístup — ani
-- čítanie: Nastavenia zisťujú stav zariadenia z prehliadača (PushManager).
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to service_role;

create table if not exists public.notification_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  chat_enabled boolean not null default true,
  deadlines_enabled boolean not null default true,
  -- Text správy na zamknutej obrazovke iba po výslovnom zapnutí.
  show_message_preview boolean not null default false,
  -- Koľko dní vopred pripomenúť termín (0 = v deň termínu).
  deadline_days integer[] not null default array[30, 7, 1, 0],
  updated_at timestamptz not null default now(),
  primary key (user_id, company_id),
  -- Prázdny zoznam nemá význam (vypnutie termínov = deadlines_enabled =
  -- false), preto aspoň jeden a najviac šesť dní, každý 0–365.
  constraint notification_preferences_days_range check (
    cardinality(deadline_days) > 0
    and cardinality(deadline_days) <= 6
    and 0 <= all (deadline_days) and 365 >= all (deadline_days)
  )
);

-- Iba server (service role). Predvoľby dnes nemajú UI; keď vznikne, pôjde
-- cez overený serverový endpoint, nie priamy zápis z prehliadača.
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public, anon, authenticated;
grant select, insert, update, delete on public.notification_preferences to service_role;

-- notification_deliveries: denník odoslaných upozornení — slúži VÝHRADNE na
-- deduplikáciu (tá istá správa / ten istý termín v tom istom okne sa nepošle
-- dvakrát). Obsahuje iba používateľa, firmu, druh a kľúč (napr.
-- „chat:<id správy>", „deadline:vehicle_stk:<id>:<dátum>:7") — žiadny obsah.
-- RETENCIA: pred dlhodobou produkčnou prevádzkou treba schváliť a zaviesť
-- čistenie starých riadkov (napr. > 400 dní). Automatické mazanie tu zámerne
-- NIE JE (neschválená deštruktívna úloha).
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('chat', 'deadline')),
  dedupe_key text not null check (length(dedupe_key) between 3 and 200),
  sent_at timestamptz not null default now(),
  constraint notification_deliveries_unique unique (user_id, dedupe_key)
);

create index if not exists notification_deliveries_sent_idx on public.notification_deliveries (sent_at);

-- Iba server (service role). Klient nemá žiadny prístup.
alter table public.notification_deliveries enable row level security;
revoke all on public.notification_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.notification_deliveries to service_role;

commit;
