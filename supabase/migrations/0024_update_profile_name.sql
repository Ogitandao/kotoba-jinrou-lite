-- 0024: 表示名の編集＋新規登録後の名前決定ポップアップ（2026-11-25 おぎ）
-- - profiles.name_decided_at：名前を自分で決めた記録。NULL の新規ユーザーには
--   登録後に「名前を決める」ポップアップを出す（クライアント判定）
-- - 登録時に display_name メタデータが来た場合（メール登録の名前欄）は
--   その場で決めたものとして name_decided_at を入れる。OAuth は
--   display_name メタデータを付けないため未決定のまま＝ポップアップ対象
-- - kl_update_profile に p_display_name を追加。名前ルール：1〜9文字、
--   記号のみ不可（本家ルールと統一）。名前を変えたら name_decided_at も更新

alter table public.profiles
  add column if not exists name_decided_at timestamptz;

-- 既存ユーザーは全員「決定済み」扱い（ポップアップは新規登録後だけに出す）
update public.profiles set name_decided_at = created_at
 where name_decided_at is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 9);
  v_decided timestamptz := null;
begin
  if trim(v_name) = '' then
    v_name := 'ななし';
  else
    v_decided := now();
  end if;
  insert into public.profiles (id, public_id, display_name, name_decided_at)
  values (
    new.id,
    public.generate_public_id(),
    v_name,
    v_decided
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

drop function if exists public.kl_update_profile(text);

create or replace function public.kl_update_profile(p_bio text default null, p_display_name text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  v_bio text;
  v_name text;
  cur record;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select bio, display_name into cur from public.profiles where id = me;

  v_bio := cur.bio;
  if p_bio is not null then
    v_bio := coalesce(trim(p_bio), '');
    if char_length(v_bio) > 50 then
      raise exception 'BIO_TOO_LONG: 自己紹介は50文字までです' using errcode = 'P0001';
    end if;
  end if;

  v_name := cur.display_name;
  if p_display_name is not null then
    v_name := trim(p_display_name);
    if v_name = '' then
      raise exception 'NAME_EMPTY: 名前を入力してください' using errcode = 'P0001';
    end if;
    if char_length(v_name) > 9 then
      raise exception 'NAME_TOO_LONG: 名前は9文字までです' using errcode = 'P0001';
    end if;
    if v_name !~ '[ぁ-んァ-ヶ一-龥a-zA-Z0-9]' then
      raise exception 'NAME_SYMBOL_ONLY: 名前には文字や数字を1文字以上入れてください' using errcode = 'P0001';
    end if;
  end if;

  update public.profiles
     set bio = v_bio,
         display_name = v_name,
         name_decided_at = case when p_display_name is not null then now() else name_decided_at end
   where id = me;
  return jsonb_build_object('bio', v_bio, 'displayName', v_name);
end;
$$;

revoke all on function public.kl_update_profile(text, text) from public, anon;
grant execute on function public.kl_update_profile(text, text) to authenticated;
