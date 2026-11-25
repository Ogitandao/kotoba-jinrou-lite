-- 0026: ルーム名は10文字まで（2026-11-25 おぎ）
-- カード表示で公開/非公開タグが崩れる問題への対策の一環。
-- 0018 の ww_create_room を再定義し、タイトル長チェックだけを追加する。
create or replace function public.ww_create_room(
p_title text,
p_is_private boolean default false,
p_password text default null,
p_beginner_welcome boolean default false,
p_reversal_enabled boolean default true,
p_capacity integer default 8,
p_genre text default null
)
returns public.rooms
language plpgsql security definer set search_path = public, extensions
as $$
declare
me uuid := auth.uid();
room public.rooms%rowtype;
spent record;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
perform public.kl__assert_not_penalized(me);
perform public.kl__assert_rules_agreed(me);
if char_length(trim(coalesce(p_title, ''))) > 10 then
raise exception 'TITLE_TOO_LONG: ルーム名は10文字までです' using errcode = 'P0001';
end if;
if p_is_private and (p_password is null or length(p_password) < 4) then
raise exception 'PASSWORD_REQUIRED: 非公開ルームには4文字以上のパスワードが必要です' using errcode = 'P0001';
end if;
if p_genre is not null and not exists (
  select 1 from public.ww_topics t where t.active and t.category = p_genre
) then
raise exception 'INVALID_GENRE: ジャンルが存在しません' using errcode = 'P0001';
end if;

insert into public.rooms (host_id, title, is_private, password_hash,
beginner_welcome, capacity, reversal_enabled, genre)
values (me, coalesce(nullif(trim(p_title), ''), ''), p_is_private,
case when p_is_private then crypt(p_password, gen_salt('bf')) end,
p_beginner_welcome, p_capacity, p_reversal_enabled, p_genre)
returning * into room;

insert into public.room_members (room_id, user_id) values (room.id, me);

if p_is_private then
select * into spent from public.kl_spend_coins(me, 100);
insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
values (me, -spent.spent_free, -spent.spent_paid, 'private_room', room.id);
end if;
return room;
end;
$$;

revoke all on function public.ww_create_room(text, boolean, text, boolean, boolean, integer, text) from public, anon;
grant execute on function public.ww_create_room(text, boolean, text, boolean, boolean, integer, text) to authenticated;
