-- 0050: 年齢確認（生年月日登録）が済むまで、遊び・交流・コイン系の
-- RPC をサーバー側で全面拒否する（2026-11-26 おぎ実機で発見：
-- 初回セットアップのモーダルを閉じると生年月日未登録のまま遊べた）。
-- クライアントのモーダルは表示側の門番にすぎず、正本のガードはここ。
-- 対象外：退室・退出・ブロック・通報・申立て等の「安全に離れる」操作と、
-- セットアップ自体（kl_set_birthdate / kl_update_profile）、閲覧系。
create or replace function public.kl__require_birthdate()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  v_birth date;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select birthdate into v_birth from public.profiles where id = me;
  if v_birth is null then
    raise exception 'BIRTHDATE_REQUIRED: 年齢確認が完了していません' using errcode = 'P0001';
  end if;
end;
$function$;


CREATE OR REPLACE FUNCTION public.ww_create_room(p_title text, p_is_private boolean DEFAULT false, p_password text DEFAULT NULL::text, p_beginner_welcome boolean DEFAULT false, p_reversal_enabled boolean DEFAULT true, p_capacity integer DEFAULT 8, p_genre text DEFAULT NULL::text)
 RETURNS rooms
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  spent record;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
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
$function$;

CREATE OR REPLACE FUNCTION public.ww_join_room(p_room uuid, p_password text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
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
$function$;

CREATE OR REPLACE FUNCTION public.ww_set_ready(p_room uuid, p_ready boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  update public.room_members set ready = p_ready
   where room_id = p_room and user_id = me;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
  end if;
  perform public.ww__refresh_all_ready(p_room);
end;
$function$;

CREATE OR REPLACE FUNCTION public.ww_start_game(p_room uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  select * into room from public.rooms where id = p_room;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.host_id <> me then
    raise exception 'NOT_HOST: 開始できるのはルームマスターだけです' using errcode = 'P0001';
  end if;
  return public.ww__start_game_now(p_room);
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
  perform public.kl__require_birthdate();
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
  perform public.kl__require_birthdate();
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

CREATE OR REPLACE FUNCTION public.ww_cast_vote(p_game uuid, p_target uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  player_count integer;
begin
  perform public.kl__require_birthdate();
  select * into game from public.ww_games where id = p_game for update;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  select array_length(s.player_ids, 1) into player_count
    from public.ww_sets s where s.id = game.set_id;
  if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and me = any (s.player_ids))) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['voting']);
  if exists (select 1 from public.ww_votes
              where game_id = p_game and vote_round = game.vote_round and voter_id = me) then
    raise exception 'ALREADY_SUBMITTED: すでに投票済みです' using errcode = 'P0001';
  end if;
  if p_target is not null then
    if not (exists (select 1 from public.ww_sets s where s.id = game.set_id and p_target = any (s.player_ids))) then
      raise exception 'UNKNOWN_PLAYER: 投票先が存在しません' using errcode = 'P0001';
    end if;
    if p_target = me then
      raise exception 'INVALID_TARGET: 自分には投票できません' using errcode = 'P0001';
    end if;
  end if;
  insert into public.ww_votes (game_id, vote_round, voter_id, target_id)
  values (p_game, game.vote_round, me, p_target);
  update public.ww_games set votes_cast = votes_cast + 1
   where id = p_game returning * into game;
  -- 全員投票が揃ったら締め切りを待たずに早期解決する
  if game.votes_cast >= player_count then
    perform public.ww__resolve_vote(game);
  end if;
  return jsonb_build_object('ok', true, 'votesCast', game.votes_cast);
end;
$function$;

CREATE OR REPLACE FUNCTION public.ww_submit_reversal(p_game uuid, p_choice text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  sec public.ww_game_secrets%rowtype;
  correct boolean;
begin
  perform public.kl__require_birthdate();
  select * into game from public.ww_games where id = p_game for update;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  perform public.ww__require_window(game, array['reversal']);
  if me <> game.exiled_id then
    raise exception 'NOT_EXILED_WOLF: 逆転回答ができるのは追放されたウルフだけです' using errcode = 'P0001';
  end if;
  if not (p_choice = any (coalesce(game.reversal_choices, array[]::text[]))) then
    raise exception 'INVALID_CHOICE: 候補の中から選んでください' using errcode = 'P0001';
  end if;
  select * into sec from public.ww_game_secrets where game_id = p_game;
  correct := (p_choice = sec.citizen_topic);
  update public.ww_games
     set reversal_outcome = jsonb_build_object(
           'attempted', true, 'correct', correct, 'timedOut', false)
   where id = p_game;
  perform public.ww__finish(game, case when correct then 'wolves' else 'citizens' end, 'reversal');
  return jsonb_build_object('correct', correct);
end;
$function$;

CREATE OR REPLACE FUNCTION public.ww_kick_member(p_room uuid, p_target uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  select * into room from public.rooms where id = p_room for update;
  if not found then
    raise exception 'ROOM_NOT_FOUND: ルームが存在しません' using errcode = 'P0001';
  end if;
  if room.host_id <> me then
    raise exception 'NOT_HOST: キックできるのはルームマスターだけです' using errcode = 'P0001';
  end if;
  if room.status <> 'lobby' then
    raise exception 'ROOM_BUSY: キックは待機室でのみできます' using errcode = 'P0001';
  end if;
  if p_target = room.host_id then
    raise exception 'INVALID_TARGET: マスターはキックできません' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.ww_sets s
     where s.room_id = p_room and s.status = 'finished'
       and s.finished_at > now() - interval '20 seconds'
       and p_target = any (s.player_ids)
  ) then
    raise exception 'IN_RESULT: 結果確認中のメンバーはキックできません' using errcode = 'P0001';
  end if;
  delete from public.room_members
   where room_id = p_room and user_id = p_target;
  if not found then
    raise exception 'NOT_A_MEMBER: 対象はこのルームのメンバーではありません' using errcode = 'P0001';
  end if;
  perform public.ww__refresh_all_ready(p_room);
end;
$function$;

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
  perform public.kl__require_birthdate();
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
  perform public.kl__require_birthdate();
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

CREATE OR REPLACE FUNCTION public.kl_create_group(p_name text, p_member_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  ids uuid[] := '{}';
  candidate uuid;
  g public.kl_groups%rowtype;
  v_name text := trim(coalesce(p_name, ''));
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  -- 重複と自分自身を除く（入力順は保つ）
  foreach candidate in array coalesce(p_member_ids, '{}')
  loop
    if candidate <> me and not (candidate = any (ids)) then
      ids := ids || candidate;
    end if;
  end loop;
  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'GROUP_NO_MEMBERS: メンバーを1人以上選んでください' using errcode = 'P0001';
  end if;
  if array_length(ids, 1) + 1 > 50 then
    raise exception 'GROUP_FULL: グループは50人までです' using errcode = 'P0001';
  end if;
  foreach candidate in array ids
  loop
    perform public.kl_require_user(candidate);
    if public.kl_blocked_either(me, candidate) then
      raise exception 'BLOCKED: ブロック関係のユーザーは追加できません' using errcode = 'P0001';
    end if;
    if not public.kl_are_friends(me, candidate) then
      raise exception 'NOT_FRIENDS: 追加できるのはフレンドだけです' using errcode = 'P0001';
    end if;
  end loop;
  if length(v_name) > 20 then
    raise exception 'GROUP_NAME_TOO_LONG: グループ名は20文字までです' using errcode = 'P0001';
  end if;
  if v_name = '' then
    -- 自動名：自分＋メンバーの表示名を「、」でつなぐ（Sim と同じ）
    select string_agg(x.display_name, '、' order by x.ord) into v_name
    from (
      select p.display_name, 0 as ord
      from public.profiles p where p.id = me
      union all
      select p.display_name, array_position(ids, p.id)
      from public.profiles p where p.id = any (ids)
    ) x;
  end if;
  insert into public.kl_groups (name, created_by) values (v_name, me)
  returning * into g;
  insert into public.kl_group_members (group_id, user_id, last_read_at)
  values (g.id, me, now());
  insert into public.kl_group_members (group_id, user_id)
  select g.id, unnest(ids);
  perform public.kl__group_system_msg(g.id, 'グループが作成されました');
  return public.kl__group_view(g.id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_add_group_members(p_group uuid, p_member_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  candidate uuid;
  added uuid[] := '{}';
  current_count integer;
  added_names text;
begin
  perform public.kl__require_birthdate();
  perform public.kl__require_group_member(p_group);
  foreach candidate in array coalesce(p_member_ids, '{}')
  loop
    if candidate = me then continue; end if;
    if exists (
      select 1 from public.kl_group_members
      where group_id = p_group and user_id = candidate
    ) then continue; end if;
    perform public.kl_require_user(candidate);
    if public.kl_blocked_either(me, candidate) then
      raise exception 'BLOCKED: ブロック関係のユーザーは追加できません' using errcode = 'P0001';
    end if;
    if not public.kl_are_friends(me, candidate) then
      raise exception 'NOT_FRIENDS: 追加できるのはフレンドだけです' using errcode = 'P0001';
    end if;
    added := added || candidate;
  end loop;
  if coalesce(array_length(added, 1), 0) > 0 then
    select count(*) into current_count
    from public.kl_group_members where group_id = p_group;
    if current_count + array_length(added, 1) > 50 then
      raise exception 'GROUP_FULL: グループは50人までです' using errcode = 'P0001';
    end if;
    insert into public.kl_group_members (group_id, user_id)
    select p_group, unnest(added);
    select string_agg(p.display_name, '、') into added_names
    from public.profiles p where p.id = any (added);
    perform public.kl__group_system_msg(
      p_group, coalesce(added_names, '') || 'さんが参加しました');
  end if;
  return public.kl__group_view(p_group);
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_send_gift(p_to uuid, p_gift_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  g public.gift_catalog%rowtype;
  spent record;
  hist_id uuid;
  w public.coin_wallets%rowtype;
  new_popularity integer;
  v_max_price integer;
  v_sender_name text;
  v_receiver_name text;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  if p_to = me then
    raise exception 'SELF_ACTION: 自分には送れません' using errcode = 'P0001';
  end if;
  perform public.kl_require_user(p_to);
  if public.kl_blocked_either(me, p_to) then
    raise exception 'BLOCKED: このユーザーには送れません' using errcode = 'P0001';
  end if;
  select * into g from public.gift_catalog where key = p_gift_key and active;
  if not found then
    raise exception 'GIFT_NOT_FOUND: ギフトが存在しません' using errcode = 'P0001';
  end if;

  select * into spent from public.kl_spend_coins(me, g.price);

  insert into public.gift_history (sender_id, receiver_id, gift_key, price)
  values (me, p_to, g.key, g.price)
  returning id into hist_id;

  insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
  values (me, -spent.spent_free, -spent.spent_paid, 'gift_sent', hist_id);

  update public.profiles
     set popularity = popularity + g.price
   where id = p_to
   returning popularity into new_popularity;

  insert into public.dm_messages (sender_id, recipient_id, kind, gift_payload)
  values (me, p_to, 'gift', jsonb_build_object(
    'historyId', hist_id, 'giftKey', g.key,
    'name', g.name, 'icon', g.icon, 'price', g.price
  ));

  -- カタログ最高額のギフトは全体ティッカーで流す（TikTok式のギフト告知）
  select max(price) into v_max_price from public.gift_catalog where active;
  if g.price >= v_max_price then
    select display_name into v_sender_name from public.profiles where id = me;
    select display_name into v_receiver_name from public.profiles where id = p_to;
    perform public.kl__ticker_post('top_gift',
      '🎁 ' || v_sender_name || 'さんが' || v_receiver_name || 'さんに『'
      || g.name || '』をプレゼントしました！');
  end if;

  select * into w from public.coin_wallets where user_id = me;
  return jsonb_build_object(
    'historyId', hist_id,
    'price', g.price,
    'freeBalance', w.free_balance,
    'paidBalance', w.paid_balance,
    'receiverPopularity', new_popularity
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_claim_login_bonus()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  today_jst date := (now() at time zone 'Asia/Tokyo')::date;
  w public.coin_wallets%rowtype;
  amounts int[] := array[50, 50, 50, 50, 100, 100, 100];
  daily int := 0;
  s_days int := 0;
  s_last date := null;
  s_grant int := 0;
  s_day int := null;
  eligible boolean := false;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  select * into w from public.coin_wallets where user_id = me for update;
  if not found then
    raise exception 'USER_NOT_FOUND: 財布が存在しません' using errcode = 'P0001';
  end if;

  if w.last_login_bonus_date is distinct from today_jst then
    daily := 10;
  end if;

  select days_claimed, last_claim_date into s_days, s_last
    from public.kl_starter_bonus where user_id = me;
  select exists (
    select 1 from public.profiles p
     where p.id = me
       and p.created_at >= '2026-11-26T00:00:00+09'::timestamptz
  ) into eligible;
  if eligible and coalesce(s_days, 0) < 7 and s_last is distinct from today_jst then
    s_day := coalesce(s_days, 0) + 1;
    s_grant := amounts[s_day];
  end if;

  if daily = 0 and s_grant = 0 then
    return jsonb_build_object('claimed', false, 'amount', 0,
      'starterAmount', 0, 'starterDay', null,
      'starterDaysClaimed', coalesce(s_days, 0),
      'freeBalance', w.free_balance, 'paidBalance', w.paid_balance);
  end if;

  update public.coin_wallets
     set free_balance = free_balance + daily + s_grant,
         last_login_bonus_date = case
           when daily > 0 then today_jst else last_login_bonus_date end
   where user_id = me
   returning * into w;
  if daily > 0 then
    insert into public.coin_ledger (user_id, delta_free, reason)
    values (me, daily, 'daily_login');
  end if;
  if s_grant > 0 then
    insert into public.coin_ledger (user_id, delta_free, reason)
    values (me, s_grant, 'starter_login');
    insert into public.kl_starter_bonus (user_id, days_claimed, last_claim_date, updated_at)
    values (me, s_day, today_jst, now())
    on conflict (user_id) do update
      set days_claimed = excluded.days_claimed,
          last_claim_date = excluded.last_claim_date,
          updated_at = now();
  end if;

  return jsonb_build_object('claimed', true, 'amount', daily,
    'starterAmount', s_grant, 'starterDay', s_day,
    'starterDaysClaimed', coalesce(s_day, s_days),
    'freeBalance', w.free_balance, 'paidBalance', w.paid_balance);
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_send_friend_request(p_to uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  pair uuid[];
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  if p_to = me then
    raise exception 'SELF_ACTION: 自分には申請できません' using errcode = 'P0001';
  end if;
  perform public.kl_require_user(p_to);
  if public.kl_blocked_either(me, p_to) then
    raise exception 'BLOCKED: このユーザーとは申請できません' using errcode = 'P0001';
  end if;
  if public.kl_are_friends(me, p_to) then
    raise exception 'ALREADY_FRIENDS: すでにフレンドです' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.friend_requests
              where from_id = me and to_id = p_to) then
    raise exception 'ALREADY_REQUESTED: すでに申請中です' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.friend_requests
              where from_id = p_to and to_id = me) then
    delete from public.friend_requests where from_id = p_to and to_id = me;
    pair := public.kl_pair(me, p_to);
    insert into public.friendships (user_a, user_b) values (pair[1], pair[2]);
    return 'accepted';
  end if;
  insert into public.friend_requests (from_id, to_id) values (me, p_to);
  return 'requested';
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_respond_friend_request(p_from uuid, p_accept boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  me uuid := auth.uid();
  pair uuid[];
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
  if not exists (select 1 from public.friend_requests
                  where from_id = p_from and to_id = me) then
    raise exception 'REQUEST_NOT_FOUND: 申請が存在しません' using errcode = 'P0001';
  end if;
  delete from public.friend_requests where from_id = p_from and to_id = me;
  if p_accept then
    pair := public.kl_pair(me, p_from);
    insert into public.friendships (user_a, user_b) values (pair[1], pair[2])
    on conflict do nothing;
    return 'accepted';
  end if;
  return 'rejected';
end;
$function$;

CREATE OR REPLACE FUNCTION public.kl_send_invite(p_to uuid, p_room uuid, p_password text DEFAULT NULL::text)
 RETURNS dm_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
  msg public.dm_messages%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  perform public.kl__require_birthdate();
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
$function$;
