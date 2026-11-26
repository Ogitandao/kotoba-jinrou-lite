-- 0046: 送信時の重度NGワード・ブロック（enforcement-design §1.3 / U7）
-- kl__ng_check（0034）の heavy ヒットを、投稿系 RPC とプロフィール
-- 更新で送信前に弾く。light は従来どおり通報との複合判定でのみ使う
-- （送信は止めない）。ワードの中身は ng_words テーブル側で管理し、
-- このファイルには載せない。

create or replace function public.kl__assert_not_heavy(p_text text)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if public.kl__ng_check(p_text) = 'heavy' then
    raise exception 'NG_WORD: この内容は送信できません' using errcode = 'P0001';
  end if;
end;
$$;

revoke execute on function public.kl__assert_not_heavy(text) from public, anon, authenticated;


CREATE OR REPLACE FUNCTION public.kl_send_dm(p_to uuid, p_body text)
 RETURNS dm_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  body text := trim(coalesce(p_body, ''));
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
    raise exception 'NOT_FRIENDS: DM はフレンド同士でのみ送れます' using errcode = 'P0001';
  end if;
  if length(body) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(body) > 500 then
    raise exception 'MESSAGE_TOO_LONG: 500文字以内で入力してください' using errcode = 'P0001';
  end if;
  if body ~* 'https?://|www\.' then
    raise exception 'URL_NOT_ALLOWED: DM ではリンクを送れません' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_heavy(body);
  insert into public.dm_messages (sender_id, recipient_id, kind, body)
  values (me, p_to, 'text', body)
  returning * into msg;
  return msg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_send_group_message(p_group uuid, p_body text)
 RETURNS kl_group_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  body text := trim(coalesce(p_body, ''));
  msg public.kl_group_messages%rowtype;
begin
  perform public.kl__require_group_member(p_group);
  if length(body) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(body) > 500 then
    raise exception 'MESSAGE_TOO_LONG: 500文字以内で入力してください' using errcode = 'P0001';
  end if;
  if body ~* 'https?://|www\.' then
    raise exception 'URL_NOT_ALLOWED: リンクは送れません' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_heavy(body);
  insert into public.kl_group_messages (group_id, sender_id, kind, body)
  values (p_group, me, 'text', body)
  returning * into msg;
  return msg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ww_post_room_message(p_room uuid, p_body text)
 RETURNS ww_room_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  msg public.ww_room_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.room_members m
     where m.room_id = p_room and m.user_id = me
  ) then
    raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(p_body) > 200 then
    raise exception 'MESSAGE_TOO_LONG: 文字数上限を超えています' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_heavy(p_body);
  insert into public.ww_room_messages (room_id, sender_id, body)
  values (p_room, me, p_body) returning * into msg;
  return msg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ww_post_message(p_game uuid, p_body text)
 RETURNS ww_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  msg public.ww_messages%rowtype;
begin
  select * into game from public.ww_games where id = p_game;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and me = any (s.player_ids))) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['intro', 'discussion']);
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(p_body) > 200 then
    raise exception 'MESSAGE_TOO_LONG: 文字数上限を超えています' using errcode = 'P0001';
  end if;
  perform public.kl__assert_not_heavy(p_body);
  insert into public.ww_messages (game_id, sender_id, body)
  values (p_game, me, p_body) returning * into msg;
  return msg;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_update_profile(p_bio text DEFAULT NULL::text, p_display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if p_bio is not null then
    perform public.kl__assert_not_heavy(v_bio);
  end if;
  if p_display_name is not null then
    perform public.kl__assert_not_heavy(v_name);
  end if;
  update public.profiles
     set bio = v_bio,
         display_name = v_name,
         name_decided_at = case when p_display_name is not null then now() else name_decided_at end
   where id = me;
  return jsonb_build_object('bio', v_bio, 'displayName', v_name);
end;
$function$;
