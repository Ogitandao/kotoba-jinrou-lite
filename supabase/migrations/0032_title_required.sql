-- 0032: ルーム名を必須にする（2026-11-25 おぎ決定）
-- 空欄での作成は TITLE_REQUIRED で弾く。0031 の ww_create_room に
-- 空チェックを足したもの（それ以外は同一）。

create or replace function public.ww_create_room(
  p_title text, p_is_private boolean default false, p_password text default null,
  p_beginner_welcome boolean default false, p_reversal_enabled boolean default true,
  p_capacity integer default 8, p_genre text default null
)
returns public.rooms
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  spent record;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_penalized(me);
  perform public.kl__assert_rules_agreed(me);
  if char_length(trim(coalesce(p_title, ''))) < 1 then
    raise exception 'TITLE_REQUIRED: ルーム名を入力してください' using errcode = 'P0001';
  end if;
  if char_length(trim(coalesce(p_title, ''))) > 10 then
    raise exception 'TITLE_TOO_LONG: ルーム名は10文字までです' using errcode = 'P0001';
  end if;
  if p_genre is not null and not exists (
    select 1 from public.ww_topics t where t.active and t.category = p_genre
  ) then
    raise exception 'INVALID_GENRE: ジャンルが存在しません' using errcode = 'P0001';
  end if;

  insert into public.rooms (host_id, title, is_private, password_hash,
    beginner_welcome, capacity, reversal_enabled, genre)
  values (me, trim(p_title), p_is_private,
    null,
    p_beginner_welcome, p_capacity, p_reversal_enabled, p_genre)
  returning * into room;

  insert into public.room_members (room_id, user_id) values (room.id, me);

  if p_is_private then
    select * into spent from public.kl_spend_coins(me, 100);
    insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
    values (me, -spent.spent_free, -spent.spent_paid, 'private_room', room.id);
  end if;
  return room;
end;
$$;
