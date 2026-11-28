-- 0063: マスター放置の新ルール（2026-11-28 おぎ確定）
-- 無料（公開）ルーム：
--   満室＋全員準備OK（＝マスターにスタートボタンが出ている状態）から
--   5分間開始されなければ、マスターをその場で強制キックする。
--   理由（アプリ落ち・電池落ち・眺めて放置）は問わない。
--   抜けた後は最古参メンバーへマスター移譲、誰も残らなければ閉室。
--   エピソードは従来通り記録され、30日で3回の処分階段にも数える。
-- 有料（非公開）ルーム：
--   開始しないことへの記録・ペナルティは付けない（本検出の対象外）。
--   アプリ落ちへの対応はゴースト掃除（0062）が担う。
-- ルームが空になったら、その瞬間に閉じて消滅する（退室・キック系の
-- 経路は同期で閉じ、残りは 0062 の見回りが拾う）。
create or replace function public.kl__detect_stalls()
returns integer
language plpgsql security definer set search_path = public
as $function$
declare
  v_count integer := 0;
  r record;
  v_next_host uuid;
begin
  for r in
    select rm.id as room_id, rm.host_id, rm.all_ready_at, rm.capacity,
           (select count(*) from public.room_members m where m.room_id = rm.id) as members,
           (select m.last_heartbeat_at from public.room_members m
             where m.room_id = rm.id and m.user_id = rm.host_id) as host_hb
    from public.rooms rm
    where rm.status = 'lobby'
      and rm.is_private = false
      and rm.all_ready_at is not null
      and rm.all_ready_at <= now() - interval '5 minutes'
  loop
    -- 満室でなくなっていたらエピソード対象外
    if r.members <> r.capacity then
      continue;
    end if;
    insert into public.stall_events (room_id, master_id, all_ready_at, host_heartbeat_at)
    values (r.room_id, r.host_id, r.all_ready_at, r.host_hb)
    on conflict (room_id, all_ready_at) do nothing;
    if found then
      v_count := v_count + 1;

      -- 強制キック：マスターを退出させ、最古参へ移譲（残らなければ閉室）
      delete from public.room_members
       where room_id = r.room_id and user_id = r.host_id;

      select user_id into v_next_host
        from public.room_members
       where room_id = r.room_id
       order by joined_at
       limit 1;

      if v_next_host is not null then
        update public.rooms set host_id = v_next_host where id = r.room_id;
      else
        update public.rooms set status = 'closed' where id = r.room_id;
      end if;
      perform public.ww__refresh_all_ready(r.room_id);

      perform public.kl__send_system_dm(r.host_id,
        'あなたがマスターのルームで、参加者がそろって準備完了してから5分間ゲームが開始されなかったため、マスターを交代しました。' || chr(10) || chr(10)
        || '待っている参加者のために、開始できないときは早めにルームを解散するか、声をかけてください。そろったまま開始しない状態が繰り返し確認されると、利用制限の対象になります。');
    end if;
  end loop;
  return v_count;
end;
$function$;
