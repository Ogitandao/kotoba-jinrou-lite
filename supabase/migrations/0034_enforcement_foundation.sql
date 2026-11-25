-- =============================================================================
-- 0034_enforcement_foundation.sql — 処分システムの土台（Lite）
-- =============================================================================
-- 決定の正本：docs/enforcement-design.md ＋ 決定記録（2026-11-25 おぎ決定 U1〜U10）。
--
-- このマイグレーションの範囲（DB層のみ。判定パイプラインは Edge Function 側）：
-- - reports.target_kind に 'game_message'（対戦中チャット）を追加
-- - penalty_events.kind に 'warning'（警告記録）/'violation'（ハラスメント確定）/
--   'master_stall'（マスター放置確定）を追加
-- - moderation_cases：通報されたコンテンツの証跡＋機械判定の記録（§1.6）
-- - reporter_stats：通報者の信頼度（§3.1）
-- - ng_words：NGワード表（重度／軽度）。中身は運営が別途管理し、本書には載せない
-- - stall_events：マスター放置エピソードの証跡（§2.1）。検出は kl__detect_stalls()
-- - kl__ng_check(text)：送信時フィルタ／機械チェック共用の照合関数（§1.3）
--
-- 保持期間（U5/U9）は moderation_cases.retention_until に判定時点で刻む。
-- 掃除ジョブは次フェーズ（申立て保留中のケースを消さないため、appeals 実装と同時）。
-- =============================================================================

-- ---------- 通報対象の拡張 ----------

alter table public.reports drop constraint reports_target_kind_check;
alter table public.reports
  add constraint reports_target_kind_check
  check (target_kind in ('user', 'dm_message', 'room_message', 'game_message'));

alter table public.penalty_events drop constraint penalty_events_kind_check;
alter table public.penalty_events
  add constraint penalty_events_kind_check
  check (kind in ('vote_skip', 'abandon', 'manual', 'silent_play', 'silent_no_vote',
                  'warning', 'violation', 'master_stall'));

-- ---------- moderation_cases（証跡＋判定） ----------

create table if not exists public.moderation_cases (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid references auth.users (id) on delete set null,
  surface text not null check (surface in ('dm', 'room', 'game', 'profile')),
  target_ref uuid,
  report_ids uuid[] not null default '{}',
  snapshot_text text,
  context jsonb,
  moderation_scores jsonb,
  ng_hits jsonb,
  report_weight numeric not null default 0,
  decision text not null default 'pending'
    check (decision in ('pending', 'none', 'hidden', 'warned', 'penalized', 'dismissed')),
  decision_reason text,
  severe boolean not null default false,
  penalty_event_id uuid references public.penalty_events (id) on delete set null,
  retention_until timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.moderation_cases is
  '通報コンテンツの証跡と機械判定（enforcement-design §1.6）。クライアントからは読めない（RLS・ポリシーなし）。書き込みは Edge Function（service_role）と運営のみ。保持は retention_until（U5：処分1年／非表示のみ180日／却下90日。U9：sexual/minors は長期保持）。';

create index if not exists moderation_cases_target_idx
  on public.moderation_cases (target_user_id, created_at desc);
create index if not exists moderation_cases_pending_idx
  on public.moderation_cases (decision, created_at) where decision = 'pending';
create index if not exists moderation_cases_retention_idx
  on public.moderation_cases (retention_until) where retention_until is not null;

alter table public.moderation_cases enable row level security;

drop trigger if exists moderation_cases_set_updated_at on public.moderation_cases;
create trigger moderation_cases_set_updated_at
  before update on public.moderation_cases
  for each row execute function public.set_updated_at();

-- ---------- reporter_stats（通報者の信頼度） ----------

create table if not exists public.reporter_stats (
  user_id uuid primary key references auth.users (id) on delete cascade,
  reports_total integer not null default 0,
  reports_upheld integer not null default 0,
  reports_dismissed integer not null default 0,
  trust_score numeric not null default 1.0 check (trust_score between 0.2 and 2.0),
  abuse_warned_at timestamptz,
  report_blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.reporter_stats is
  '通報者の信頼度（enforcement-design §3.1）。初期値 1.0（登録7日未満は 0.5 扱いを判定側で補正）、的中 +0.1（上限2.0）／却下 −0.2（下限0.2）。U6：処分階段には乗せず、重み低下＋累積で警告DM。クライアントからは読めない。';

alter table public.reporter_stats enable row level security;

-- ---------- ng_words（NGワード表） ----------

create table if not exists public.ng_words (
  id uuid primary key default gen_random_uuid(),
  pattern text not null,
  severity text not null check (severity in ('heavy', 'light')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.ng_words is
  'NGワード（enforcement-design §1.3）。heavy＝送信時ブロック＋機械チェック加算、light＝通報との複合でのみ使用。具体的なワードは運営が別途投入・管理する（アプリ更新なしで差し替え可能）。クライアントからは読めない。';

alter table public.ng_words enable row level security;

-- ---------- stall_events（マスター放置の証跡） ----------

create table if not exists public.stall_events (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  master_id uuid not null references auth.users (id) on delete cascade,
  all_ready_at timestamptz not null,
  host_heartbeat_at timestamptz,
  status text not null default 'recorded'
    check (status in ('recorded', 'confirmed', 'dismissed')),
  penalty_event_id uuid references public.penalty_events (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (room_id, all_ready_at)
);

comment on table public.stall_events is
  'マスター放置エピソードの証跡（enforcement-design §2）。検出＝記録まで（kl__detect_stalls）。処分確定はハイブリッド（メンバー通報との一致、または30日で3回の累積）＋U3の階段（1〜2回目=警告DM、3回目から afk 合算）。host_heartbeat_at が古い場合は回線落ちの可能性として確定に使わない（§2.4）。';

create index if not exists stall_events_master_idx
  on public.stall_events (master_id, created_at desc);

alter table public.stall_events enable row level security;

-- ---------- NGワード照合（§1.3） ----------

create or replace function public.kl__ng_normalize(p_text text)
returns text
language sql immutable
as $$
  select regexp_replace(
           translate(lower(coalesce(p_text, '')),
             'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９',
             'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz0123456789'),
           '[\s　・。、,.!！?？\-ー~〜…]', '', 'g')
$$;

create or replace function public.kl__ng_check(p_text text)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_text text := public.kl__ng_normalize(p_text);
  v_hit text;
begin
  if v_text = '' then
    return null;
  end if;
  select severity into v_hit
  from public.ng_words
  where active
    and v_text like '%' || public.kl__ng_normalize(pattern) || '%'
  order by case severity when 'heavy' then 0 else 1 end
  limit 1;
  return v_hit;  -- 'heavy' / 'light' / null
end;
$$;

comment on function public.kl__ng_check(text) is
  '本文を正規化（全角半角・空白・記号の吸収）して ng_words と照合し、最重の severity を返す。送信時フィルタ（heavy のみブロック）と機械チェックの加算に共用。';

revoke execute on function public.kl__ng_check(text) from public, anon, authenticated;
revoke execute on function public.kl__ng_normalize(text) from public, anon, authenticated;

-- ---------- マスター放置の検出（§2.1） ----------

create or replace function public.kl__detect_stalls()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    select rm.id as room_id, rm.host_id, rm.all_ready_at, rm.capacity,
           (select count(*) from public.room_members m where m.room_id = rm.id) as members,
           (select m.last_heartbeat_at from public.room_members m
             where m.room_id = rm.id and m.user_id = rm.host_id) as host_hb
    from public.rooms rm
    where rm.status = 'lobby'
      and rm.all_ready_at is not null
      and rm.all_ready_at <= now() - interval '5 minutes'
  loop
    -- 満室でなくなっていたらエピソード対象外（§2.4）
    if r.members <> r.capacity then
      continue;
    end if;
    insert into public.stall_events (room_id, master_id, all_ready_at, host_heartbeat_at)
    values (r.room_id, r.host_id, r.all_ready_at, r.host_hb)
    on conflict (room_id, all_ready_at) do nothing;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

comment on function public.kl__detect_stalls() is
  '満室＋全員準備OKから5分経過しても開始されていないルームを stall_events に記録する（1分毎の cron から呼ぶ）。処分の確定はしない（ハイブリッド確定はパイプライン側）。';

revoke execute on function public.kl__detect_stalls() from public, anon, authenticated;

select cron.schedule('kl-stall-detect', '* * * * *', 'select public.kl__detect_stalls()')
where not exists (select 1 from cron.job where jobname = 'kl-stall-detect');
