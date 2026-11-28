// 0064 公開ルームの自動解散（2026-11-28 おぎ決定「B」）を実 DB で検証する。
// 実行: node scripts/verify-dissolve-db.mjs
//
// カバー範囲：
// - 公開ルームは待機30分で自動解散する（生存信号が新しくても解散する）
// - 非公開ルームは対象外／29分では解散しない
// - 待機入り時刻（lobby_since_at）は作成時と「試合後に待機へ戻った時」に更新される
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
const PW = String.fromCharCode(76, 105, 116, 101, 45, 68, 105, 115, 115, 45, 50, 48, 50, 54, 33);
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
  const email = `kl.lite.dissolve.${tag}${stamp}@gmail.com`;
  let data, error;
  for (let i = 0; i < 4; i++) {
    try {
      ({ data, error } = await sb.auth.signUp({
        email, password: PW,
        options: { data: { test_marker: 'test/lite', display_name: `解散検証${tag}` } },
      }));
    } catch (e) { error = e; }
    if (!error && data?.session) break;
    await sleepMs(1000 * (i + 1));
  }
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  return { sb, id: data.user.id, email };
}
function cleanupRoom(roomId) {
  sql(`delete from public.room_members where room_id = '${roomId}'`);
  sql(`delete from public.rooms where id = '${roomId}'`);
}

// ================= 解散の本体（SQLで部屋を用意） =================
{
  const H = await signup('h');
  // 部屋とメンバーは1文で作る。別々に作ると、間の1分間隔の見回り（cron）で
  // 「空の部屋」として閉じられてしまう（本番では作成RPCが原子的に作る）
  const mk = (title, isPrivate, ageMin) => sql1(`
    with r as (insert into public.rooms
      (host_id, title, capacity, status, is_private, lobby_since_at)
      values ('${H.id}', '${title}', 4, 'lobby', ${isPrivate}, now() - interval '${ageMin} minutes')
      returning id)
    , m as (insert into public.room_members (room_id, user_id, joined_at, last_heartbeat_at)
      select id, '${H.id}', now(), now() from r)
    select id from r`);
  const pub31 = mk('解散検証・公開31分', false, 31);
  const prv31 = mk('解散検証・非公開31分', true, 31);
  const pub29 = mk('解散検証・公開29分', false, 29);
  // メンバーの生存信号は新しい（解散は信号と無関係であることの証明込み）
  sql('select public.ww_sweep()');
  const s31 = sql1(`select status from public.rooms where id = '${pub31.id}'`);
  const m31 = sql1(`select count(*)::int as n from public.room_members where room_id = '${pub31.id}'`);
  check('公開・待機31分：自動解散する（信号が新しくても）', s31.status === 'closed', s31.status);
  check('公開・待機31分：メンバーも消える', Number(m31.n) === 0);
  const sPrv = sql1(`select status from public.rooms where id = '${prv31.id}'`);
  check('非公開・待機31分：解散しない', sPrv.status === 'lobby', sPrv.status);
  const s29 = sql1(`select status from public.rooms where id = '${pub29.id}'`);
  check('公開・待機29分：まだ解散しない', s29.status === 'lobby', s29.status);
  for (const r of [pub31, prv31, pub29]) cleanupRoom(r.id);
}

// ================= lobby_since_at の更新（トリガ） =================
{
  const H = await signup('t');
  const room = sql1(`insert into public.rooms (host_id, title, capacity, status)
    values ('${H.id}', '解散検証・時計', 4, 'lobby') returning id, lobby_since_at`);
  check('作成時に待機入り時刻が記録される', !!room.lobby_since_at);
  sql(`update public.rooms set lobby_since_at = now() - interval '31 minutes' where id = '${room.id}'`);
  sql(`update public.rooms set status = 'playing' where id = '${room.id}'`);
  sql(`update public.rooms set status = 'lobby' where id = '${room.id}'`);
  const after = sql1(`select lobby_since_at from public.rooms where id = '${room.id}'`);
  check('待機に戻ると時計は数え直しになる',
    !!after.lobby_since_at && new Date(after.lobby_since_at) > new Date(Date.now() - 60000),
    String(after.lobby_since_at));
  cleanupRoom(room.id);
}

// ================= 実ゲーム後：時計がリセットされる =================
{
  const host = await signup('gh');
  const members = [];
  for (let i = 0; i < 3; i++) members.push(await signup(`gm${i}`));
  const room = await rpc(host, 'ww_create_room', {
    p_title: '解散検証・実ゲーム', p_is_private: false,
    p_beginner_welcome: false, p_reversal_enabled: true, p_capacity: 4, p_genre: null,
  });
  if (room.error) throw new Error(`ルーム作成失敗: ${room.code}`);
  const roomId = room.data.id;
  for (const m of members) await rpc(m, 'ww_join_room', { p_room: roomId });
  for (const m of members) await rpc(m, 'ww_set_ready', { p_room: roomId, p_ready: true });
  // わざと時計を古くしておく（試合が終われば数え直しになるはず）
  sql(`update public.rooms set lobby_since_at = now() - interval '31 minutes' where id = '${roomId}'`);
  const started = await rpc(host, 'ww_start_game', { p_room: roomId });
  if (started.error) throw new Error(`開始失敗: ${started.code}`);
  // 期限切れ＋見回りでフェーズを進め、待機室に戻るまで回す
  let back = false;
  for (let i = 0; i < 14 && !back; i++) {
    sql(`update public.ww_games set phase_deadline_at = now() - interval '1 second'
          where room_id = '${roomId}' and phase <> 'done'`);
    sql('select public.ww_sweep()');
    const r = sql1(`select status from public.rooms where id = '${roomId}'`);
    back = r.status === 'lobby';
    if (!back) await sleepMs(400);
  }
  check('試合が終わると待機室に戻る', back);
  const after = sql1(`select lobby_since_at from public.rooms where id = '${roomId}'`);
  check('試合後は解散時計がリセットされている（31分経っていない）',
    !!after.lobby_since_at && new Date(after.lobby_since_at) > new Date(Date.now() - 120000),
    String(after.lobby_since_at));
  cleanupRoom(roomId);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
