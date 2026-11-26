-- =============================================================================
-- 0055_friend_realtime.sql — フレンド申請を Realtime で即時反映する
-- =============================================================================
-- 2026-11-26 おぎ要望：申請をもらった側がフレンドタブを開くまで新規が
-- 取得されず通知も付かないのを、画面遷移なしでリアルタイムにしたい。
-- friend_requests（申請）と friendships（成立）を publication に入れ、
-- クライアントが変化を購読してバッジとパネルをその場で更新する。
-- replica identity full は DELETE イベントに旧行（from/to）を含めるため
-- （拒否で申請行が消えたことを申請者側でも拾えるように）。
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'friend_requests'
  ) then
    alter publication supabase_realtime add table public.friend_requests;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end $$;

alter table public.friend_requests replica identity full;
