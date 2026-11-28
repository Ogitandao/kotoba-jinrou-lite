// ジャンル表示・選択の実 DB 検証（0016 適用済み Supabase に対して実施）。
//
// 2026-11-25 おぎ決定（ジャンル）：
// - ルーム作成時にジャンルを選べる（おまかせ＋お題カテゴリ全19種）
// - ジャンル指定ルーム：そのジャンルのお題だけが出続ける
// - おまかせルーム：ゲームのたびにジャンルがランダムに変わる
//   （カテゴリ抽選→そのカテゴリからペア抽選）
// - ゲーム中は全プレイヤーにジャンルが返る（ww_player_view.category）
// 実行：npm run verify:genre-db（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える（test_marker 付き）。
// 開始したゲームは放置されるため、後で見回りにより参加テスト
// ユーザーへ離脱ペナルティが付くことがある（テスト用なので実害なし）。
// 複数ゲームの確認では、開始済みゲームをオーナー SQL で畳んでから
// 次を開始する（進行そのものは他スイートで検証済み）。
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
  const email = `kl.lite.genre.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email,
    password: 'Lite-E2E-2026-Pass!',
    options: { data: { test_marker: 'test/lite', display_name: `ジャンル検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  // 0018 以降、ルーム作成・参加にはチュートリアル同意が必須
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
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

/** 4人ルームを満室＋全員準備OKにして開始し、gameId を返す */
async function startFullGame(host, members, roomId) {
  for (const u of members) {
    const j = await rpc(u, 'ww_join_room', { p_room: roomId });
    if (j.error) throw new Error(`join 失敗: ${j.error.message}`);
    const r = await rpc(u, 'ww_set_ready', { p_room: roomId, p_ready: true });
    if (r.error) throw new Error(`set_ready 失敗: ${r.error.message}`);
  }
  const s = await rpc(host, 'ww_start_game', { p_room: roomId });
  if (s.error) throw new Error(`start_game 失敗: ${s.error.message}`);
  return s.data.gameId;
}

/** 開始済みゲームを畳んでルームを待機室に戻す（次の開始のため） */
function foldGame(roomId) {
  sql(`update public.ww_games set phase = 'done' where room_id = '${roomId}' and phase <> 'done'`);
  sql(`update public.ww_sets set status = 'finished' where room_id = '${roomId}' and status = 'running'`);
  sql(`update public.rooms set status = 'lobby' where id = '${roomId}'`);
  sql(`update public.room_members set ready = false where room_id = '${roomId}'`);
}

function secretCategory(gameId) {
  return sql1(`select category from public.ww_game_secrets where game_id = '${gameId}'`).category;
}

// ---------- お題プールの前提 ----------
{
  const row = sql1('select count(*)::int as total, count(distinct category)::int as cats from public.ww_topics where active');
  check('お題プールは451組・19カテゴリ', row.total === 451 && row.cats === 19,
    `total=${row.total} cats=${row.cats}`);
}

// ---------- テストユーザー4名 ----------
const users = {};
for (const t of ['a', 'b', 'c', 'd']) users[t] = await signup(t);
check('テストユーザー4名のサインアップ＋即セッション', Object.keys(users).length === 4);
await sleepMs(500);
const host = users.a;
const members = [users.b, users.c, users.d];

// ---------- ジャンル指定ルーム（恋愛）：そのジャンルだけ出続ける ----------
{
  const created = await rpc(host, 'ww_create_room', {
    p_title: '検証（恋愛）', p_is_private: false, p_capacity: 4, p_genre: '恋愛',
  });
  if (created.error) throw new Error(`create_room 失敗: ${created.error.message}`);
  const roomId = created.data.id;
  check('ジャンル指定でルーム作成でき、rooms.genre に保存される',
    sql1(`select genre from public.rooms where id = '${roomId}'`).genre === '恋愛');

  const list = await rpc(host, 'ww_list_rooms');
  const mine = (list.data ?? []).find((r) => r.id === roomId);
  check('ww_list_rooms に genre が含まれる', mine?.genre === '恋愛', `genre=${mine?.genre}`);

  const cats = [];
  for (let i = 0; i < 3; i++) {
    const gameId = await startFullGame(host, members, roomId);
    cats.push(secretCategory(gameId));
    if (i === 0) {
      const view = await rpc(host, 'ww_player_view', { p_game: gameId });
      check('ww_player_view に category が返る（挨拶フェーズ）',
        !view.error && view.data?.category === '恋愛',
        view.error?.message ?? `category=${view.data?.category}`);
    }
    foldGame(roomId);
  }
  check('ジャンル指定ルームは3ゲーム全て恋愛のお題だった',
    cats.every((c) => c === '恋愛'), `実際 ${cats.join(',')}`);
}

// ---------- おまかせルーム：ジャンルが固定されない ----------
{
  const cats = new Set();
  for (let i = 0; i < 6; i++) {
    const created = await rpc(host, 'ww_create_room', {
      p_title: `検証（おまかせ${i + 1}）`, p_is_private: false, p_capacity: 4,
    });
    if (created.error) throw new Error(`create_room 失敗: ${created.error.message}`);
    const roomId = created.data.id;
    if (i === 0) {
      check('おまかせルームの rooms.genre は NULL',
        sql1(`select genre from public.rooms where id = '${roomId}'`).genre === null);
    }
    const gameId = await startFullGame(host, members, roomId);
    cats.add(secretCategory(gameId));
    foldGame(roomId);
  }
  check('おまかせは6ゲームで複数ジャンルが出た（1ジャンル固定ではない）',
    cats.size >= 2, `実際 ${cats.size} 種: ${[...cats].join(',')}`);
}

// ---------- 不正なジャンルは弾く ----------
{
  const r = await rpc(host, 'ww_create_room', {
    p_title: '検証（不正）', p_is_private: false, p_capacity: 4, p_genre: '存在しないジャンル',
  });
  check('存在しないジャンルは作成できない（INVALID_GENRE）',
    r.code === 'INVALID_GENRE', r.code ?? 'no error');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
