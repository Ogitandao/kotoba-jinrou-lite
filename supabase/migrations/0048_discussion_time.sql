-- 0048: 話し合い時間の調整（2026-11-26 おぎ決定）
-- 4〜6人=300秒は据え置き、7〜8人を480秒→360秒（6分）に短縮する。
-- ww__new_game の現行定義（0016）から discussion_seconds の分岐だけを変更。

CREATE OR REPLACE FUNCTION public.ww__new_game(p_set ww_sets, p_index integer)
 RETURNS ww_games
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  INTRO_SECONDS constant integer := 15; -- 挨拶タイムの長さ（変更はここ）
  topic public.ww_topics%rowtype;
  room_genre text;
  picked_category text;
  wolf_count integer;
  wolf_ids uuid[];
  game public.ww_games%rowtype;
  pid uuid;
begin
  select genre into room_genre from public.rooms where id = p_set.room_id;
  if room_genre is not null then
    picked_category := room_genre;
  else
    select category into picked_category
      from (select distinct category from public.ww_topics
             where active and category is not null) c
     order by random() limit 1;
  end if;
  select * into topic from public.ww_topics
   where active and category is not distinct from picked_category
   order by random() limit 1;
  -- 万一カテゴリで引けなかった場合の保険（全件から抽選）
  if topic.id is null then
    select * into topic from public.ww_topics where active order by random() limit 1;
  end if;
  wolf_count := case when array_length(p_set.player_ids, 1) >= 8 then 2 else 1 end;
  select array_agg(x) into wolf_ids
    from (select unnest(p_set.player_ids) as x order by random() limit wolf_count) s;

  insert into public.ww_games (set_id, room_id, game_index, phase,
                               phase_deadline_at, discussion_seconds)
  values (p_set.id, p_set.room_id, p_index, 'intro',
          now() + make_interval(secs => INTRO_SECONDS),
          case when array_length(p_set.player_ids, 1) <= 6 then 300 else 360 end)
  returning * into game;

  insert into public.ww_game_secrets (game_id, citizen_topic, wolf_topic, category, wolf_ids)
  values (game.id, topic.citizen, topic.wolf, topic.category, wolf_ids);

  foreach pid in array p_set.player_ids loop
    insert into public.ww_player_topics (game_id, player_id, topic)
    values (game.id, pid,
            case when pid = any(wolf_ids) then topic.wolf else topic.citizen end);
  end loop;
  return game;
end;
$function$;
