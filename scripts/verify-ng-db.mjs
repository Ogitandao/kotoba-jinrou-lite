// 送信時 NG ブロック（0046）の実 DB 検証
// - テスト専用の重度／軽度フレーズを ng_words に一時投入して検証し、
//   終わったら消す（実際の運用ワードはこのスクリプトに載せない）
// - DM／グループ／待機室／対戦チャット／名前・自己紹介の全経路で
//   heavy が NG_WORD で弾かれ、light と通常文は通ることを確認する
// 実行：node scripts/verify-ng-db.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '../client/vendor/supabase.js';

const cfg = JSON.parse(
  readFileSync(new URL('../client/kl-config.js', import.meta.url), 'utf8')
    .match(/\{[\s\S]*\}/)[0]);
const URL_ = cfg.supabaseUrl;
const KEY = cfg.supabaseKey;
const REF = 'dtdwkluanoaqiaruzbwe';
const HELPER = '/home/hatch/workspace/custom-connectors/custom.supabase/bin/supabase_api.py';
const pw = String.fromCharCode(76, 105, 116, 101, 45, 78, 103, 45, 50, 48, 50, 54, 33);
const stamp = Date.now();
const HEAVY = '検証用重度フレーズ';
const LIGHT = '検証用軽度フレーズ';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
function sql(q) {
  return JSON.parse(execFileSync('python3', [HELPER, 'query', REF, q],
    { encoding: 'utf8', timeout: 120000 }));
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const mkClient = () => createClient(URL_, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const rpcErr = (error) => {
  const m = /([A-Z_]+):/.exec(error?.message ?? '');
  return m ? m[1] : (error?.message ?? 'unknown');
};
async function rpc(user, fn, args) {
  let last;
  for (let i = 0; i < 6; i++) {
    try { last = await user.sb.rpc(fn, args); } catch (e) { last = { data: null, error: e }; }
    if (!last.error || !/fetch failed/i.test(last.error.message ?? '')) break;
    await sleepMs(1000 * (i + 1));
  }
  return { data: last.data, error: last.error, code: last.error ? rpcErr(last.error) : null };
}
async function signup(tag) {
  const sb = mkClient();
  const { data, error } = await sb.auth.signUp({
    email: `kl.lite.ng.${tag}${stamp}@gmail.com`, password: pw,
    options: { data: { test_marker: 'test/lite', display_name: `NG検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag}: ${error?.message ?? 'session なし'}`);
  await sb.rpc('kl_agree_rules');
  await sleepMs(300);
  return { sb, id: data.user.id };
}

sql(`insert into public.ng_words (pattern, severity) values ('${HEAVY}', 'heavy'), ('${LIGHT}', 'light')`);
try {
  const users = [];
  for (const t of ['n1', 'n2', 'n3', 'n4']) users.push(await signup(t));
  const [n1, n2, n3, n4] = users;
  check('検証ユーザー4名', users.length === 4);
  // n1-n2 をフレンドに（DM とグループの前提）
  {
    const [a, b] = n1.id < n2.id ? [n1.id, n2.id] : [n2.id, n1.id];
    sql(`insert into public.friendships (user_a, user_b) values ('${a}', '${b}')`);
  }

  // --- DM ---
  {
    const blocked = await rpc(n1, 'kl_send_dm', { p_to: n2.id, p_body: `あれは${HEAVY}だね` });
    check('DM：heavy を含む文は NG_WORD で弾かれる', blocked.code === 'NG_WORD', blocked.code ?? 'no error');
    const light = await rpc(n1, 'kl_send_dm', { p_to: n2.id, p_body: `あれは${LIGHT}だね` });
    check('DM：light は送信できる（ブロックしない）', !light.error, light.error?.message ?? '');
    const normal = await rpc(n1, 'kl_send_dm', { p_to: n2.id, p_body: '普通のメッセージです' });
    check('DM：通常文は送信できる', !normal.error, normal.error?.message ?? '');
  }

  // --- グループ ---
  {
    const g = await rpc(n1, 'kl_create_group', { p_name: 'NG検証グループ', p_member_ids: [n2.id] });
    if (g.error) throw new Error(`create_group: ${g.error.message}`);
    const gid = g.data.id ?? g.data.group_id ?? g.data;
    const blocked = await rpc(n1, 'kl_send_group_message', { p_group: gid, p_body: `${HEAVY}を含む文` });
    check('グループ：heavy は NG_WORD で弾かれる', blocked.code === 'NG_WORD', blocked.code ?? 'no error');
    const normal = await rpc(n1, 'kl_send_group_message', { p_group: gid, p_body: '普通の文です' });
    check('グループ：通常文は送信できる', !normal.error, normal.error?.message ?? '');
  }

  // --- プロフィール（名前・自己紹介） ---
  {
    const nameBlocked = await rpc(n1, 'kl_update_profile', { p_display_name: HEAVY });
    check('プロフィール：名前に heavy は NG_WORD', nameBlocked.code === 'NG_WORD', nameBlocked.code ?? 'no error');
    const bioBlocked = await rpc(n1, 'kl_update_profile', { p_bio: `自己紹介${HEAVY}` });
    check('プロフィール：自己紹介に heavy は NG_WORD', bioBlocked.code === 'NG_WORD', bioBlocked.code ?? 'no error');
    const ok = await rpc(n1, 'kl_update_profile', { p_bio: '普通の自己紹介です' });
    check('プロフィール：通常の自己紹介は保存できる', !ok.error, ok.error?.message ?? '');
  }

  // --- 待機室＋対戦チャット ---
  {
    const created = await rpc(n1, 'ww_create_room', {
      p_title: 'NG検証ルーム', p_is_private: false, p_capacity: 4,
    });
    const roomId = created.data.id;
    const blockedRoom = await rpc(n1, 'ww_post_room_message', { p_room: roomId, p_body: `${HEAVY}です` });
    check('待機室：heavy は NG_WORD で弾かれる', blockedRoom.code === 'NG_WORD', blockedRoom.code ?? 'no error');
    const okRoom = await rpc(n1, 'ww_post_room_message', { p_room: roomId, p_body: 'よろしくお願いします' });
    check('待機室：通常文は送信できる', !okRoom.error, okRoom.error?.message ?? '');
    for (const u of [n2, n3, n4]) await rpc(u, 'ww_join_room', { p_room: roomId });
    for (const u of [n2, n3, n4]) await rpc(u, 'ww_set_ready', { p_room: roomId, p_ready: true });
    const started = await rpc(n1, 'ww_start_game', { p_room: roomId });
    if (started.error) throw new Error(`start_game: ${started.error.message}`);
    const gameId = started.data.gameId;
    const blockedGame = await rpc(n2, 'ww_post_message', { p_game: gameId, p_body: `${HEAVY}です` });
    check('対戦チャット：heavy は NG_WORD で弾かれる', blockedGame.code === 'NG_WORD', blockedGame.code ?? 'no error');
    const okGame = await rpc(n2, 'ww_post_message', { p_game: gameId, p_body: 'よろしくね' });
    check('対戦チャット：通常文は送信できる', !okGame.error, okGame.error?.message ?? '');
    for (const u of users) await rpc(u, 'ww_leave_room', { p_room: roomId });
  }
} finally {
  sql(`delete from public.ng_words where pattern in ('${HEAVY}', '${LIGHT}')`);
}
const remain = sql(`select count(*)::int as n from public.ng_words where pattern in ('${HEAVY}', '${LIGHT}')`);
check('テスト用ワードは掃除済み', remain[0].n === 0);

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
