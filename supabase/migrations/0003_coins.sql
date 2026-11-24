-- =============================================================================
-- 0003_coins.sql — コイン財布と台帳（Lite）
-- =============================================================================
-- 本家の 0006 と同じ考え方：無料残高と課金残高を分離し、消費は
-- 無料分から先に使う（本家のおぎ決定ルール）。増減はすべて台帳
-- （coin_ledger、append-only）に残し、残高の検算ができるようにする。
-- 書き込みは RPC（0005 の kl_*）経由のみ。クライアントは自分の
-- 財布と台帳を読むだけ。
--
-- あわせて 0001 で定義した handle_new_user を、財布作成＋登録
-- ボーナス100コイン付与まで含む正本に差し替える。
-- =============================================================================

create table if not exists public.coin_wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  free_balance integer not null default 0 check (free_balance >= 0),
  paid_balance integer not null default 0 check (paid_balance >= 0),
  last_login_bonus_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.coin_wallets is
  'コインの財布。無料残高と課金残高を分離。消費は無料分から。書き込みは RPC 経由のみ。';
comment on column public.coin_wallets.last_login_bonus_date is
  'ログインボーナスの最終受取日（JST）。RPC kl_claim_login_bonus が JST 日付と比較して二重受取を防ぐ。';

drop trigger if exists coin_wallets_set_updated_at on public.coin_wallets;
create trigger coin_wallets_set_updated_at
  before update on public.coin_wallets
  for each row execute function public.set_updated_at();

create table if not exists public.coin_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  delta_free integer not null default 0,
  delta_paid integer not null default 0,
  reason text not null check (reason in (
    'welcome', 'daily_login', 'purchase',
    'gift_sent', 'private_room', 'icon_purchase', 'refund'
  )),
  ref_id uuid,
  created_at timestamptz not null default now()
);

comment on table public.coin_ledger is
  'コイン増減の台帳（append-only）。残高検算・二重付与チェックの元データ。書き込みは RPC 経由のみ。';

create index if not exists coin_ledger_user_created_idx
  on public.coin_ledger (user_id, created_at desc);

alter table public.coin_wallets enable row level security;
alter table public.coin_ledger enable row level security;

drop policy if exists "coin_wallets: read own only" on public.coin_wallets;
create policy "coin_wallets: read own only"
  on public.coin_wallets for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "coin_ledger: read own only" on public.coin_ledger;
create policy "coin_ledger: read own only"
  on public.coin_ledger for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.coin_wallets, public.coin_ledger from anon;
grant select on table public.coin_wallets, public.coin_ledger to authenticated;

-- 新規登録時の自動セットアップ（正本）：プロフィール＋財布＋登録ボーナス
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, public_id, display_name)
  values (
    new.id,
    public.generate_public_id(),
    coalesce(new.raw_user_meta_data ->> 'display_name', 'ななし')
  )
  on conflict (id) do nothing;

  insert into public.coin_wallets (user_id, free_balance)
  values (new.id, 100)
  on conflict (user_id) do nothing;

  insert into public.coin_ledger (user_id, delta_free, reason)
  values (new.id, 100, 'welcome');

  return new;
end;
$$;
