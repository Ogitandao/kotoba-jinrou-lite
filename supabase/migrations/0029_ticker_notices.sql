-- 0029: ティッカー運営告知（期限付き）対応（2026-11-25 おぎ承認）
-- メンテ告知などを「前日から当日まで」流し続けるための告知枠。
-- 告知は kind='notice' + expires_at を持ち、期限内は必ずフィード先頭に
-- 入る（通常イベントの24時間・最大8件ルールの対象外、最大3件）。
-- 投稿はオーナーが SQL / ダッシュボードから kl__ticker_notice を使う想定。
-- 一般ユーザー向けの投稿 RPC は作らない（内部関数・実行権限なし）。

alter table public.kl_ticker_events
  add column if not exists expires_at timestamptz;

-- 投稿関数を3引数版に置き換え（既存の2引数呼び出しはデフォルト値で互換）
drop function if exists public.kl__ticker_post(text, text);
create or replace function public.kl__ticker_post(
  p_kind text, p_text text, p_expires_at timestamptz default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.kl_ticker_events (kind, text, expires_at)
  values (p_kind, p_text, p_expires_at);
  -- 掃除：期限切れの告知は7日たったら削除。通常イベントは直近200件だけ残す
  delete from public.kl_ticker_events
   where kind = 'notice' and expires_at < now() - interval '7 days';
  delete from public.kl_ticker_events
   where kind <> 'notice'
     and id < (select coalesce(max(id), 0) - 200
                 from public.kl_ticker_events where kind <> 'notice');
end;
$$;

revoke all on function public.kl__ticker_post(text, text, timestamptz)
  from public, anon, authenticated;

-- 運営告知の投稿用（内部関数。一般には公開しない）
create or replace function public.kl__ticker_notice(
  p_text text, p_expires_at timestamptz
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.kl__ticker_post('notice', p_text, p_expires_at);
end;
$$;

revoke all on function public.kl__ticker_notice(text, timestamptz)
  from public, anon, authenticated;

-- フィード：未期限の告知（最大3件）を先頭に、通常イベント（24h・最大8件）を後に
create or replace function public.kl_ticker_feed()
returns jsonb
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(
             jsonb_build_object('id', e.id, 'text', e.text, 'createdAt', e.created_at)
             order by e.grp asc, e.id desc)
      from (
        (select id, text, created_at, 0 as grp
           from public.kl_ticker_events
          where kind = 'notice' and expires_at > now()
          order by id desc limit 3)
        union all
        (select id, text, created_at, 1 as grp
           from public.kl_ticker_events
          where kind <> 'notice'
            and created_at > now() - interval '24 hours'
          order by id desc limit 8)
      ) e
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.kl_ticker_feed() from public, anon;
grant execute on function public.kl_ticker_feed() to authenticated;
