-- =============================================================================
-- 0036_group_chat.sql — グループチャットの実 DB 配線（Lite）
-- =============================================================================
-- 1階（Sim）で確定した仕様をそのまま DB 化する：
-- - 公開グループなし（招待制のみ）。マスター／管理者なし、全員フラット
-- - 誰も外せない（キックなし）。対処は脱退＋通報のみ
-- - 追加できるのは「自分のフレンド」だけ
-- - グループはトーク一覧に会話として合流する（専用タブなし）
-- - 参加／脱退などのシステム通知は kind='system'（sender_id NULL）の
--   メッセージとして流れ、画面では中央ピルで表示される
-- 書き込みは RPC 経由のみ（RLS は読み取り＝自グループのみ）。
-- 未読はメンバー行の last_read_at で管理する（メッセージ側に既読を持たない）。
-- 上限 50 人は RPC 内のチェック（GROUP_FULL）。調整はこの値を変える。
-- =============================================================================

create table if not exists public.kl_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.kl_groups is
  'グループチャット本体。全グループ非公開（追加された人だけが入れる）。管理者は置かない。';

create table if not exists public.kl_group_members (
  group_id uuid not null references public.kl_groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (group_id, user_id)
);

comment on table public.kl_group_members is
  'グループ所属。last_read_at が未読管理の正本（null＝参加時点から全部未読）。';

create index if not exists kl_group_members_user_idx
  on public.kl_group_members (user_id, group_id);

create table if not exists public.kl_group_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.kl_groups (id) on delete cascade,
  sender_id uuid references auth.users (id) on delete cascade,
  kind text not null default 'text',
  body text,
  hidden_at timestamptz,
  created_at timestamptz not null default now(),
  constraint kl_group_messages_kind_check check (kind in ('text', 'system')),
  constraint kl_group_messages_body_check check (
    (kind = 'text' and sender_id is not null and body is not null
      and length(body) between 1 and 500)
    or (kind = 'system' and sender_id is null and body is not null)
  ),
  constraint kl_group_messages_no_url check (
    kind <> 'text' or body !~* 'https?://|www\.'
  )
);

comment on table public.kl_group_messages is
  'グループの発言。sender_id NULL はシステム通知。hidden_at は処分パイプライン（0035）互換。';

create index if not exists kl_group_messages_group_idx
  on public.kl_group_messages (group_id, created_at desc);

alter table public.kl_groups enable row level security;
alter table public.kl_group_members enable row level security;
alter table public.kl_group_messages enable row level security;

-- 所属判定は security definer のヘルパー経由にする。
-- （ポリシー内で自テーブルを EXISTS 参照すると 42P17 の無限再帰に
-- なる。0037 で本番側も同じ形に修正済み）
create or replace function public.kl__is_group_member(p_group uuid, p_user uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.kl_group_members
    where group_id = p_group and user_id = p_user
  );
$$;

revoke all on function public.kl__is_group_member(uuid, uuid) from public, anon;
grant execute on function public.kl__is_group_member(uuid, uuid) to authenticated;

-- 読み取りは「自分がメンバーのグループ」だけ
drop policy if exists "kl_groups: read own groups" on public.kl_groups;
create policy "kl_groups: read own groups"
  on public.kl_groups for select to authenticated
  using (public.kl__is_group_member(id, (select auth.uid())));

drop policy if exists "kl_group_members: read own groups" on public.kl_group_members;
create policy "kl_group_members: read own groups"
  on public.kl_group_members for select to authenticated
  using (public.kl__is_group_member(group_id, (select auth.uid())));

drop policy if exists "kl_group_messages: read own groups" on public.kl_group_messages;
create policy "kl_group_messages: read own groups"
  on public.kl_group_messages for select to authenticated
  using (public.kl__is_group_member(group_id, (select auth.uid())));

revoke all on table public.kl_groups, public.kl_group_members, public.kl_group_messages from anon;
grant select on table public.kl_groups, public.kl_group_members, public.kl_group_messages to authenticated;

-- Realtime（将来のグループ購読用に publication へ登録しておく）
do $$
begin
  alter publication supabase_realtime add table public.kl_group_messages;
exception when duplicate_object then null;
end $$;

-- =============================================================================
-- 内部ヘルパー
-- =============================================================================

-- 自分がメンバーかを確認し、グループ行を返す
create or replace function public.kl__require_group_member(p_group uuid)
returns public.kl_groups
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  g public.kl_groups%rowtype;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  select * into g from public.kl_groups where id = p_group;
  if not found then
    raise exception 'GROUP_NOT_FOUND: グループが見つかりません' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.kl_group_members
    where group_id = p_group and user_id = me
  ) then
    raise exception 'NOT_MEMBER: このグループのメンバーではありません' using errcode = 'P0001';
  end if;
  return g;
end;
$$;

-- グループの公開ビュー { id, name, memberIds }（joined_at 順）
create or replace function public.kl__group_view(p_group uuid)
returns jsonb
language sql security definer set search_path = public
as $$
  select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'memberIds', coalesce((
      select jsonb_agg(m.user_id order by m.joined_at, m.user_id)
      from public.kl_group_members m where m.group_id = g.id
    ), '[]'::jsonb)
  )
  from public.kl_groups g where g.id = p_group;
$$;

create or replace function public.kl__group_system_msg(p_group uuid, p_body text)
returns void
language sql security definer set search_path = public
as $$
  insert into public.kl_group_messages (group_id, sender_id, kind, body)
  values (p_group, null, 'system', p_body);
$$;

revoke all on function public.kl__require_group_member(uuid) from public, anon, authenticated;
revoke all on function public.kl__group_view(uuid) from public, anon, authenticated;
revoke all on function public.kl__group_system_msg(uuid, text) from public, anon, authenticated;

-- =============================================================================
-- グループ作成（メンバーは自分のフレンドのみ。名前が空なら自動名）
-- =============================================================================
create or replace function public.kl_create_group(p_name text, p_member_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  ids uuid[] := '{}';
  candidate uuid;
  g public.kl_groups%rowtype;
  v_name text := trim(coalesce(p_name, ''));
begin
  if me is null then
    raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
  end if;
  -- 重複と自分自身を除く（入力順は保つ）
  foreach candidate in array coalesce(p_member_ids, '{}')
  loop
    if candidate <> me and not (candidate = any (ids)) then
      ids := ids || candidate;
    end if;
  end loop;
  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'GROUP_NO_MEMBERS: メンバーを1人以上選んでください' using errcode = 'P0001';
  end if;
  if array_length(ids, 1) + 1 > 50 then
    raise exception 'GROUP_FULL: グループは50人までです' using errcode = 'P0001';
  end if;
  foreach candidate in array ids
  loop
    perform public.kl_require_user(candidate);
    if public.kl_blocked_either(me, candidate) then
      raise exception 'BLOCKED: ブロック関係のユーザーは追加できません' using errcode = 'P0001';
    end if;
    if not public.kl_are_friends(me, candidate) then
      raise exception 'NOT_FRIENDS: 追加できるのはフレンドだけです' using errcode = 'P0001';
    end if;
  end loop;
  if length(v_name) > 20 then
    raise exception 'GROUP_NAME_TOO_LONG: グループ名は20文字までです' using errcode = 'P0001';
  end if;
  if v_name = '' then
    -- 自動名：自分＋メンバーの表示名を「、」でつなぐ（Sim と同じ）
    select string_agg(x.display_name, '、' order by x.ord) into v_name
    from (
      select p.display_name, 0 as ord
      from public.profiles p where p.id = me
      union all
      select p.display_name, array_position(ids, p.id)
      from public.profiles p where p.id = any (ids)
    ) x;
  end if;
  insert into public.kl_groups (name, created_by) values (v_name, me)
  returning * into g;
  insert into public.kl_group_members (group_id, user_id, last_read_at)
  values (g.id, me, now());
  insert into public.kl_group_members (group_id, user_id)
  select g.id, unnest(ids);
  perform public.kl__group_system_msg(g.id, 'グループが作成されました');
  return public.kl__group_view(g.id);
end;
$$;

-- =============================================================================
-- グループへ発言（メンバーのみ。DM と同じ本文ルール）
-- =============================================================================
create or replace function public.kl_send_group_message(p_group uuid, p_body text)
returns public.kl_group_messages
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  body text := trim(coalesce(p_body, ''));
  msg public.kl_group_messages%rowtype;
begin
  perform public.kl__require_group_member(p_group);
  if length(body) = 0 then
    raise exception 'EMPTY_MESSAGE: 本文が空です' using errcode = 'P0001';
  end if;
  if length(body) > 500 then
    raise exception 'MESSAGE_TOO_LONG: 500文字以内で入力してください' using errcode = 'P0001';
  end if;
  if body ~* 'https?://|www\.' then
    raise exception 'URL_NOT_ALLOWED: リンクは送れません' using errcode = 'P0001';
  end if;
  insert into public.kl_group_messages (group_id, sender_id, kind, body)
  values (p_group, me, 'text', body)
  returning * into msg;
  return msg;
end;
$$;

-- =============================================================================
-- 既読化（自分のメンバー行の last_read_at を進める）
-- =============================================================================
create or replace function public.kl_mark_group_read(p_group uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.kl__require_group_member(p_group);
  update public.kl_group_members
  set last_read_at = now()
  where group_id = p_group and user_id = auth.uid();
end;
$$;

-- =============================================================================
-- メンバー追加（追加できるのは自分のフレンドだけ。既存メンバーは読み飛ばす）
-- =============================================================================
create or replace function public.kl_add_group_members(p_group uuid, p_member_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  candidate uuid;
  added uuid[] := '{}';
  current_count integer;
  added_names text;
begin
  perform public.kl__require_group_member(p_group);
  foreach candidate in array coalesce(p_member_ids, '{}')
  loop
    if candidate = me then continue; end if;
    if exists (
      select 1 from public.kl_group_members
      where group_id = p_group and user_id = candidate
    ) then continue; end if;
    perform public.kl_require_user(candidate);
    if public.kl_blocked_either(me, candidate) then
      raise exception 'BLOCKED: ブロック関係のユーザーは追加できません' using errcode = 'P0001';
    end if;
    if not public.kl_are_friends(me, candidate) then
      raise exception 'NOT_FRIENDS: 追加できるのはフレンドだけです' using errcode = 'P0001';
    end if;
    added := added || candidate;
  end loop;
  if coalesce(array_length(added, 1), 0) > 0 then
    select count(*) into current_count
    from public.kl_group_members where group_id = p_group;
    if current_count + array_length(added, 1) > 50 then
      raise exception 'GROUP_FULL: グループは50人までです' using errcode = 'P0001';
    end if;
    insert into public.kl_group_members (group_id, user_id)
    select p_group, unnest(added);
    select string_agg(p.display_name, '、') into added_names
    from public.profiles p where p.id = any (added);
    perform public.kl__group_system_msg(
      p_group, coalesce(added_names, '') || 'さんが参加しました');
  end if;
  return public.kl__group_view(p_group);
end;
$$;

-- =============================================================================
-- 脱退（Sim と同じく通知メッセージは出さない。抜けた時点で会話は見えなくなる）
-- =============================================================================
create or replace function public.kl_leave_group(p_group uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.kl__require_group_member(p_group);
  delete from public.kl_group_members
  where group_id = p_group and user_id = auth.uid();
end;
$$;

-- =============================================================================
-- グループ名の変更（メンバーなら誰でも可）
-- =============================================================================
create or replace function public.kl_rename_group(p_group uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name text := trim(coalesce(p_name, ''));
begin
  perform public.kl__require_group_member(p_group);
  if v_name = '' then
    raise exception 'GROUP_NAME_EMPTY: グループ名を入力してください' using errcode = 'P0001';
  end if;
  if length(v_name) > 20 then
    raise exception 'GROUP_NAME_TOO_LONG: グループ名は20文字までです' using errcode = 'P0001';
  end if;
  update public.kl_groups set name = v_name where id = p_group;
  return public.kl__group_view(p_group);
end;
$$;

revoke all on function public.kl_create_group(text, uuid[]) from public, anon;
revoke all on function public.kl_send_group_message(uuid, text) from public, anon;
revoke all on function public.kl_mark_group_read(uuid) from public, anon;
revoke all on function public.kl_add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.kl_leave_group(uuid) from public, anon;
revoke all on function public.kl_rename_group(uuid, text) from public, anon;

grant execute on function public.kl_create_group(text, uuid[]) to authenticated;
grant execute on function public.kl_send_group_message(uuid, text) to authenticated;
grant execute on function public.kl_mark_group_read(uuid) to authenticated;
grant execute on function public.kl_add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.kl_leave_group(uuid) to authenticated;
grant execute on function public.kl_rename_group(uuid, text) to authenticated;
