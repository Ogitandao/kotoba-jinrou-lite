-- 0043: 結果確認中（セット終了から20秒）のメンバーはキック不可にする
-- 結果画面の自動帰還が20秒のため、その間はまだ結果を見ている扱い。
-- 先にルームへ戻ったマスターからキックできてしまうと不意打ちになる
-- （2026-11-25 おぎ）。0014 の ww_kick_member にガードを1つ足して置換。

create or replace function public.ww_kick_member(p_room uuid, p_target uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  room public.rooms%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
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
$$;

revoke all on function public.ww_kick_member(uuid, uuid) from public, anon;
grant execute on function public.ww_kick_member(uuid, uuid) to authenticated;
