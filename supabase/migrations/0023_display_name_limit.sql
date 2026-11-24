-- 0023: 表示名は9文字まで（2026-11-25 おぎ）
-- - 既存の超過行（テストユーザーのみ）は9文字に切り詰めてから制約を付ける
-- - 新規登録トリガーでも9文字に切り詰め、空なら「ななし」に倒す
--   （OAuth の長い氏名がそのまま入って登録が失敗するのを防ぐ）

update public.profiles
   set display_name = left(display_name, 9)
 where char_length(display_name) > 9;

alter table public.profiles
  drop constraint if exists profiles_display_name_len;
alter table public.profiles
  add constraint profiles_display_name_len
  check (char_length(display_name) between 1 and 9);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 9);
begin
  if trim(v_name) = '' then
    v_name := 'ななし';
  end if;
  insert into public.profiles (id, public_id, display_name)
  values (
    new.id,
    public.generate_public_id(),
    v_name
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
