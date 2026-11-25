-- 0031: 非公開ルームのパスワードを廃止（2026-11-25 おぎ決定）
-- Lite は招待DMからしか非公開ルームに入れない設計のため、パスワードは
-- 「鍵の鍵」でしかなく初心者の負担になる。入室の資格は「招待DMを受け取って
-- いること」自体が担保する（サーバー側で dm_messages の招待を確認する）。
-- 署名は互換のため維持し、p_password は無視する。rooms.password_hash は
-- 今後常に null（カラム自体は残す）。

-- 非公開ルームにはハッシュ必須だった CHECK 制約を外す
alter table public.rooms drop constraint if exists rooms_private_needs_hash;

-- ---------- 作成：パスワード不要・保存しない ----------
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
  values (me, coalesce(nullif(trim(p_title), ''), ''), p_is_private,
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

-- ---------- 参加：非公開は「メンバー or 招待DMあり」のみ ----------
create or replace function public.ww_join_room(
  p_room uuid, p_password text default null
)
returns void
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_penalized(me);
  perform public.kl__assert_rules_agreed(me);
  select * into room from public.rooms where id = p_room;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: このルームには今は入れません' using errcode = 'P0001';
  end if;
  if room.is_private
     and not exists (select 1 from public.room_members
                      where room_id = p_room and user_id = me)
     and not exists (select 1 from public.dm_messages
                      where kind = 'invite' and recipient_id = me
                        and invite_payload ->> 'roomId' = p_room::text) then
    raise exception 'INVITE_REQUIRED: 非公開ルームは招待からのみ入室できます' using errcode = 'P0001';
  end if;
  select count(*) into n from public.room_members where room_id = p_room;
  if n >= room.capacity
     and not exists (select 1 from public.room_members
                      where room_id = p_room and user_id = me) then
    raise exception 'ROOM_FULL: ルームが満員です' using errcode = 'P0001';
  end if;
  insert into public.room_members (room_id, user_id) values (p_room, me)
  on conflict do nothing;
  perform public.ww__refresh_all_ready(p_room);
end;
$$;

-- ---------- 招待：パスワード確認なし・payload にパスワードを含めない ----------
create or replace function public.kl_send_invite(
  p_to uuid, p_room uuid, p_password text default null
)
returns public.dm_messages
language plpgsql security definer set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  msg public.dm_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if p_to = me then
    raise exception 'SELF_ACTION: 自分には送れません' using errcode = 'P0001';
  end if;
  perform public.kl_require_user(p_to);
  if public.kl_blocked_either(me, p_to) then
    raise exception 'BLOCKED: このユーザーには送れません' using errcode = 'P0001';
  end if;
  if not public.kl_are_friends(me, p_to) then
    raise exception 'NOT_FRIENDS: 招待はフレンドにのみ送れます' using errcode = 'P0001';
  end if;
  select * into room from public.rooms where id = p_room;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: このルームには今は招待できません' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.room_members m
                  where m.room_id = room.id and m.user_id = me) then
    raise exception 'NOT_A_MEMBER: 招待できるのはルームのメンバーだけです' using errcode = 'P0001';
  end if;
  insert into public.dm_messages (sender_id, recipient_id, kind, invite_payload)
  values (
    me, p_to, 'invite',
    jsonb_build_object(
      'roomId', room.id,
      'roomTitle', room.title
    )
  )
  returning * into msg;
  return msg;
end;
$$;
