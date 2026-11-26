-- 0057: ティッカーを「貯めない・その場限り」に変更（2026-11-26 おぎ）
-- 従来は kl_ticker_events に貯めてロビー表示時に読み直していたが、
-- おぎの仕様変更：固定3件＋運営告知は常時ループ、「誰かが何をした」
-- 系のイベントは発生した瞬間にロビーにいる人へ1回だけ流す。
-- そのため kl_send_gift / ww__finish のフックを、テーブルへの記録から
-- Realtime Broadcast（realtime.send、topic 'kl-ticker'）へ差し替える。
-- kl_ticker_events テーブルと kl_ticker_feed は当面残すが未使用。

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
    perform realtime.send(jsonb_build_object('text',
      '🎁 ' || v_sender_name || 'さんが' || v_receiver_name || 'さんに『'
      || g.name || '』をプレゼントしました！'), 'event', 'kl-ticker', false);
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

CREATE OR REPLACE FUNCTION public.ww__finish(p_game ww_games, p_winner text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sec public.ww_game_secrets%rowtype;
  ids uuid[];
  pid uuid;
  is_wolf boolean;
  won boolean;
  v_wins integer;
  v_name text;
begin
  select * into sec from public.ww_game_secrets where game_id = p_game.id;
  select player_ids into ids from public.ww_sets where id = p_game.set_id;

  update public.ww_games
     set winner = p_winner, win_reason = p_reason, exiled_id = coalesce(exiled_id, p_game.exiled_id)
   where id = p_game.id;

  foreach pid in array ids loop
    is_wolf := pid = any (sec.wolf_ids);
    won := case when p_winner = 'wolves' then is_wolf else not is_wolf end;
    insert into public.ww_results (set_id, game_id, game_index, user_id, won, winner, reason)
    values (p_game.set_id, p_game.id, p_game.game_index, pid, won, p_winner, p_reason)
    on conflict (game_id, user_id) do nothing;
    if won then
      update public.profiles
         set wordwolf_wins = wordwolf_wins + 1
       where id = pid
       returning wordwolf_wins, display_name into v_wins, v_name;
      -- 100の倍数に届いたら全体ティッカーで祝う
      if v_wins is not null and v_wins % 100 = 0 then
        perform realtime.send(jsonb_build_object('text',
          '🎉 ' || v_name || 'さんが' || v_wins || '勝を達成しました！'), 'event', 'kl-ticker', false);
      end if;
    end if;
  end loop;

  perform public.ww__set_phase(p_game.id, 'result', now() + interval '15 seconds');
end;
$function$;
