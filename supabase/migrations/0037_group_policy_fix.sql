-- =============================================================================
-- 0037_group_policy_fix.sql — グループ RLS の自己参照を解消（0036 の修正）
-- =============================================================================
-- 0036 の kl_group_members ポリシーは自テーブルを EXISTS で参照して
-- いたため、Postgres が「infinite recursion detected in policy」
-- (42P17) を返し、メンバー本人の読み取りまで全滅した。
-- 対策：所属判定を security definer のヘルパーに切り出し（RLS を
-- 通らない）、3テーブルともそのヘルパー経由で判定する。
-- ヘルパーは (group, user) の所属 boolean だけを返す。group_id は
-- 推測不能な uuid のため、authenticated への execute 許可で足りる。
-- =============================================================================

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
