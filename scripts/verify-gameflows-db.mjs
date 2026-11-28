// 未確認だったゲームフローと通知の実 DB 検証（2026-11-26）
// - 同票 → +60秒延長 → 再投票 → 再同票でウルフ勝ち（tie）
// - 全員が発言しても投票しなければウルフ勝ち（no_votes）
// - 逆転回答 OFF の部屋ではウルフ追放で即・市民勝ち（reversal を経ない）
// - 8人ではウルフが2人になり、市民追放でウルフ勝ち（citizen_exiled）
// - マスター放置：3回の記録 → sweep で確定し、警告/処分のシステムDMが届く
// - モデレーション：finalize で違反確定 → 処分イベント＋システムDMが届く
// 実行：node scripts/verify-gameflows-db.mjs（client/kl-config.js が必要）
// 注意：実行のたびにテストユーザーが増える（使い捨て前提）
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
const pw = String.fromCharCode(76, 105, 116, 101, 45, 71, 102, 45, 50, 48, 50, 54, 33);
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
function sql(q) {
  const out = execFileSync('python3', [HELPER, 'query', REF, q],
    { encoding: 'utf8', timeout: 120000 });
  return JSON.parse(out);
}
const sql1 = (q) => sql(q)[0] ?? {};
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
  const email = `kl.lite.gf.${tag}${stamp}@gmail.com`;
  let data, error;
  for (let i = 0; i < 4; i++) {
    try {
      ({ data, error } = await sb.auth.signUp({
        email, password: pw,
        options: { data: { test_marker: 'test/lite', display_name: `フロー検証${tag}` } },
      }));
    } catch (e) { error = e; }
    if (!error && data?.session) break;
    await sleepMs(1000 * (i + 1));
  }
  if (error || !data?.session) throw new Error(`signup ${tag} 失敗: ${error?.message ?? 'session なし'}`);
  await sb.rpc('kl_agree_rules');
  await sb.rpc('kl_set_birthdate', { p_birthdate: '1995-01-01' });
  await sleepMs(300);
  return { sb, id: data.user.id, email };
}

// ---------- ゲーム進行ヘルパー ----------
function sweepPast(gameId) {
  sql(`update public.ww_games set phase_deadline_at = now() - interval '1 second' where id = '${gameId}'`);
  sql('select public.ww_sweep()');
}
const gameRow = (gameId) => sql1(
  `select phase, winner, win_reason, exiled_id, extended, vote_round, reversal_choices from public.ww_games where id = '${gameId}'`);
const secrets = (gameId) => sql1(
  `select wolf_ids from public.ww_game_secrets where game_id = '${gameId}'`);

async function startGame(players, { capacity, reversal = true, title }) {
  const host = players[0];
  const created = await rpc(host, 'ww_create_room', {
    p_title: title, p_is_private: false, p_capacity: capacity, p_reversal_enabled: reversal,
  });
  if (created.error) throw new Error(`create_room: ${created.error.message}`);
  const roomId = created.data.id;
  for (const u of players.slice(1)) {
    const j = await rpc(u, 'ww_join_room', { p_room: roomId });
    if (j.error) throw new Error(`join_room: ${j.error.message}`);
  }
  for (const u of players.slice(1)) await rpc(u, 'ww_set_ready', { p_room: roomId, p_ready: true });
  const started = await rpc(host, 'ww_start_game', { p_room: roomId });
  if (started.error) throw new Error(`start_game: ${started.error.message}`);
  return { roomId, gameId: started.data.gameId };
}
async function toDiscussion(gameId) {
  sweepPast(gameId); // intro → discussion
}
async function postAll(players, gameId) {
  for (const u of players) {
    const p = await rpc(u, 'ww_post_message', { p_game: gameId, p_body: 'これは検証用の発言です' });
    if (p.error) throw new Error(`post_message: ${p.error.message}`);
  }
}
async function toVoting(gameId) {
  sweepPast(gameId); // discussion → voting
}
async function vote(user, gameId, target) {
  const v = await rpc(user, 'ww_cast_vote', { p_game: gameId, p_target: target });
  if (v.error) throw new Error(`cast_vote: ${v.error.message}`);
}
async function finishAndLeave(players, roomId, gameId) {
  // result → done（ルームが lobby に戻る）まで進めてから全員退室
  for (let i = 0; i < 3; i++) {
    const g = gameRow(gameId);
    if (g.phase === 'done') break;
    sweepPast(gameId);
  }
  for (const u of players) await rpc(u, 'ww_leave_room', { p_room: roomId });
}

// ---------- ユーザー準備 ----------
const A = [];
for (const t of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']) A.push(await signup(t));
check('検証ユーザー8名（クリーン組）', A.length === 8);
const K = [];
for (const t of ['k1', 'k2', 'k3', 'k4']) K.push(await signup(t));
check('検証ユーザー4名（スキップ組）', K.length === 4);

// ---------- 1) 同票 → 延長 → 再投票 → 再同票 ----------
{
  const players = A.slice(0, 4);
  const { roomId, gameId } = await startGame(players, { capacity: 4, title: '同票検証ルーム' });
  const wolves = secrets(gameId).wolf_ids;
  const citizens = players.filter((u) => !wolves.includes(u.id));
  await toDiscussion(gameId);
  await postAll(players, gameId);
  await toVoting(gameId);
  // 市民2名に2票ずつ（2-2 の同票）。自分には投票できないので割り当てを組む
  const tieVotes = async () => {
    const [c0, c1] = citizens;
    const others = players.filter((p) => p.id !== c0.id && p.id !== c1.id);
    // c0 へは c1 と others[0]、c1 へは c0 と others[1]（自己投票なし・2票ずつ）
    await vote(c1, gameId, c0.id);
    await vote(others[0], gameId, c0.id);
    await vote(c0, gameId, c1.id);
    await vote(others[1], gameId, c1.id);
  };
  await tieVotes();
  // 全員の投票がそろうと締切を待たず即・集計される（ww_cast_vote の早期解決）
  const g1 = gameRow(gameId);
  check('同票で延長に入る（extended・vote_round=2・話し合い60秒へ）',
    g1.extended === true && g1.vote_round === 2 && g1.phase === 'discussion',
    JSON.stringify(g1));
  await toVoting(gameId);
  await tieVotes();
  const g2 = gameRow(gameId);
  check('再同票でウルフ勝ち（win_reason=tie）',
    g2.winner === 'wolves' && g2.win_reason === 'tie', JSON.stringify(g2));
  await finishAndLeave(players, roomId, gameId);
}

// ---------- 2) 全員無投票 → no_votes ----------
{
  const players = K;
  const { roomId, gameId } = await startGame(players, { capacity: 4, title: '無投票検証ルーム' });
  await toDiscussion(gameId);
  await postAll(players, gameId); // 発言はする（投票だけしない）
  await toVoting(gameId);
  sweepPast(gameId); // 誰も投票していない
  const g = gameRow(gameId);
  check('全員無投票でウルフ勝ち（win_reason=no_votes）',
    g.winner === 'wolves' && g.win_reason === 'no_votes', JSON.stringify(g));
  await finishAndLeave(players, roomId, gameId);
}

// ---------- 3) 逆転 OFF：ウルフ追放で即・市民勝ち ----------
{
  const players = A.slice(0, 4);
  const { roomId, gameId } = await startGame(players, {
    capacity: 4, reversal: false, title: '逆転なし検証ルーム',
  });
  const wolves = secrets(gameId).wolf_ids;
  const wolf = players.find((u) => wolves.includes(u.id));
  await toDiscussion(gameId);
  await postAll(players, gameId);
  await toVoting(gameId);
  for (const u of players) await vote(u, gameId, u.id === wolf.id ? players[0].id === wolf.id ? players[1].id : players[0].id : wolf.id);
  sweepPast(gameId);
  const g = gameRow(gameId);
  check('逆転OFFではウルフ追放で即・市民勝ち（reversal を経ない）',
    g.winner === 'citizens' && g.win_reason === 'wolf_exiled' && !g.reversal_choices,
    JSON.stringify(g));
  await finishAndLeave(players, roomId, gameId);
}

// ---------- 4) 8人：ウルフ2人＋市民追放でウルフ勝ち ----------
{
  const players = A;
  const { roomId, gameId } = await startGame(players, { capacity: 8, title: '8人検証ルーム' });
  const wolves = secrets(gameId).wolf_ids;
  check('8人ではウルフが2人', Array.isArray(wolves) && wolves.length === 2,
    JSON.stringify(wolves));
  const citizen = players.find((u) => !wolves.includes(u.id));
  await toDiscussion(gameId);
  await postAll(players, gameId);
  await toVoting(gameId);
  for (const u of players) {
    await vote(u, gameId, u.id === citizen.id
      ? players.find((p) => p.id !== citizen.id && !wolves.includes(p.id)).id
      : citizen.id);
  }
  sweepPast(gameId);
  const g = gameRow(gameId);
  check('市民を追放するとウルフ勝ち（win_reason=citizen_exiled）',
    g.winner === 'wolves' && g.win_reason === 'citizen_exiled' && g.exiled_id === citizen.id,
    JSON.stringify(g));
  await finishAndLeave(players, roomId, gameId);
}

// ---------- 5) マスター放置：3回で確定し DM が届く ----------
// 0063 以降、公開ルームの放置検出はその場でマスターを強制キックするため、
// 同じ部屋では1回しか記録できない。3回ぶんは別々の部屋で発生させる
{
  const host = await signup('s1');
  const fillers = A.slice(0, 3);
  const roomIds = [];
  for (let round = 0; round < 3; round++) {
    const created = await rpc(host, 'ww_create_room', {
      p_title: '放置検証ルーム', p_is_private: false, p_capacity: 4,
    });
    const roomId = created.data.id;
    roomIds.push(roomId);
    for (const u of fillers) await rpc(u, 'ww_join_room', { p_room: roomId });
    for (const u of fillers) await rpc(u, 'ww_set_ready', { p_room: roomId, p_ready: true });
    if (round === 0) {
      const readyRow = sql1(`select all_ready_at from public.rooms where id = '${roomId}'`);
      check('放置検証：満室＋全員準備OKで all_ready_at が立つ', !!readyRow.all_ready_at);
    }
    sql(`update public.rooms set all_ready_at = now() - interval '6 minutes' where id = '${roomId}'`);
    sql('select public.kl__detect_stalls()');
    // 次の部屋に備えて全員退出（ホストはキック済み、残りは新マスターごと抜ける）
    for (const u of fillers) await rpc(u, 'ww_leave_room', { p_room: roomId });
  }
  const recorded = sql(
    `select count(*)::int as n from public.stall_events where room_id in ('${roomIds.join("','")}') and status = 'recorded'`);
  check('放置が3回ぶん記録される', recorded[0].n === 3, JSON.stringify(recorded));
  sql('select public.kl__moderation_sweep()');
  const confirmed = sql(
    `select count(*)::int as n from public.stall_events where room_id in ('${roomIds.join("','")}') and status = 'confirmed'`);
  check('sweep で3回とも確定する（30日で3回のハイブリッド条件）', confirmed[0].n === 3,
    JSON.stringify(confirmed));
  const pen = sql(
    `select kind, minutes from public.penalty_events where user_id = '${host.id}' and kind = 'master_stall'`);
  check('マスター放置のペナルティ記録が残る', pen.length >= 2, JSON.stringify(pen));
  const dm = sql(
    `select count(*)::int as n from public.dm_messages where sender_id is null and recipient_id = '${host.id}' and kind = 'system'`);
  check('マスターにシステムDM（警告または処分通知）が届く', dm[0].n >= 1, JSON.stringify(dm));
  const prof = sql1(`select penalty_until from public.profiles where id = '${host.id}'`);
  check('3回目で利用制限が発動する（penalty_until が未来）',
    !!prof.penalty_until && new Date(prof.penalty_until) > new Date(),
    `penalty_until=${prof.penalty_until}`);
  // 後片付けは各ラウンド内で済ませてある（ホストはキック済み・残りは退出済み）
}

// ---------- 6) モデレーション確定 → 処分DM ----------
{
  const author = await signup('m1');
  const reporter = await signup('m2');
  // DM はフレンド同士のみ（仕様）。検証用にフレンド関係を用意する
  sql(`insert into public.friendships (user_a, user_b) values (least('${author.id}'::uuid, '${reporter.id}'::uuid), greatest('${author.id}'::uuid, '${reporter.id}'::uuid)) on conflict do nothing`);
  const sent = await rpc(author, 'kl_send_dm', { p_to: reporter.id, p_body: '検証用のメッセージです' });
  if (sent.error) throw new Error(`kl_send_dm: ${sent.error.message}`);
  const msgId = sent.data.id;
  const caseRows = sql(
    `insert into public.moderation_cases (target_user_id, surface, target_ref, snapshot_text, report_weight)
     values ('${author.id}', 'dm', '${msgId}', '検証用のメッセージです', 1.0)
     returning id`);
  const caseId = caseRows[0].id;
  sql(`select public.kl__finalize_case('${caseId}', '{"scores": {"harassment": 0.9}, "flagged": {}}'::jsonb)`);
  const c = sql1(`select decision, penalty_event_id from public.moderation_cases where id = '${caseId}'`);
  check('モデレーション：高スコアで違反確定（通常カテゴリ初回は warned）', c.decision === 'warned', JSON.stringify(c));
  check('モデレーション：処分イベントが紐づく', !!c.penalty_event_id);
  const dm = sql(
    `select count(*)::int as n from public.dm_messages where sender_id is null and recipient_id = '${author.id}' and kind = 'system'`);
  check('モデレーション：違反者にシステムDMが届く', dm[0].n >= 1, JSON.stringify(dm));
  const prof = sql1(`select penalty_until from public.profiles where id = '${author.id}'`);
  check('モデレーション：通常カテゴリ初回は警告のみ（利用制限なし）',
    !prof.penalty_until || new Date(prof.penalty_until) <= new Date(),
    `penalty_until=${prof.penalty_until}`);
}

console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} ===`);
process.exit(failures ? 1 : 0);
