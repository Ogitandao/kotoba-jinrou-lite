-- =============================================================================
-- 0008_ready_and_room_list.sql — 待機室の準備OK＋ルーム一覧RPC（Lite）
-- =============================================================================
-- 対戦画面フェーズで追加。
-- - room_members.ready：待機室の「準備OK」状態。自分の行だけ RPC 経由で
--   変更できる（room_members には UPDATE ポリシーを作らない方針を維持）
-- - ww_list_rooms：ルーム一覧。room_members の RLS は「自分の参加ルーム
--   のみ可視」のため、非参加の公開ルームの人数が数えられない。一覧に
--   必要な項目（人数・ホスト表示）だけを SECURITY DEFINER で返す
-- - ww_set_ready：準備OKの切り替え
-- =============================================================================

alter table public.room_members
  add column if not exists ready boolean not null default false;

comment on column public.room_members.ready is
  '待機室の準備OK状態。ww_set_ready でのみ変更する。';

-- 準備OKの切り替え（自分の参加行のみ）
create or replace function public.ww_set_ready(p_room uuid, p_ready boolean)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  n integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  update public.room_members set ready = p_ready
   where room_id = p_room and user_id = me;
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'NOT_A_MEMBER: このルームに参加していません' using errcode = 'P0001';
  end if;
end;
$$;

-- ルーム一覧（公開ルーム全件＋自分が関係する非公開ルーム）。
-- パスワードや秘匿情報は含めない。
create or replace function public.ww_list_rooms()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', r.id,
      'title', r.title,
      'isPrivate', r.is_private,
      'beginner', r.beginner_welcome,
      'capacity', r.capacity,
      'status', r.status,
      'reversalEnabled', r.reversal_enabled,
      'hostId', r.host_id,
      'hostName', hp.display_name,
      'hostIcon', hp.icon_emoji,
      'hostBg', hp.icon_bg,
      'memberCount', (select count(*) from public.room_members m
                       where m.room_id = r.id),
      'isMember', exists (select 1 from public.room_members m
                           where m.room_id = r.id and m.user_id = auth.uid()),
      'isHost', r.host_id = auth.uid(),
      'createdAt', r.created_at
    ) as item, r.created_at
    from public.rooms r
    join public.profiles hp on hp.id = r.host_id
    where r.status <> 'closed'
      and (not r.is_private
           or r.host_id = auth.uid()
           or exists (select 1 from public.room_members m
                       where m.room_id = r.id and m.user_id = auth.uid()))
  ) s
$$;

revoke all on function public.ww_set_ready(uuid, boolean) from public, anon;
revoke all on function public.ww_list_rooms() from public, anon;
grant execute on function public.ww_set_ready(uuid, boolean) to authenticated;
grant execute on function public.ww_list_rooms() to authenticated;
