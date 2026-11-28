-- 0065: lobby_since_at トリガの修正（0064 の補正）
-- INSERT 時に明示された lobby_since_at を尊重する（検証や将来の
-- データ移行で時刻を指定して作る場合に、トリガが現在時刻で
-- 上書きしてしまわないように）。通常の作成では未指定（NULL）に
-- なるため、従来通り現在時刻が入る。
create or replace function public.ww__rooms_lobby_since()
returns trigger
language plpgsql
as $function$
begin
  if new.status = 'lobby'
     and (tg_op = 'INSERT' or old.status is distinct from 'lobby')
     and (tg_op = 'UPDATE' or new.lobby_since_at is null) then
    new.lobby_since_at := now();
  end if;
  return new;
end;
$function$;
