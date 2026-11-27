-- 0062: 待機中ルームのゴースト掃除（2026-11-27 おぎ報告）
-- 退室ボタンを押さずにアプリを閉じると room_members の行が残り続け、
-- ホストが幽霊のままルームが永遠に残っていた（実績：lobby のまま
-- 110件滞留、検証ルームも同根）。ww_sweep（1分毎）に待機室の見回りを足す。
-- 判定は対戦中の離脱判定と同じ心拍（ww_heartbeat）を使い、待機室は
-- ゆるめの5分で退出扱いにする。通常の退室（ww_leave_room）と同じ意味論：
-- ホストが抜けたら最古参メンバーへ移譲、誰も残らなければ closed。
create or replace function public.ww__cleanup_lobby_rooms()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  r public.rooms%rowtype;
  new_host uuid;
  n integer := 0;
begin
  delete from public.room_members m
   using public.rooms rm
   where m.room_id = rm.id and rm.status = 'lobby'
     and coalesce(m.last_heartbeat_at, m.joined_at) < now() - interval '5 minutes';

  for r in select * from public.rooms where status = 'lobby' loop
    if not exists (select 1 from public.room_members m where m.room_id = r.id) then
      update public.rooms set status = 'closed' where id = r.id;
      n := n + 1;
    elsif not exists (
      select 1 from public.room_members m
       where m.room_id = r.id and m.user_id = r.host_id
    ) then
      select user_id into new_host
        from public.room_members
       where room_id = r.id
       order by joined_at
       limit 1;
      update public.rooms set host_id = new_host where id = r.id;
      perform public.ww__refresh_all_ready(r.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

revoke all on function public.ww__cleanup_lobby_rooms() from public, anon, authenticated;

create or replace function public.ww_sweep()
returns integer
language plpgsql security definer set search_path = 'public'
as $function$
declare
  game public.ww_games%rowtype;
  n integer := 0;
begin
  perform public.ww__detect_abandons();
  perform public.ww__cleanup_lobby_rooms();
  for game in
    select * from public.ww_games
     where phase <> 'done' and phase_deadline_at is not null
       and phase_deadline_at <= now()
     order by phase_deadline_at
     for update skip locked
  loop
    perform public.ww__advance_expired(game);
    n := n + 1;
  end loop;
  return n;
end;
$function$;
