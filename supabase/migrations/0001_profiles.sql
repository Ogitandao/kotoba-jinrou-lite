-- =============================================================================
-- 0001_profiles.sql — プロフィール（Lite）
-- =============================================================================
-- プレイヤー1人につき1行。id = auth.users.id。
-- Lite はアイコンがプリセット選択制（画像アップロードなし）のため、
-- アイコンは icon_key（プリセット識別子）＋表示用の icon_emoji / icon_bg を持つ。
-- ID 検索用に public_id（公開ID、英大文字＋数字8桁）を持つ。
--
-- RLS 方針：
-- - SELECT：ログイン済み全員が全員分を読める（プロフィールは見せる情報）
-- - INSERT/UPDATE：自分の行のみ。ただし popularity / wordwolf_wins は
--   サーバー側処理（RPC）だけが変えられるよう、トリガでクライアント
--   更新を巻き戻す
-- - DELETE：ポリシーなし＝クライアントからは削除不可
--
-- 新規登録時（auth.users への INSERT）はトリガでプロフィール＋財布を
-- 自動作成し、登録ボーナス100コイン（無料分）を付与する。
--
-- 冪等性：create table if not exists / drop policy if exists 等で
-- 再実行してもエラーにならない形にしてある。
-- =============================================================================

create extension if not exists pgcrypto;

-- updated_at 自動更新（汎用）
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 公開IDの生成（英大文字＋数字、読み間違えやすい文字を除いた8桁）
create or replace function public.generate_public_id()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  i int;
begin
  loop
    candidate := '';
    for i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from public.profiles where public_id = candidate) then
      return candidate;
    end if;
  end loop;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  public_id text not null unique,
  display_name text not null default 'ななし',
  icon_key text not null default 'wolf',
  icon_emoji text not null default '🐺',
  icon_bg text not null default '#eef4ff',
  bio text not null default '' check (length(bio) <= 100),
  popularity integer not null default 0 check (popularity >= 0),
  wordwolf_wins integer not null default 0 check (wordwolf_wins >= 0),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'プレイヤーのプロフィール。id = auth.users.id。public_id が ID 検索のキー。popularity / wordwolf_wins は RPC 経由でのみ増減する。';

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- popularity / wordwolf_wins のクライアント直接変更を巻き戻す。
-- SECURITY DEFINER の RPC 内では current_user が関数所有者（postgres）に
-- なるため、そちらの更新は通る。service_role も許可する。
create or replace function public.profiles_guard_server_fields()
returns trigger
language plpgsql
as $$
begin
  if current_user not in ('postgres', 'service_role') then
    new.popularity := old.popularity;
    new.wordwolf_wins := old.wordwolf_wins;
    new.public_id := old.public_id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_server_fields on public.profiles;
create trigger profiles_guard_server_fields
  before update on public.profiles
  for each row execute function public.profiles_guard_server_fields();

alter table public.profiles enable row level security;

drop policy if exists "profiles: read all (authenticated)" on public.profiles;
create policy "profiles: read all (authenticated)"
  on public.profiles for select to authenticated using (true);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

revoke all on table public.profiles from anon;
grant select, insert, update on table public.profiles to authenticated;

-- 新規登録時の自動セットアップ：プロフィール作成＋財布作成＋登録ボーナス。
-- coin_wallets / coin_ledger は 0003 で作るため、この関数は 0003 側で
-- 定義し直す（ここではプロフィールのみ。0003 の関数が正本）。
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
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
