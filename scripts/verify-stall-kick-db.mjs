// 0063 マスター放置の新ルール（2026-11-28 おぎ確定）を実 DB で検証する。
// 実行: node scripts/verify-stall-kick-db.mjs
//
// カバー範囲：
// - 公開ルーム：満室＋全員準備OK＋5分 → マスター強制キック、最古参へ移譲、
//   部屋は存続、all_ready_at は消える、記録は残る、理由DMが届く
// - 2回目の検出では何も起きない（新マスターは巻き込まれない）
// - 非公開ルーム：同じ条件でも記録もキックもされない
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '../client/vendor/supabase.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const cfg = JSON.parse(
  readFileSync(new URL('../client/kl-config.js', import.meta.url), 'utf8')
    .match(/\{[\s\S]*\}/)[0]);
const URL_ = cfg.supabaseUrl;
const KEY = cfg.supabaseKey;
const REF = 'dtdwkluanoaqiaruzbwe';
const HELPER = '/home/hatch/workspace/custom-connectors/custom.supabase/bin/supabase_api.py';
const PW = String.fromCharCode(76, 105, 116, 101, 45, 71, 105, 99, 107, 45, 50, 48, 50, 54, 33);
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

function sql(q) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const out = execFileSync('python3', [HELPER, 'query', REF, q],
        { encoding: 'utf8', timeout: 120000 });
      return JSON.parse(out);
    } catch (e) {
      lastErr = e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500 * (i + 1));
    }
  }
  throw lastErr;
}
const sql1 = (q) => sql(q)[0] ?? {};
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpcRaw(user, fn, args) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { last = await user.sb.rpc(fn, args); } catch (e) { last = { data: null, error: e }; }
    if (!last.error || !/fetch failed/i.test(last.error.message ?? '')) return last;
    await sleepMs(1000 * (i + 1));
  }
  return last;
}
async function rpc(user, fn, args) {
  const { data, error } = await rpcRaw(user, fn, args);
  return { data, error, code: error ? rpcErr(error) : null };
}
async function signup(tag) {
  const sb = mkClient();
  const email = `kl.lite.stallkick.${tag}${stamp}@gmail.com`;
  let data, error;
  for (let i = 0; i < 4; i++) {
    try {
      ({ data, error } = await sb.auth.signUp({
        email, password: PW,
        options: { data: { test_marker: 'test/lite', display_name: `放置キック検証${tag}` } },
      }));
    } catch (e) { error = e; }
    if (!error) break;
    await sleepMs(1000 * (i + 1));
  }
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  return { sb, id: data.user.id, email };
}

async function fullReadyRoom(tag, isPrivate) {
  const host = await signup(`${tag}h`);
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await signup(`${tag}m${i}`));
  const room = await rpc(host, 'ww_create_room', {
    p_title: `放置キック${tag}`, p_is_private: isPrivate,
    p_beginner_welcome: false, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
  });
  if (room.error) throw new Error(`${tag} ルーム作成失敗: ${room.code}`);
  const roomId = room.data.id;
  if (isPrivate) {
    // 非公開ルームは招待DM経由でしか入れない（フレンド化→招待）
    for (const m of members) {
      await rpc(host, 'kl_send_friend_request', { p_to: m.id });
      await rpc(m, 'kl_respond_friend_request', { p_from: host.id, p_accept: true });
      const inv = await rpc(host, 'kl_send_invite', { p_to: m.id, p_room: roomId });
      if (inv.error) throw new Error(`${tag} 招待失敗: ${inv.code}`);
    }
  }
  // 入室順を確定させるため少し間隔を空ける（移譲先＝最古参の判定用）
  for (const m of members) {
    const j = await rpc(m, 'ww_join_room', { p_room: roomId });
    if (j.error) throw new Error(`${tag} 入室失敗: ${j.code}`);
    await sleepMs(1100);
  }
  for (const m of members) await rpc(m, 'ww_set_ready', { p_room: roomId, p_ready: true });
  sql(`update public.rooms set all_ready_at = now() - interval '6 minutes' where id = '${roomId}'`);
  return { host, members, roomId };
}

// ================= 公開ルーム：強制キックと移譲 =================
{
  const { host, members, roomId } = await fullReadyRoom('pub', false);
  sql('select public.kl__detect_stalls()');

  const events = sql(`select id from public.stall_events where room_id = '${roomId}'`);
  check('公開：放置が記録される', events.length === 1, `${events.length}件`);

  const hostRow = sql1(`select count(*)::int as n from public.room_members where room_id = '${roomId}' and user_id = '${host.id}'`);
  check('公開：マスターはその場で退出させられる', Number(hostRow.n) === 0);

  const room = sql1(`select host_id, status, all_ready_at from public.rooms where id = '${roomId}'`);
  check('公開：最古参メンバーへマスターが移る', room.host_id === members[0].id, `host=${room.host_id}`);
  check('公開：部屋は存続する（lobby）', room.status === 'lobby', room.status);
  check('公開：満室でなくなり all_ready_at は消える', !room.all_ready_at);

  const dm = sql(`select body from public.dm_messages where sender_id is null and recipient_id = '${host.id}' and kind = 'system' and body like '%マスターを交代しました%'`);
  check('公開：キックされたマスターへ理由のシステムDMが届く', dm.length >= 1);

  // 2回目の検出：新マスターは巻き込まれない
  sql('select public.kl__detect_stalls()');
  const events2 = sql(`select id from public.stall_events where room_id = '${roomId}'`);
  const newHostRow = sql1(`select count(*)::int as n from public.room_members where room_id = '${roomId}' and user_id = '${members[0].id}'`);
  check('公開：2回目の検出では追加の記録もキックも起きない',
    events2.length === 1 && Number(newHostRow.n) === 1);
  // 後片付け（検証ルームを本番ロビーに残さない）
  sql(`delete from public.room_members where room_id = '${roomId}'`);
  sql(`delete from public.rooms where id = '${roomId}'`);
}

// ================= 非公開ルーム：記録もキックもなし =================
{
  const { host, roomId } = await fullReadyRoom('prv', true);
  sql('select public.kl__detect_stalls()');

  const events = sql(`select id from public.stall_events where room_id = '${roomId}'`);
  check('非公開：放置は記録されない', events.length === 0, `${events.length}件`);

  const room = sql1(`select host_id, status from public.rooms where id = '${roomId}'`);
  const hostRow = sql1(`select count(*)::int as n from public.room_members where room_id = '${roomId}' and user_id = '${host.id}'`);
  check('非公開：マスターは残ったまま', room.host_id === host.id && Number(hostRow.n) === 1);
  // 後片付け（検証ルームを本番ロビーに残さない）
  sql(`delete from public.room_members where room_id = '${roomId}'`);
  sql(`delete from public.rooms where id = '${roomId}'`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
