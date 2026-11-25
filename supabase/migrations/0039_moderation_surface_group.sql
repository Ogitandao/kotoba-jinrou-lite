-- =============================================================================
-- 0039_moderation_surface_group.sql — moderation_cases.surface に 'group' を追加
-- =============================================================================
-- 0038 で sweep が surface 'group' のケースを作るようになったが、
-- 0034 の CHECK が ('dm','room','game','profile') のままで挿入が
-- 23514 で落ちていた（sweep 全体が毎回ロールバックする）。値域を広げる。
-- =============================================================================

alter table public.moderation_cases drop constraint moderation_cases_surface_check;
alter table public.moderation_cases
  add constraint moderation_cases_surface_check
  check (surface in ('dm', 'room', 'game', 'profile', 'group'));
