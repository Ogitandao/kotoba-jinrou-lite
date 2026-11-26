-- 0051 登録未完了アカウントの自動削除（2026-11-26）
--
-- 年齢確認をログイン前ゲートに移したことで、正直に申告して弾かれた
-- 人のアカウントはそもそも作られなくなった。ただし前置きを通らずに
-- アカウントだけ作られたケース（旧方式の残り・OAuth 復帰の欠落等）
-- では、生年月日が未登録の「登録未完了」アカウントが残りうる。
-- 個人情報を保持し続けないため、未完了のまま30日を過ぎたアカウントは
-- 日次クリーンアップ（kl__retention_cleanup、cron kl-retention-cleanup）
-- で自動削除する。
--
-- auth.users を削除すると profiles 以下は ON DELETE CASCADE で消える。
-- ww_games / ww_votes の一部 FK は NO ACTION のため、対戦記録から
-- 参照されているアカウントは削除が FK で止まる。その場合はその
-- アカウントだけ見送り、クリーンアップ全体は止めない。

create or replace function public.kl__retention_cleanup()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
  v_total integer := 0;
  r record;
begin
  -- 既存（0047）：保持期限を過ぎたモデレーションケースの削除
  -- （pending の異議申立てがぶら下がるケースは消さない）
  delete from public.moderation_cases c
   where c.retention_until is not null
     and c.retention_until < now()
     and not exists (
       select 1 from public.appeals a
        where a.penalty_event_id = c.penalty_event_id and a.status = 'pending'
     );
  get diagnostics v_n = row_count;
  v_total := v_total + v_n;

  -- 追加（0051）：登録未完了のまま30日を過ぎたアカウントの削除
  for r in
    select p.id
      from public.profiles p
     where p.birthdate is null
       and p.created_at < now() - interval '30 days'
  loop
    begin
      delete from auth.users u where u.id = r.id;
      v_total := v_total + 1;
    exception when foreign_key_violation then
      null; -- 対戦記録等から参照されている場合は見送る
    end;
  end loop;

  return v_total;
end;
$$;
