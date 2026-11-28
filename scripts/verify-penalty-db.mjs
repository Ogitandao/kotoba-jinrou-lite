// ペナルティの実 DB 検証（0010/0013/0014 適用済み Supabase に対して実施）。
//
// 実 JWT（通常サインアップ、autoconfirm 前提）で RPC を実利用し、
// 時間経過の再現（締め切り・ハートビートの巻き戻し）と集計確認は
// オーナー SQL（Management API）で行う。
// 実行：npm run verify:penalty-db（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える（test_marker 付き）。
// シナリオCのゲームは放置されるため、終了後に pg_cron の見回りで
// 参加者へ離脱ペナルティが付く（テストユーザーなので実害なし）。
//
// ゲーム単位制（0014〜）：1ゲームごとに完結し、違反ポイントは
// ルーム滞在中に累積する（room_members.violation_points）。
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
  const email = `kl.lite.pen.${tag}${stamp}@gmail.com`;
  const { data, error } = await sb.auth.signUp({
    email,
    password: PASSWORD,
    options: { data: { test_marker: 'test/lite', display_name: `ペナルティ検証${tag}` } },
  });
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  // 0018 以降、ルーム作成・参加にはチュートリアル同意が必須
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  return { sb, id: data.user.id, email };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
/** 一時的な fetch 失敗だけリトライする（RPC の業務エラーはリトライしない）。
 * supabase-js はネットワーク失敗を例外ではなく error.message として返す */
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
async function view(user, gameId) {
  const { data, error } = await rpcRaw(user, 'ww_player_view', { p_game: gameId });
  if (error) throw new Error(`player_view 失敗: ${error.message}`);
  return data;
}
function expirePhase(gameId) {
  sql(`update public.ww_games set phase_deadline_at = now() - interval '1 second' where id = '${gameId}'`);
}
function sweep() {
  sql('select public.ww_sweep()');
}
/** 指定フェーズまで（締め切り巻き戻し＋sweepで）進める */
async function driveToPhase(user, gameId, target) {
  for (let i = 0; i < 12; i++) {
    const v = await view(user, gameId);
    if (v.phase === target) return v;
    if (v.phase === 'done') throw new Error(`driveToPhase: done に到達（目標 ${target}）`);
    expirePhase(gameId);
    sweep();
  }
  throw new Error(`driveToPhase: ${target} に到達できませんでした`);
}
async function finishIfReversal(exiledUser, gameId) {
  const v = await view(exiledUser, gameId);
  if (v.phase !== 'reversal') return v;
  const choice = v.reversalChoices?.[0];
  await rpc(exiledUser, 'ww_submit_reversal', { p_game: gameId, p_choice: choice });
  return view(exiledUser, gameId);
}
async function heartbeatAll(users, roomId) {
  for (const u of users) await rpc(u, 'ww_heartbeat', { p_room: roomId });
}
/** 待機室から1ゲームを開始する（全員準備OK→マスター開始） */
async function startNextGame(users, roomId) {
  const host = users[0];
  for (const u of users.slice(1)) {
    const r = await rpc(u, 'ww_set_ready', { p_room: roomId, p_ready: true });
    if (r.error) throw new Error(`set_ready 失敗: ${r.error.message}`);
  }
  const started = await rpc(host, 'ww_start_game', { p_room: roomId });
  if (started.error) throw new Error(`start_game 失敗: ${started.error.message}`);
  return { setId: started.data.setId, gameId: started.data.gameId };
}
async function makeGame(users) {
  const host = users[0];
  const created = await rpc(host, 'ww_create_room', {
    p_title: 'ペナルティ検証ルーム', p_is_private: false, p_capacity: users.length,
  });
  if (created.error) throw new Error(`create_room 失敗: ${created.error.message}`);
  const roomId = created.data.id;
  for (const u of users.slice(1)) {
    const j = await rpc(u, 'ww_join_room', { p_room: roomId });
    if (j.error) throw new Error(`join_room 失敗: ${j.error.message}`);
  }
  await heartbeatAll(users, roomId);
  const { setId, gameId } = await startNextGame(users, roomId);
  return { roomId, setId, gameId };
}

// ---------- テストユーザー8名 ----------
const tags = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
const users = {};
for (const t of tags) users[t] = await signup(t);
check('テストユーザー8名のサインアップ＋即セッション', Object.keys(users).length === 8);
await new Promise((r) => setTimeout(r, 500));

// ============================================================
// シナリオA：離脱確定→対戦強制終了→完了ゲームの勝敗保持
// （ゲーム単位制：完了済みゲームは前ゲームのもの）
// ============================================================
console.log('\n--- シナリオA：離脱 ---');
{
  const group = [users.p1, users.p2, users.p3, users.p4];
  const leaver = users.p4;
  const { roomId, setId, gameId } = await makeGame(group);
  const set1 = setId;

  // ゲーム1：全員投票して完了させる（p3 を追放）
  await driveToPhase(users.p1, gameId, 'voting');
  await rpc(users.p1, 'ww_cast_vote', { p_game: gameId, p_target: users.p3.id });
  await rpc(users.p2, 'ww_cast_vote', { p_game: gameId, p_target: users.p3.id });
  await rpc(users.p3, 'ww_cast_vote', { p_game: gameId, p_target: users.p2.id });
  await rpc(users.p4, 'ww_cast_vote', { p_game: gameId, p_target: users.p3.id });
  await finishIfReversal(users.p3, gameId);
  const v1 = await view(users.p1, gameId);
  check('A: ゲーム1が result になった', v1.phase === 'result', v1.phase);
  const r1 = sql1(`select count(*)::int as n from public.ww_results where set_id = '${set1}'`);
  check('A: ゲーム1の結果が4人分ある', r1.n === 4, `n=${r1.n}`);

  // result 終了 → 待機室へ戻る（次ゲームは作られない）
  expirePhase(gameId);
  sweep();
  const stA = sql1(`
    select (select status from public.ww_sets where id = '${set1}') as set_status,
           (select status from public.rooms where id = '${roomId}') as room_status`);
  check('A: ゲーム1のコンテナは finished', stA.set_status === 'finished', stA.set_status);
  check('A: ルームは待機室（lobby）に戻った', stA.room_status === 'lobby', stA.room_status);

  // 待機室からゲーム2を開始する
  const g2 = await startNextGame(group, roomId);
  const set2 = g2.setId;
  check('A: 待機室からゲーム2を開始できた', Boolean(g2.gameId) && g2.gameId !== gameId);
  await heartbeatAll(group, roomId);
  // leaver のハートビートだけを200秒前に巻き戻し、見回りで判定させる
  sql(`update public.room_members set last_heartbeat_at = now() - interval '200 seconds'
        where room_id = '${roomId}' and user_id = '${leaver.id}'`);
  sweep();

  const s = sql1(`
    select
      (select status from public.ww_sets where id = '${set2}') as set_status,
      (select status from public.rooms where id = '${roomId}') as room_status,
      (select count(*)::int from public.ww_results where set_id = '${set1}') as results_g1,
      (select count(*)::int from public.ww_results where set_id = '${set2}') as results_g2,
      (select count(*)::int from public.penalty_events where user_id = '${leaver.id}' and kind = 'abandon') as ev_n,
      (select step from public.penalty_events where user_id = '${leaver.id}' and kind = 'abandon' limit 1) as ev_step,
      (select minutes from public.penalty_events where user_id = '${leaver.id}' and kind = 'abandon' limit 1) as ev_minutes,
      (select forced_removal from public.penalty_events where user_id = '${leaver.id}' and kind = 'abandon' limit 1) as ev_forced,
      (select penalty_until > now() from public.profiles where id = '${leaver.id}') as penalized,
      (select count(*)::int from public.dm_messages where recipient_id = '${leaver.id}' and kind = 'system') as dm_n,
      (select count(*)::int from public.ww_messages where game_id = '${g2.gameId}' and kind = 'system') as log_n,
      (select count(*)::int from public.room_members where room_id = '${roomId}' and user_id = '${leaver.id}') as leaver_member
  `);
  check('A: ゲーム2の対戦が terminated', s.set_status === 'terminated', s.set_status);
  check('A: ルームは lobby に戻った', s.room_status === 'lobby', s.room_status);
  check('A: 完了済みゲーム1の勝敗は保持（結果4件のまま）', s.results_g1 === 4, `n=${s.results_g1}`);
  check('A: 進行中ゲーム2の結果は無い（無効）', s.results_g2 === 0, `n=${s.results_g2}`);
  check('A: 離脱ペナルティ記録（1段目・60分・強制退室）',
    s.ev_n === 1 && s.ev_step === 1 && s.ev_minutes === 60 && s.ev_forced === true,
    JSON.stringify(s));
  check('A: penalty_until が未来（制限中）', s.penalized === true);
  check('A: 本人へシステムDMが届いた', s.dm_n >= 1, `n=${s.dm_n}`);
  check('A: ゲーム2のチャットにシステムログが2件以上', s.log_n >= 2, `n=${s.log_n}`);
  check('A: 離脱者はメンバーから外れた', s.leaver_member === 0);
}

// ============================================================
// シナリオB：違反ポイント制（発言あり＋未投票=0.5、合計1.0で退室）
// ポイントはルーム滞在中に累積（ゲームをまたぐ）。
// 1回目=ポイント記録のみ（制限・DMなし）、2回目=合計1.0到達で
// 強制退室＋ペナルティ適用1件（1段目・60分）
// ============================================================
console.log('\n--- シナリオB：投票スルー（ポイント制） ---');
{
  const group = [users.p5, users.p6, users.p7, users.p8];
  const skipper = users.p8;
  const { roomId, setId, gameId } = await makeGame(group);
  const set1 = setId;
  const speakAll = async (gid) => {
    for (const u of group) {
      await rpc(u, 'ww_post_message', { p_game: gid, p_body: 'よろしくお願いします' });
    }
  };

  // ゲーム1：全員発言あり。skipper は明示的にスルー（p_target=null）
  await driveToPhase(users.p5, gameId, 'discussion');
  await speakAll(gameId);
  await driveToPhase(users.p5, gameId, 'voting');
  await rpc(users.p5, 'ww_cast_vote', { p_game: gameId, p_target: users.p7.id });
  await rpc(users.p6, 'ww_cast_vote', { p_game: gameId, p_target: users.p7.id });
  await rpc(users.p7, 'ww_cast_vote', { p_game: gameId, p_target: users.p6.id });
  await rpc(skipper, 'ww_cast_vote', { p_game: gameId, p_target: null });
  await finishIfReversal(users.p7, gameId);
  const ev1 = sql1(`select step, minutes, points, forced_removal from public.penalty_events
                     where user_id = '${skipper.id}' and kind = 'vote_skip'`);
  check('B: スルー1回目はポイント記録のみ（0.5・制限なし）',
    Number(ev1.points) === 0.5 && ev1.minutes === 0 && ev1.forced_removal === false,
    JSON.stringify(ev1));
  const pu1 = sql1(`select penalty_until > now() as active from public.profiles where id = '${skipper.id}'`);
  check('B: 1回目では penalty_until は立たない', pu1.active !== true);
  const st1 = sql1(`select status from public.ww_sets where id = '${set1}'`);
  check('B: ゲーム1は正常に終わる（result 中は running）', st1.status === 'running', st1.status);

  // result 終了 → 待機室へ。ポイントは滞在中保持される
  expirePhase(gameId);
  sweep();
  const vp = sql1(`select violation_points from public.room_members
                    where room_id = '${roomId}' and user_id = '${skipper.id}'`);
  check('B: ポイントはルーム滞在中保持（violation_points=0.5）',
    Number(vp.violation_points) === 0.5, JSON.stringify(vp));
  const stF = sql1(`select status from public.ww_sets where id = '${set1}'`);
  check('B: ゲーム1のコンテナは finished', stF.status === 'finished', stF.status);

  // ゲーム2：全員発言あり。skipper は投票しない（締め切りで解決）
  const g2 = await startNextGame(group, roomId);
  const set2 = g2.setId;
  await driveToPhase(users.p5, g2.gameId, 'discussion');
  await speakAll(g2.gameId);
  await driveToPhase(users.p5, g2.gameId, 'voting');
  await rpc(users.p5, 'ww_cast_vote', { p_game: g2.gameId, p_target: users.p7.id });
  await rpc(users.p6, 'ww_cast_vote', { p_game: g2.gameId, p_target: users.p7.id });
  await rpc(users.p7, 'ww_cast_vote', { p_game: g2.gameId, p_target: users.p6.id });
  expirePhase(g2.gameId);
  sweep();
  await finishIfReversal(users.p7, g2.gameId);
  const v2 = await view(users.p5, g2.gameId);
  check('B: ゲーム2は result（退室確定はこの後）', v2.phase === 'result', v2.phase);
  const ev2 = sql1(`select step, minutes, forced_removal from public.penalty_events
                     where user_id = '${skipper.id}' and kind = 'vote_skip' and minutes > 0
                     order by created_at desc limit 1`);
  check('B: 合計1.0到達でペナルティ適用1件（1段目・60分・強制退室）',
    ev2.step === 1 && ev2.minutes === 60 && ev2.forced_removal === true, JSON.stringify(ev2));
  const st2 = sql1(`select status from public.ww_sets where id = '${set2}'`);
  check('B: result 中はまだ対戦継続', st2.status === 'running', st2.status);

  // result 終了 → 強制退室＋対戦終了が確定
  expirePhase(g2.gameId);
  sweep();
  const s = sql1(`
    select
      (select status from public.ww_sets where id = '${set2}') as set_status,
      (select count(*)::int from public.ww_results r
         join public.ww_games g on g.id = r.game_id
        where g.room_id = '${roomId}') as results_total,
      (select count(*)::int from public.ww_messages where game_id = '${g2.gameId}' and kind = 'system') as log_n,
      (select count(*)::int from public.dm_messages where recipient_id = '${skipper.id}' and kind = 'system') as dm_n,
      (select count(*)::int from public.room_members where room_id = '${roomId}' and user_id = '${skipper.id}') as skipper_member,
      (select penalty_until > now() from public.profiles where id = '${skipper.id}') as penalized
  `);
  check('B: ゲーム2の対戦が terminated', s.set_status === 'terminated', s.set_status);
  check('B: 完了した2ゲーム分の結果は保持（8件）', s.results_total === 8, `n=${s.results_total}`);
  check('B: ゲーム2のチャットにシステムログ', s.log_n >= 2, `n=${s.log_n}`);
  check('B: システムDMは1通（強制退室の通知のみ）', s.dm_n === 1, `n=${s.dm_n}`);
  check('B: skipper は退室させられた', s.skipper_member === 0);
  check('B: 制限中である（penalty_until が未来）', s.penalized === true);

  // (d) 制限中の参加・作成拒否
  const createBlocked = await rpc(skipper, 'ww_create_room', { p_title: '作れない部屋' });
  check('B: 制限中のルーム作成は PENALTY_ACTIVE', createBlocked.code === 'PENALTY_ACTIVE',
    createBlocked.code ?? 'エラーなし');
  const joinBlocked = await rpc(skipper, 'ww_join_room', { p_room: roomId });
  check('B: 制限中のルーム参加は PENALTY_ACTIVE', joinBlocked.code === 'PENALTY_ACTIVE',
    joinBlocked.code ?? 'エラーなし');
  const okCreate = await rpc(users.p5, 'ww_create_room', { p_title: '通常ユーザーは作れる' });
  check('B: 制限のないユーザーは作成できる', !okCreate.error, okCreate.error?.message ?? '');
}

// ============================================================
// シナリオD：段階計算（定数・軽減・ガード）
// ============================================================
console.log('\n--- シナリオD：段階計算 ---');
{
  const lad = sql1(`select public.kl_penalty_minutes('afk', 1) as a1,
      public.kl_penalty_minutes('afk', 2) as a2, public.kl_penalty_minutes('afk', 3) as a3,
      public.kl_penalty_minutes('afk', 4) as a4, public.kl_penalty_minutes('afk', 5) as a5,
      public.kl_penalty_minutes('afk', 8) as a8, public.kl_penalty_minutes('harassment', 1) as h1,
      public.kl_penalty_minutes('harassment', 3) as h3`);
  check('D: 階段は 60/180/360/720/1440、上限で頭打ち',
    lad.a1 === 60 && lad.a2 === 180 && lad.a3 === 360 && lad.a4 === 720
    && lad.a5 === 1440 && lad.a8 === 1440, JSON.stringify(lad));
  check('D: 嫌がらせ系は別トラック（7日／無期限）', lad.h1 === 10080 && lad.h3 === -1);

  // 31日前に3段目を受けたユーザー → 軽減で次は3段目（360分）
  sql(`insert into public.penalty_events (user_id, track, kind, step, minutes, created_at)
       values ('${users.p6.id}', 'afk', 'abandon', 3, 360, now() - interval '31 days')`);
  const ap1 = sql1(`select public.kl__apply_penalty('${users.p6.id}', 'afk', 'abandon',
    null, null, null, false, '検証用') as r`);
  check('D: 30日経過で1段軽減（3段→次も3段目・360分）',
    ap1.r?.step === 3 && ap1.r?.minutes === 360, JSON.stringify(ap1.r));

  // 400日前に5段目を受けたユーザー → 軽減してもゼロには戻らず次は2段目
  sql(`insert into public.penalty_events (user_id, track, kind, step, minutes, created_at)
       values ('${users.p7.id}', 'afk', 'abandon', 5, 1440, now() - interval '400 days')`);
  const ap2 = sql1(`select public.kl__apply_penalty('${users.p7.id}', 'afk', 'abandon',
    null, null, null, false, '検証用') as r`);
  check('D: 長期経過でもゼロリセットなし（次は2段目・180分）',
    ap2.r?.step === 2 && ap2.r?.minutes === 180, JSON.stringify(ap2.r));

  // クライアントからの penalty_until 直接変更はトリガで巻き戻される
  const before = sql1(`select penalty_until from public.profiles where id = '${users.p6.id}'`);
  await users.p6.sb.from('profiles').update({ penalty_until: null }).eq('id', users.p6.id);
  const after = sql1(`select penalty_until from public.profiles where id = '${users.p6.id}'`);
  check('D: penalty_until の直接変更は巻き戻される',
    before.penalty_until !== null && after.penalty_until === before.penalty_until);
}

// ============================================================
// シナリオE：発言0＋未投票は一発退室（【9】ポイント制・実DB）
// ============================================================
console.log('\n--- シナリオE：発言ゼロ＋未投票 ---');
{
  const eTags = ['e1', 'e2', 'e3', 'e4'];
  const eUsers = {};
  for (const t of eTags) eUsers[t] = await signup(t);
  const group = [eUsers.e1, eUsers.e2, eUsers.e3, eUsers.e4];
  const silent = eUsers.e4;
  const { roomId, setId, gameId } = await makeGame(group);

  // silent 以外は発言＋投票。silent は何もしない（時間切れで解決）
  await driveToPhase(eUsers.e1, gameId, 'discussion');
  for (const u of group.slice(0, 3)) {
    await rpc(u, 'ww_post_message', { p_game: gameId, p_body: 'よろしくお願いします' });
  }
  await driveToPhase(eUsers.e1, gameId, 'voting');
  await rpc(eUsers.e1, 'ww_cast_vote', { p_game: gameId, p_target: eUsers.e3.id });
  await rpc(eUsers.e2, 'ww_cast_vote', { p_game: gameId, p_target: eUsers.e3.id });
  await rpc(eUsers.e3, 'ww_cast_vote', { p_game: gameId, p_target: eUsers.e2.id });
  expirePhase(gameId);
  sweep();
  await finishIfReversal(eUsers.e3, gameId);
  const v1 = await view(eUsers.e1, gameId);
  check('E: ゲーム1は result になった', v1.phase === 'result', v1.phase);

  const ev = sql1(`
    select
      (select count(*)::int from public.penalty_events
        where user_id = '${silent.id}' and kind = 'silent_no_vote' and minutes = 0 and points = 1.0) as point_n,
      (select count(*)::int from public.penalty_events
        where user_id = '${silent.id}' and kind = 'silent_no_vote' and minutes > 0
          and step = 1 and minutes = 60 and forced_removal) as applied_n,
      (select count(*)::int from public.dm_messages
        where recipient_id = '${silent.id}' and kind = 'system'
          and body like '%発言も投票もなかったため%') as dm_n,
      (select count(*)::int from public.penalty_events
        where user_id in ('${eUsers.e1.id}', '${eUsers.e2.id}', '${eUsers.e3.id}')) as others_ev_n
  `);
  check('E: silent_no_vote の1.0ポイント行がある', ev.point_n === 1, JSON.stringify(ev));
  check('E: ペナルティ適用1件（1段目・60分・強制退室）', ev.applied_n === 1, JSON.stringify(ev));
  check('E: システムDMに「発言も投票もなかったため」', ev.dm_n === 1, JSON.stringify(ev));
  check('E: 発言＋投票した3人に違反記録は無い', ev.others_ev_n === 0, JSON.stringify(ev));

  // result 終了 → 強制退室＋対戦終了
  expirePhase(gameId);
  sweep();
  const s = sql1(`
    select
      (select status from public.ww_sets where id = '${setId}') as set_status,
      (select count(*)::int from public.ww_results where set_id = '${setId}') as results_total,
      (select count(*)::int from public.ww_messages where game_id = '${gameId}' and kind = 'system') as log_n,
      (select count(*)::int from public.room_members where room_id = '${roomId}' and user_id = '${silent.id}') as silent_member
  `);
  check('E: 対戦が terminated', s.set_status === 'terminated', s.set_status);
  check('E: そのゲームの結果も加算されている（4件）', s.results_total === 4, `n=${s.results_total}`);
  check('E: チャットにシステムログ（強制退室＋終了案内）', s.log_n >= 2, `n=${s.log_n}`);
  check('E: silent は退室させられた', s.silent_member === 0);
}

// ============================================================
// シナリオC：猶予内の復帰は無罪（最後に実行：ゲームを放置するため）
// ============================================================
console.log('\n--- シナリオC：猶予内復帰 ---');
{
  const group = [users.p1, users.p2, users.p3, users.p5];
  const { roomId, setId } = await makeGame(group);
  // p3 のハートビートを60秒前に巻き戻して見回り → 猶予内なので無罪
  sql(`update public.room_members set last_heartbeat_at = now() - interval '60 seconds'
        where room_id = '${roomId}' and user_id = '${users.p3.id}'`);
  sweep();
  let st = sql1(`select status from public.ww_sets where id = '${setId}'`);
  check('C: 途絶60秒では離脱にならない', st.status === 'running', st.status);
  // 200秒前に巻き戻しても、本人が復帰（ハートビート）してから見回れば無罪
  sql(`update public.room_members set last_heartbeat_at = now() - interval '200 seconds'
        where room_id = '${roomId}' and user_id = '${users.p3.id}'`);
  await rpc(users.p3, 'ww_heartbeat', { p_room: roomId });
  sweep();
  st = sql1(`select status from public.ww_sets where id = '${setId}'`);
  // ポイント行（minutes=0）は「適用」ではないので、適用済み行だけ数える
  // （p3 はシナリオAで発言0＋投票ありの silent_play 0.5 を持っている）
  const ev = sql1(`select count(*)::int as n from public.penalty_events where user_id = '${users.p3.id}' and minutes > 0`);
  check('C: 猶予超過前に復帰すれば無罪（ペナルティ適用なし）', st.status === 'running' && ev.n === 0,
    `status=${st.status} applied=${ev.n}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
