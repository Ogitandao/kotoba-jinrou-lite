-- 0064: 公開ルームの自動解散（2026-11-28 おぎ決定「B」）
-- 公開ルームは試合用。待機状態（lobby）のまま30分経った公開ルームは
-- 自動で解散する（雑談部屋としての居座りを防ぐ。本家と同じ考え方）。
-- 時計は「待機状態に入った時刻」から測り、試合が始まれば止まり、
-- 試合が終わって待機室に戻ればそこから30分を数え直す。
-- 非公開ルームは対象外（身内の自由な空間）。
alter table public.rooms
  add column if not exists lobby_since_at timestamptz;

update public.rooms
   set lobby_since_at = created_at
 where status = 'lobby' and lobby_since_at is null;

-- 待機状態に入った瞬間を記録する（作成・試合終了後の復帰の両方を拾う）
create or replace function public.ww__rooms_lobby_since()
returns trigger
language plpgsql
as $function$
begin
  if new.status = 'lobby'
     and (tg_op = 'INSERT' or old.status is distinct from 'lobby') then
    new.lobby_since_at := now();
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_rooms_lobby_since on public.rooms;
create trigger trg_rooms_lobby_since
  before insert or update of status on public.rooms
  for each row execute function public.ww__rooms_lobby_since();

-- ゴースト掃除に自動解散を追加（ww_sweep から毎分呼ばれる）
create or replace function public.ww__cleanup_lobby_rooms()
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  r public.rooms%rowtype;
  new_host uuid;
  n integer := 0;
begin
  -- 自動解散：待機30分を超えた公開ルームは、メンバーごと消滅させる
  delete from public.room_members m
   using public.rooms rm
   where m.room_id = rm.id and rm.status = 'lobby' and rm.is_private = false
     and rm.lobby_since_at is not null
     and rm.lobby_since_at < now() - interval '30 minutes';
  update public.rooms set status = 'closed'
   where status = 'lobby' and is_private = false
     and lobby_since_at is not null
     and lobby_since_at < now() - interval '30 minutes';

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
$function$;
