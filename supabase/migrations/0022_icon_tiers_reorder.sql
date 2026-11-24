-- 0022: アイコン並び替え＋一部を勝利数解放へ（2026-11-25 おぎ）
-- - 並び：人間（6）を先頭、続いて動物（無料11）、最後に勝利数解放（3）
-- - こあら・あざらし・きつねは無料から勝利数解放へ移行（こあら5勝／あざらし10勝／きつね20勝）
-- - 既にそのアイコンを選択中のユーザーは所有済みとして付与（取り上げない）
-- - kl_set_icon：win ティアは勝利数が条件に達していれば自動で所有付与して選択可にする

update public.icons set sort = case key
  when 'man1' then 1 when 'man2' then 2 when 'man3' then 3
  when 'woman1' then 4 when 'woman2' then 5 when 'woman3' then 6
  when 'wolf' then 7 when 'dog' then 8 when 'cat' then 9
  when 'rabbit' then 10 when 'bear' then 11 when 'panda' then 12
  when 'penguin' then 13 when 'owl' then 14 when 'tanuki' then 15
  when 'chick' then 16 when 'frog' then 17 when 'tiger' then 18
  when 'koala' then 19 when 'seal' then 20 when 'fox' then 21
  else sort end;

update public.icons set tier = 'win', win_threshold = 5  where key = 'koala';
update public.icons set tier = 'win', win_threshold = 10 where key = 'seal';
update public.icons set tier = 'win', win_threshold = 20 where key = 'fox';

insert into public.user_icons (user_id, icon_key)
select id, icon_key from public.profiles
 where icon_key in ('koala', 'seal', 'fox')
on conflict do nothing;

create or replace function public.kl_set_icon(p_icon_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  cat public.icons%rowtype;
  my_wins integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into cat from public.icons
   where key = p_icon_key and active;
  if not found then
    raise exception 'ICON_NOT_FOUND: そのアイコンは存在しません' using errcode = 'P0001';
  end if;
  if cat.tier = 'win' then
    select wordwolf_wins into my_wins from public.profiles where id = me;
    if coalesce(my_wins, 0) >= coalesce(cat.win_threshold, 0) then
      insert into public.user_icons (user_id, icon_key) values (me, cat.key)
      on conflict do nothing;
    end if;
  end if;
  if cat.tier <> 'free'
     and not exists (select 1 from public.user_icons ui
                      where ui.user_id = me and ui.icon_key = cat.key) then
    raise exception 'ICON_NOT_OWNED: そのアイコンはまだ持っていません' using errcode = 'P0001';
  end if;
  update public.profiles set icon_key = cat.key where id = me;
  return jsonb_build_object('iconKey', cat.key);
end;
$$;

revoke all on function public.kl_set_icon(text) from public, anon;
grant execute on function public.kl_set_icon(text) to authenticated;
