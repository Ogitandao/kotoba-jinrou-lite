// 新開始フロー＋待機室チャットの実 DB 検証（0014/0015 適用済み
// Supabase に対して実施）。
//
// 2026-11-24 おぎ最終決定（開始フロー）：
// - ルーム作成時に人数（4〜8人）を設定し、満室にならないと開始できない
// - 開始条件＝満室＋マスター以外の全員が「準備OK！」＋マスターが
//   「ゲームスタート！」を押したときだけ
// - マスターは待機室でメンバーをキックできる
// - マスターが退室したら参加順で最古参のメンバーへ移譲する
// - 満室＋全員準備OKが揃った時刻（all_ready_at）を証跡として記録する
// - 待機室にはチャットログがある（メンバーだけが読み書きできる）
// - ゲーム単位制：セットは1ゲームだけのコンテナ（games_per_set=1）
// 実行：npm run verify:startflow-db（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える（test_marker 付き）。
// 開始したゲームは放置されるため、後で見回りにより参加テスト
// ユーザーへ離脱ペナルティが付くことがある（テスト用なので実害なし）。
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
const PASSWORD = 'Lite-E2E-2026-Pass!';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

function sql(q) {
  const out = execFileSync('python3', [HELPER, 'query', REF, q],
    { encoding: 'utf8', timeout: 120000 });
  return JSON.parse(out);
}
function sql1(q) {
  return sql(q)[0] ?? {};
}
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
async function signup(tag) {
  const sb = mkClient();
  const email = `kl.lite.sf.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { test_marker: 'test/lite', display_name: `開始検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  // 0018 以降、ルーム作成・参加にはチュートリアル同意が必須
  await sb.rpc('kl_agree_rules');
  return { sb, id: data.user.id, email };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpcRaw(user, fn, args) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      last = await user.sb.rpc(fn, args);
    } catch (e) {
      last = { data: null, error: e };
    }
    if (!last.error || !/fetch failed/i.test(last.error.message ?? '')) return last;
    await sleepMs(1000 * (i + 1));
  }
  return last;
}
async function rpc(user, fn, args) {
  const { data, error } = await rpcRaw(user, fn, args);
  return { data, error, code: error ? rpcErr(error) : null };
}

// ---------- テストユーザー6名 ----------
const users = {};
for (const t of ['s1', 's2', 's3', 's4', 's5', 's6']) users[t] = await signup(t);
check('テストユーザー6名のサインアップ＋即セッション', Object.keys(users).length === 6);
await sleepMs(500);

const host = users.s1;
// ---------- ルームA：人数4人で作成 ----------
const created = await rpc(host, 'ww_create_room', {
  p_title: '新開始フロー検証ルーム', p_is_private: false, p_capacity: 4,
});
if (created.error) throw new Error(`create_room 失敗: ${created.error.message}`);
const roomId = created.data.id;
check('人数4人でルーム作成', !!roomId
  && sql1(`select capacity from public.rooms where id = '${roomId}'`).capacity === 4);
for (const u of [users.s2, users.s3]) {
  const j = await rpc(u, 'ww_join_room', { p_room: roomId });
  if (j.error) throw new Error(`join_room 失敗: ${j.error.message}`);
}

// ---------- 満室でないと開始できない ----------
{
  const r = await rpc(host, 'ww_start_game', { p_room: roomId });
  check('3/4人では開始できない（ROOM_NOT_FULL）', r.code === 'ROOM_NOT_FULL', r.code ?? 'no error');
}
await rpc(users.s4, 'ww_join_room', { p_room: roomId });

// ---------- 全員の準備OKがないと開始できない ----------
{
  const r = await rpc(host, 'ww_start_game', { p_room: roomId });
  check('満室でも準備OKがなければ開始できない（NOT_ALL_READY）',
    r.code === 'NOT_ALL_READY', r.code ?? 'no error');
  const r2 = await rpc(users.s2, 'ww_start_game', { p_room: roomId });
  check('マスター以外は開始できない（NOT_HOST）', r2.code === 'NOT_HOST', r2.code ?? 'no error');
}
await rpc(users.s2, 'ww_set_ready', { p_room: roomId, p_ready: true });
await rpc(users.s3, 'ww_set_ready', { p_room: roomId, p_ready: true });
{
  const row = sql1(`select all_ready_at from public.rooms where id = '${roomId}'`);
  check('一部未準備では all_ready_at は記録されない', row.all_ready_at === null);
  const r = await rpc(host, 'ww_start_game', { p_room: roomId });
  check('1人でも未準備なら開始できない（NOT_ALL_READY）',
    r.code === 'NOT_ALL_READY', r.code ?? 'no error');
}
await rpc(users.s4, 'ww_set_ready', { p_room: roomId, p_ready: true });
{
  const row = sql1(`select all_ready_at from public.rooms where id = '${roomId}'`);
  check('満室＋全員準備OKで all_ready_at が記録される（証跡）', !!row.all_ready_at);
}

// ---------- 待機室チャット ----------
{
  const post = await rpc(users.s2, 'ww_post_room_message', {
    p_room: roomId, p_body: '待機室チャットの検証です',
  });
  check('待機室チャットに投稿できる', !post.error && post.data?.body === '待機室チャットの検証です',
    post.error?.message ?? '');
  const rows = sql(`select body from public.ww_room_messages where room_id = '${roomId}'`);
  check('待機室チャットが DB に残る', rows.length === 1 && rows[0].body === '待機室チャットの検証です');
  const outsider = await rpc(users.s6, 'ww_post_room_message', {
    p_room: roomId, p_body: '部外者の投稿',
  });
  check('メンバー以外は投稿できない（NOT_A_MEMBER）',
    outsider.code === 'NOT_A_MEMBER', outsider.code ?? 'no error');
}

// ---------- キック ----------
{
  const byMember = await rpc(users.s2, 'ww_kick_member', { p_room: roomId, p_target: users.s3.id });
  check('マスター以外はキックできない（NOT_HOST）',
    byMember.code === 'NOT_HOST', byMember.code ?? 'no error');
  const kicked = await rpc(host, 'ww_kick_member', { p_room: roomId, p_target: users.s4.id });
  const members = sql(`select user_id from public.room_members where room_id = '${roomId}'`);
  check('マスターはキックできる（対象が退室する）',
    !kicked.error && members.length === 3
    && !members.some((m) => m.user_id === users.s4.id), kicked.error?.message ?? '');
  const row = sql1(`select all_ready_at from public.rooms where id = '${roomId}'`);
  check('キックで満室が崩れると all_ready_at は消える', row.all_ready_at === null);
  await rpc(users.s4, 'ww_join_room', { p_room: roomId });
  await rpc(users.s4, 'ww_set_ready', { p_room: roomId, p_ready: true });
}

// ---------- マスター退室→最古参へ移譲 ----------
await rpc(host, 'ww_leave_room', { p_room: roomId });
{
  const row = sql1(`select host_id from public.rooms where id = '${roomId}'`);
  check('マスター退室で最古参（s2）へ移譲される', row.host_id === users.s2.id,
    `host=${row.host_id}`);
}
await rpc(host, 'ww_join_room', { p_room: roomId });
await rpc(host, 'ww_set_ready', { p_room: roomId, p_ready: true });
{
  const row = sql1(`select all_ready_at from public.rooms where id = '${roomId}'`);
  check('移譲後も満室＋全員準備OKで all_ready_at が記録される', !!row.all_ready_at);
}

// ---------- 新マスターが開始 → ゲーム単位（games_per_set=1） ----------
const started = await rpc(users.s2, 'ww_start_game', { p_room: roomId });
check('新マスターが「ゲームスタート！」で開始できる',
  !started.error && !!started.data?.gameId, started.error?.message ?? '');
const gameId = started.data?.gameId;
{
  const roomRow = sql1(`select status from public.rooms where id = '${roomId}'`);
  check('ルームが playing になる', roomRow.status === 'playing', roomRow.status);
  const setRow = sql1(
    `select games_per_set from public.ww_sets where room_id = '${roomId}' order by created_at desc limit 1`);
  check('ゲーム単位制：コンテナは1ゲームだけ（games_per_set=1）',
    setRow.games_per_set === 1, `実際 ${setRow.games_per_set}`);
}

// ---------- 挨拶タイム：お題はまだ渡らない／チャットは使える ----------
const viewIntro = await rpc(users.s3, 'ww_player_view', { p_game: gameId });
check('開始直後は intro（挨拶タイム）', viewIntro.data?.phase === 'intro',
  viewIntro.data?.phase ?? 'なし');
check('挨拶タイム中は自分のお題が渡ってこない（myTopic = null）',
  viewIntro.data?.myTopic === null || viewIntro.data?.myTopic === undefined,
  JSON.stringify(viewIntro.data?.myTopic));
const greet = await rpc(users.s3, 'ww_post_message', {
  p_game: gameId, p_body: 'こんばんは！よろしくね',
});
check('挨拶タイム中もチャットで発言できる', !greet.error, greet.error?.message ?? '');

sql(`update public.ww_games set phase_deadline_at = now() - interval '1 second' where id = '${gameId}'`);
sql('select public.ww_sweep()');
const viewDisc = await rpc(users.s3, 'ww_player_view', { p_game: gameId });
check('話し合いに入ると自分のお題が表示される',
  viewDisc.data?.phase === 'discussion'
  && typeof viewDisc.data?.myTopic === 'string' && viewDisc.data.myTopic.length > 0,
  `phase=${viewDisc.data?.phase} myTopic=${viewDisc.data?.myTopic}`);

// ---------- 定員を超えて入れない ----------
{
  const roomB = await rpc(users.s5, 'ww_create_room', {
    p_title: '定員検証ルーム', p_is_private: false, p_capacity: 4,
  });
  const roomBId = roomB.data.id;
  for (const u of [users.s2, users.s3, users.s4]) {
    await rpc(u, 'ww_join_room', { p_room: roomBId });
  }
  const fifth = await rpc(users.s6, 'ww_join_room', { p_room: roomBId });
  check('満室のルームには入れない（ROOM_FULL）', fifth.code === 'ROOM_FULL',
    fifth.code ?? 'no error');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
