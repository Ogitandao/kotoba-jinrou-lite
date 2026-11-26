-- =============================================================================
-- 0060_comeback_follows_announce.sql — 呼び戻しは「運営からのお知らせ」に統合
-- 2026-11-26 おぎ：独立した「おひさしぶり通知」の設定は分かりにくい。
-- プッシュ通知OFF／運営からのお知らせOFFの人には呼び戻しも送らない。
-- kl_push_prefs.comeback 列は残すが、以後は参照しない
-- =============================================================================

create or replace function public.kl__comeback_run()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_secret text;
  v_ids uuid[];
  v_req bigint;
begin
  with targets as (
    select p.id
    from public.profiles p
    join public.kl_push_prefs pr on pr.user_id = p.id
    where p.last_seen_at < now() - interval '3 days'
      and pr.master and pr.announce
      and (pr.last_comeback_at is null
           or pr.last_comeback_at < now() - interval '7 days')
      and exists (
        select 1 from public.kl_push_subscriptions s where s.user_id = p.id)
    limit 500
  )
  select array_agg(id) into v_ids from targets;
  if v_ids is null then
    return 0;
  end if;
  update public.kl_push_prefs
    set last_comeback_at = now()
    where user_id = any (v_ids);
  select value into v_secret from public.kl_config where key = 'push_secret';
  if v_secret is null then
    return 0;
  end if;
  select net.http_post(
    url := 'https://dtdwkluanoaqiaruzbwe.supabase.co/functions/v1/push-send',
    body := jsonb_build_object('mode', 'comeback', 'userIds', to_jsonb(v_ids)),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret)
  ) into v_req;
  return array_length(v_ids, 1);
end;
$$;
revoke execute on function public.kl__comeback_run() from public, anon, authenticated;
