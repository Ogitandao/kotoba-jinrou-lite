// ワードウルフ DB 方式のローカル実証テスト。
//
// docs/wordwolf-db-design.md の設計が、sim/ のインメモリ実装で
// 設計どおりに動くことを示す。実 Supabase には接続しない。
// 実行: npm run verify:wordwolf-db
//
// 検証する性質：
// 1. ボットで1ゲームを完走できる（合図駆動）。ゲーム単位制なので
//    終われば待機室に戻り、改めて準備OK＋開始で次のゲームができる
// 2. 締め切り後の発言・投票は、遷移が未実行でもサーバーが拒否する
// 3. 全員スルー投票＝ウルフ勝ち（no_votes）
// 4. 同票→+60秒延長→再投票、同票のままならウルフ勝ち（tie）
// 5. 逆転回答（6択）：正解=ウルフ逆転勝ち／不正解・時間切れ=市民勝ち
//    ／OFF の部屋では逆転回答フェーズが出ない
// 6. 合図の冪等性：二重合図・早すぎる合図で二重遷移しない
// 7. 見回り（sweep）だけでもゲームが完走する（全員アプリを閉じた想定）
// 8. 秘匿：個人ビューに他人のお題・陣営が混ざらない
// 9. 人数帯の設定値（ウルフ数・話し合い秒数）
// 10. 新開始フロー：満室＋全員の準備OK＋マスター開始の3条件、
//     キック、マスター移譲、all_ready_at の証跡、待機室チャット

import { SimDb } from '../sim/db.mjs';
import { WordWolfDbServer, WW_PHASE, WW_CONFIG } from '../sim/server.mjs';
import { createRng } from '../sim/rng.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function expectError(name, fn, code) {
  try {
    fn();
  } catch (err) {
    check(name, err.code === code, `期待 ${code} / 実際 ${err.code ?? err.message}`);
    return;
  }
  check(name, false, 'エラーになりませんでした');
}

/** 全員（マスター以外）を準備OKにしてマスターが開始する */
function startGameNow(server, room, players) {
  for (const p of players.slice(1)) server.setReady(room.id, p, true);
  return server.startGame(room.id, players[0]);
}

function makeWorld(playerCount, { seed = 42, reversalEnabled = true } = {}) {
  const db = new SimDb();
  const server = new WordWolfDbServer(db, { rng: createRng(seed) });
  const players = Array.from({ length: playerCount }, (_, i) => `user-${i + 1}`);
  const room = server.createRoom({
    hostId: players[0],
    memberIds: players,
    reversalEnabled,
    capacity: playerCount,
  });
  const { set, game } = startGameNow(server, room, players);
  return { db, server, room, set, players, game };
}

/** 締め切りまで時間を進めて合図する（通常のクライアント駆動） */
function advancePhase(db, server, game) {
  const before = game.phase;
  db.advanceTime(Math.max(0, game.phaseDeadlineAt - db.now()) + 0.001);
  return server.signalAdvance(game.id, before);
}

/** 投票フェーズで全員が votes = { voterId: targetId|null } どおり投票する */
function castAllVotes(server, game, votes) {
  for (const [voterId, targetId] of Object.entries(votes)) {
    server.castVote(game.id, voterId, targetId);
  }
}

/** 多数派で狙った相手を追放する投票配分を作る（神視点＝テストリグ） */
function votesToExile(players, targetId, alternativeId) {
  const votes = {};
  players.forEach((p, i) => {
    if (p === targetId) votes[p] = alternativeId;
    else votes[p] = i % 3 === 2 && alternativeId !== targetId ? alternativeId : targetId;
  });
  // targetId が過半数を確実に取るよう調整
  const tally = {};
  for (const t of Object.values(votes)) if (t) tally[t] = (tally[t] ?? 0) + 1;
  if ((tally[targetId] ?? 0) <= (tally[alternativeId] ?? 0)) {
    for (const p of players) {
      if (p !== targetId && p !== alternativeId) votes[p] = targetId;
    }
  }
  return votes;
}

/** 進行中の1ゲームを、ウルフ追放→逆転回答（pickCorrect）まで駆動する */
function playOneGame(db, server, players, game, { pickCorrect = true } = {}) {
  let guard = 0;
  while (game.phase !== WW_PHASE.DONE && guard++ < 100) {
    switch (game.phase) {
      case WW_PHASE.INTRO:
        advancePhase(db, server, game);
        break;
      case WW_PHASE.DISCUSSION:
        for (const p of players) server.postMessage(game.id, p, `発言 from ${p}`);
        advancePhase(db, server, game);
        break;
      case WW_PHASE.VOTING: {
        const secret = server._secretOf(game.id);
        const wolf = secret.wolfIds[0];
        const citizen = players.find((p) => !secret.wolfIds.includes(p));
        castAllVotes(server, game, votesToExile(players, wolf, citizen));
        server.signalAdvance(game.id, WW_PHASE.VOTING);
        break;
      }
      case WW_PHASE.REVERSAL: {
        const view = server.playerView(game.id, game.exiledId);
        const secret = server._secretOf(game.id);
        const choice = pickCorrect
          ? secret.citizenTopic
          : view.reversalChoices.find((c) => c !== secret.citizenTopic);
        server.submitReversal(game.id, game.exiledId, choice);
        break;
      }
      case WW_PHASE.RESULT:
        advancePhase(db, server, game);
        break;
      default:
        break;
    }
  }
  return game;
}

// ============================================================
// 1. 1ゲーム完走＋ゲーム単位制（待機室に戻って次のゲーム）
// ============================================================
console.log('\n[1] 1ゲーム完走＋ゲーム単位制（5人・合図駆動）');
{
  const { db, server, room, set, players, game } = makeWorld(5, { seed: 7 });
  playOneGame(db, server, players, game, { pickCorrect: false });
  const finalSet = server.getSet(set.id);
  check('ゲームのコンテナが finished になった', finalSet.status === 'finished');
  check('ルームが lobby（待機室）に戻った', room.status === 'lobby');
  const results = server.resultsOfSet(set.id);
  check('結果が1ゲーム×5人ぶん記録された', results.length === 5, `実際 ${results.length}`);
  check('勝者が記録されている',
    results.every((r) => r.winner === 'citizens' || r.winner === 'wolves'));
  check('話し合いの発言が記録された（5人以上）', db.tables.messages.length >= 5,
    `実際 ${db.tables.messages.length}`);
  // 終了後は準備OKがリセットされている（次のゲームは改めて準備から）
  const members = [...db.tables.roomMembers.values?.() ?? db.tables.roomMembers]
    .filter((m) => m.roomId === room.id);
  check('終了後は全員の準備OKがリセットされた', members.every((m) => !m.ready));

  // ゲーム単位制：同じルームで改めて準備OK＋開始すれば次のゲームができる
  const second = startGameNow(server, room, players);
  check('待機室から次のゲームを開始できた', !!second.game && second.game.id !== game.id);
  playOneGame(db, server, players, second.game, { pickCorrect: true });
  check('2ゲーム目も finished になった', server.getSet(second.set.id).status === 'finished');
  const total = [...db.tables.results.values?.() ?? db.tables.results].length;
  check('勝敗はゲーム単位で累積した（2ゲーム×5人）', total === 10, `実際 ${total}`);
}

// ============================================================
// 2. 締め切り後の発言・投票の拒否（遷移が未実行でも拒否）
// ============================================================
console.log('\n[2] 締め切り後の拒否');
{
  const { db, server, players, game } = makeWorld(4, { seed: 11 });
  // intro → discussion
  advancePhase(db, server, game);
  check('discussion に入った', game.phase === WW_PHASE.DISCUSSION);
  server.postMessage(game.id, players[0], '締め切り前なのでOK');
  check('締め切り前の発言は受理される', server.messagesOf(game.id).length === 1);
  // 締め切りを過ぎる。合図は送らない＝DB上のフェーズは discussion のまま
  db.advanceTime(game.phaseDeadlineAt - db.now() + 1);
  check('フェーズはまだ discussion（遷移未実行）', game.phase === WW_PHASE.DISCUSSION);
  expectError('締め切り後の発言は DEADLINE_PASSED で拒否',
    () => server.postMessage(game.id, players[1], '遅れた発言'), 'DEADLINE_PASSED');
  check('拒否された発言は記録されていない', server.messagesOf(game.id).length === 1);
  // 投票フェーズへ進めて同じことを確認
  server.signalAdvance(game.id, WW_PHASE.DISCUSSION);
  check('voting に入った', game.phase === WW_PHASE.VOTING);
  server.castVote(game.id, players[0], players[1]);
  db.advanceTime(game.phaseDeadlineAt - db.now() + 1);
  expectError('締め切り後の投票は DEADLINE_PASSED で拒否',
    () => server.castVote(game.id, players[1], players[0]), 'DEADLINE_PASSED');
  expectError('フェーズ違いの発言は INVALID_PHASE で拒否',
    () => server.postMessage(game.id, players[1], '投票中の発言'), 'INVALID_PHASE');
  expectError('二重投票は ALREADY_SUBMITTED で拒否', () => {
    const w = makeWorld(4, { seed: 12 });
    advancePhase(w.db, w.server, w.game); // discussion
    advancePhase(w.db, w.server, w.game); // voting
    w.server.castVote(w.game.id, w.players[0], w.players[1]);
    w.server.castVote(w.game.id, w.players[0], w.players[2]);
  }, 'ALREADY_SUBMITTED');
  expectError('自分への投票は INVALID_TARGET で拒否', () => {
    const w = makeWorld(4, { seed: 13 });
    advancePhase(w.db, w.server, w.game);
    advancePhase(w.db, w.server, w.game);
    w.server.castVote(w.game.id, w.players[0], w.players[0]);
  }, 'INVALID_TARGET');
}

// ============================================================
// 3. 全員スルー＝ウルフ勝ち（no_votes）
// ============================================================
console.log('\n[3] 全員スルー投票');
{
  const { db, server, players, game } = makeWorld(4, { seed: 21 });
  advancePhase(db, server, game); // discussion
  advancePhase(db, server, game); // voting
  const votes = {};
  for (const p of players) votes[p] = null;
  castAllVotes(server, game, votes);
  const r = server.signalAdvance(game.id, WW_PHASE.VOTING);
  check('全員投票完了で早期解決した', r.advanced === true);
  check('ウルフの勝ち', game.winner === 'wolves');
  check('理由は no_votes', game.winReason === 'no_votes');
  check('result フェーズに入った', game.phase === WW_PHASE.RESULT);
}

// ============================================================
// 4. 同票→延長→再投票
// ============================================================
console.log('\n[4] 同票と延長');
{
  const { db, server, players, game } = makeWorld(4, { seed: 31 });
  advancePhase(db, server, game); // discussion
  advancePhase(db, server, game); // voting（ラウンド1）
  const [a, b, c, d] = players;
  castAllVotes(server, game, { [a]: c, [b]: d, [c]: d, [d]: c }); // 2-2 同票
  server.signalAdvance(game.id, WW_PHASE.VOTING);
  check('同票で discussion に戻った（延長）', game.phase === WW_PHASE.DISCUSSION);
  check('vote_round が 2 になった', game.voteRound === 2);
  check('延長は +60秒', game.phaseDeadlineAt - db.now() === WW_CONFIG.extensionSeconds,
    `実際 ${game.phaseDeadlineAt - db.now()}`);
  advancePhase(db, server, game); // voting（ラウンド2）
  castAllVotes(server, game, { [a]: c, [b]: d, [c]: d, [d]: c }); // 再び同票
  server.signalAdvance(game.id, WW_PHASE.VOTING);
  check('再同票でウルフの勝ち', game.winner === 'wolves');
  check('理由は tie', game.winReason === 'tie');
}
{
  // 延長後に決着がつく経路（市民を追放→ウルフ勝ち citizen_exiled）
  const { db, server, players, game } = makeWorld(4, { seed: 32 });
  const secret = server._secretOf(game.id);
  const citizen = players.find((p) => !secret.wolfIds.includes(p));
  const other = players.find((p) => p !== citizen);
  advancePhase(db, server, game);
  advancePhase(db, server, game);
  const [a, b, c, d] = players;
  castAllVotes(server, game, { [a]: c, [b]: d, [c]: d, [d]: c });
  server.signalAdvance(game.id, WW_PHASE.VOTING);
  advancePhase(db, server, game); // 再投票
  castAllVotes(server, game, votesToExile(players, citizen, other));
  server.signalAdvance(game.id, WW_PHASE.VOTING);
  check('延長後に市民を追放→ウルフの勝ち', game.winner === 'wolves' && game.winReason === 'citizen_exiled',
    `実際 ${game.winner}/${game.winReason}`);
}

// ============================================================
// 5. 逆転回答（6択）
// ============================================================
console.log('\n[5] 逆転回答');
function worldWithWolfExiled(seed, reversalEnabled = true) {
  const w = makeWorld(5, { seed, reversalEnabled });
  const secret = w.server._secretOf(w.game.id);
  const wolf = secret.wolfIds[0];
  const citizen = w.players.find((p) => !secret.wolfIds.includes(p));
  advancePhase(w.db, w.server, w.game); // discussion
  advancePhase(w.db, w.server, w.game); // voting
  castAllVotes(w.server, w.game, votesToExile(w.players, wolf, citizen));
  w.server.signalAdvance(w.game.id, WW_PHASE.VOTING);
  return { ...w, wolf, citizen, secret };
}
{
  const { server, game, wolf, secret } = worldWithWolfExiled(41);
  check('ウルフ追放で reversal に入った', game.phase === WW_PHASE.REVERSAL);
  check('追放者はウルフ本人', game.exiledId === wolf);
  const view = server.playerView(game.id, wolf);
  check('候補は6件', view.reversalChoices?.length === 6, `実際 ${view.reversalChoices?.length}`);
  check('候補に市民のお題（正解）が含まれる', view.reversalChoices.includes(secret.citizenTopic));
  check('候補にウルフのお題は含まれない', !view.reversalChoices.includes(secret.wolfTopic));
  const othersView = server.playerView(game.id, game.playerIds.find((p) => p !== wolf));
  check('追放者以外には候補が見えない', othersView.reversalChoices === undefined);
  expectError('追放者以外は逆転回答できない',
    () => server.submitReversal(game.id, game.playerIds.find((p) => p !== wolf), secret.citizenTopic),
    'NOT_EXILED_WOLF');
  const res = server.submitReversal(game.id, wolf, secret.citizenTopic);
  check('正解でウルフの逆転勝ち', res.correct === true && game.winner === 'wolves' && game.winReason === 'reversal');
}
{
  const { server, game, wolf, secret } = worldWithWolfExiled(43);
  const view = server.playerView(game.id, wolf);
  const wrong = view.reversalChoices.find((c) => c !== secret.citizenTopic);
  const res = server.submitReversal(game.id, wolf, wrong);
  check('不正解で市民の勝ち', res.correct === false && game.winner === 'citizens');
}
{
  const { db, server, game } = worldWithWolfExiled(47);
  db.advanceTime(game.phaseDeadlineAt - db.now() + 1);
  server.sweep();
  check('時間切れ（見回り解決）で市民の勝ち', game.winner === 'citizens' && game.reversalOutcome?.timedOut === true);
}
{
  const { server, game } = worldWithWolfExiled(53, false);
  check('逆転回答OFFの部屋では reversal に入らない', game.phase === WW_PHASE.RESULT);
  check('そのまま市民の勝ち（wolf_exiled）', game.winner === 'citizens' && game.winReason === 'wolf_exiled');
}

// ============================================================
// 6. 合図の冪等性
// ============================================================
console.log('\n[6] 合図の冪等性');
{
  const { db, server, game } = makeWorld(4, { seed: 61 });
  const early = server.signalAdvance(game.id, WW_PHASE.INTRO);
  check('締め切り前の合図は not_yet', early.advanced === false && early.reason === 'not_yet');
  check('フェーズは変わっていない', game.phase === WW_PHASE.INTRO && game.phaseVersion === 0);
  db.advanceTime(game.phaseDeadlineAt - db.now() + 0.001);
  const first = server.signalAdvance(game.id, WW_PHASE.INTRO);
  const versionAfterFirst = game.phaseVersion;
  const second = server.signalAdvance(game.id, WW_PHASE.INTRO); // 別クライアントの遅れた合図
  const third = server.signalAdvance(game.id, WW_PHASE.INTRO);
  check('先着の合図で遷移した', first.advanced === true);
  check('後続の合図は already_advanced（エラーにしない）',
    second.advanced === false && second.reason === 'already_advanced' && third.advanced === false);
  check('phase_version は1回だけ増えた', game.phaseVersion === versionAfterFirst && versionAfterFirst === 1);
  check('遷移先は discussion', game.phase === WW_PHASE.DISCUSSION);
}

// ============================================================
// 7. 見回り（sweep）だけでゲーム完走（合図ゼロ）
// ============================================================
console.log('\n[7] sweep のみで完走');
{
  const { db, server, set, players } = makeWorld(6, { seed: 71 });
  let guard = 0;
  while (server.getSet(set.id).status === 'running' && guard++ < 500) {
    const game = server.currentGameOfSet(set.id);
    if (game.phase === WW_PHASE.DISCUSSION) {
      for (const p of players) server.postMessage(game.id, p, 'sweep駆動の発言');
    }
    if (game.phase === WW_PHASE.VOTING) {
      const secret = server._secretOf(game.id);
      const wolf = secret.wolfIds[0];
      const citizen = players.find((p) => !secret.wolfIds.includes(p));
      castAllVotes(server, game, votesToExile(players, wolf, citizen));
      // ここでは合図しない。投票の解決も sweep に委ねる
    }
    if (game.phase === WW_PHASE.REVERSAL) {
      // 誰も回答しない（全員アプリを閉じた想定）→ sweep の時間切れで解決
    }
    db.advanceTime(30); // cron の見回り間隔を模す
    server.sweep();
  }
  check('sweep だけでゲームが finished になった', server.getSet(set.id).status === 'finished');
  check('結果は1ゲーム×6人', server.resultsOfSet(set.id).length === 6,
    `実際 ${server.resultsOfSet(set.id).length}`);
}

// ============================================================
// 8. 秘匿（個人ビュー）
// ============================================================
console.log('\n[8] 秘匿');
{
  const { server, players, game } = makeWorld(5, { seed: 83 });
  const secret = server._secretOf(game.id);
  const wolf = secret.wolfIds[0];
  const citizen = players.find((p) => !secret.wolfIds.includes(p));
  const wolfView = server.playerView(game.id, wolf);
  const citizenView = server.playerView(game.id, citizen);
  check('ウルフには自分のお題だけが見える', wolfView.myTopic === secret.wolfTopic);
  check('市民には自分のお題だけが見える', citizenView.myTopic === secret.citizenTopic);
  check('市民のビューにウルフのお題が混ざらない', !JSON.stringify(citizenView).includes(secret.wolfTopic));
  check('ウルフのビューに市民のお題が混ざらない', !JSON.stringify(wolfView).includes(secret.citizenTopic));
  check('終了前は reveal が無い', wolfView.reveal === undefined && citizenView.reveal === undefined);
  check('終了前は winner が見えない', citizenView.winner === null);
}

// ============================================================
// 9. 人数帯の設定値（8人：ウルフ2人・話し合い480秒）
// ============================================================
console.log('\n[9] 人数帯の設定値');
{
  const { db, server, game } = makeWorld(8, { seed: 97 });
  const secret = server._secretOf(game.id);
  check('8人ではウルフ2人', secret.wolfIds.length === 2);
  advancePhase(db, server, game);
  check('8人の話し合いは480秒', game.phaseDeadlineAt - db.now() === 480,
    `実際 ${game.phaseDeadlineAt - db.now()}`);
  const w5 = makeWorld(5, { seed: 98 });
  advancePhase(w5.db, w5.server, w5.game);
  check('5人の話し合いは300秒', w5.game.phaseDeadlineAt - w5.db.now() === 300,
    `実際 ${w5.game.phaseDeadlineAt - w5.db.now()}`);
}

// ============================================================
// 10. 新開始フロー（満室＋全員準備OK＋マスター開始／キック／移譲／
//     all_ready_at／待機室チャット）
// ============================================================
console.log('\n[10] 新開始フロー');
{
  const db = new SimDb();
  const server = new WordWolfDbServer(db, { rng: createRng(101) });
  const players = ['host', 'p2', 'p3', 'p4'];
  const room = server.createRoom({
    hostId: 'host', memberIds: ['host', 'p2', 'p3'], capacity: 4,
  });
  expectError('満室でないと開始できない（ROOM_NOT_FULL）',
    () => server.startGame(room.id, 'host'), 'ROOM_NOT_FULL');
  server.joinRoom(room.id, 'p4');
  expectError('満室でも満員を超えて入れない（ROOM_FULL）',
    () => server.joinRoom(room.id, 'p5'), 'ROOM_FULL');
  expectError('全員の準備OKがないと開始できない（NOT_ALL_READY）',
    () => server.startGame(room.id, 'host'), 'NOT_ALL_READY');
  server.setReady(room.id, 'p2', true);
  server.setReady(room.id, 'p3', true);
  check('一部未準備では all_ready_at はまだ null', room.allReadyAt === null);
  expectError('マスター以外は開始できない（NOT_HOST）',
    () => server.startGame(room.id, 'p2'), 'NOT_HOST');
  server.setReady(room.id, 'p4', true);
  check('満室＋全員準備OKで all_ready_at が記録された', typeof room.allReadyAt === 'number');
  server.setReady(room.id, 'p4', false);
  check('準備を取り消すと all_ready_at は null に戻る', room.allReadyAt === null);
  server.setReady(room.id, 'p4', true);

  // キック（マスターのみ）
  expectError('マスター以外はキックできない（NOT_HOST）',
    () => server.kickMember(room.id, 'p2', 'p3'), 'NOT_HOST');
  server.kickMember(room.id, 'host', 'p4');
  const afterKick = db.tables.roomMembers.filter((m) => m.roomId === room.id);
  check('キックで対象が退室した', afterKick.length === 3 && !afterKick.some((m) => m.userId === 'p4'));
  check('キックで満室が崩れ all_ready_at は null', room.allReadyAt === null);

  // マスター退室→最古参へ移譲
  server.joinRoom(room.id, 'p4');
  server.leaveRoom(room.id, 'host');
  check('マスター退室で最古参（p2）へ移譲された', room.hostId === 'p2',
    `実際 ${room.hostId}`);

  // 待機室チャット
  const msg = server.postRoomMessage(room.id, 'p2', 'よろしくお願いします');
  check('待機室チャットに投稿できた', server.roomMessagesOf(room.id).length === 1 && msg.body === 'よろしくお願いします');
  expectError('メンバー以外は待機室チャットに投稿できない',
    () => server.postRoomMessage(room.id, 'outsider', '部外者'), 'NOT_A_MEMBER');
}

// ============================================================
// 11. ジャンル表示・選択（2026-11-25 おぎ決定）
// ============================================================
console.log('\n[11] ジャンル（指定ルーム／おまかせ／個人ビュー／不正値）');
{
  // ジャンル指定ルーム：そのジャンルのお題だけが出続ける
  const db1 = new SimDb();
  const server1 = new WordWolfDbServer(db1, { rng: createRng(20261125) });
  const players1 = ['g1', 'g2', 'g3', 'g4'];
  const room1 = server1.createRoom({
    hostId: players1[0], memberIds: players1, capacity: 4, genre: '恋愛',
  });
  check('ルームにジャンルが保持された', room1.genre === '恋愛');
  const cats1 = [];
  for (let i = 0; i < 5; i++) {
    const { game } = startGameNow(server1, room1, players1);
    cats1.push(server1._secretOf(game.id).category);
    const view = server1.playerView(game.id, players1[1]);
    check(`ジャンル指定 ${i + 1} ゲーム目：個人ビューに category が出る`,
      view.category === '恋愛', `実際 ${view.category}`);
    playOneGame(db1, server1, players1, game);
  }
  check('ジャンル指定ルームは5ゲーム全て恋愛のお題だった',
    cats1.every((c) => c === '恋愛'), `実際 ${cats1.join(',')}`);

  // おまかせルーム：ゲームごとにジャンルが変わりうる（固定されない）
  const db2 = new SimDb();
  const server2 = new WordWolfDbServer(db2, { rng: createRng(777) });
  const players2 = ['h1', 'h2', 'h3', 'h4'];
  const room2 = server2.createRoom({
    hostId: players2[0], memberIds: players2, capacity: 4,
  });
  check('おまかせルームの genre は null', room2.genre === null);
  const cats2 = new Set();
  for (let i = 0; i < 24; i++) {
    const { game } = startGameNow(server2, room2, players2);
    cats2.add(server2._secretOf(game.id).category);
    playOneGame(db2, server2, players2, game);
  }
  check('おまかせは24ゲームで複数ジャンルが出た（1ジャンル固定ではない）',
    cats2.size >= 4, `実際 ${cats2.size} 種: ${[...cats2].join(',')}`);

  // 不正なジャンルは弾く
  const db3 = new SimDb();
  const server3 = new WordWolfDbServer(db3, { rng: createRng(1) });
  expectError('存在しないジャンルは作成できない（INVALID_GENRE）',
    () => server3.createRoom({
      hostId: 'x1', memberIds: ['x1', 'x2', 'x3', 'x4'], capacity: 4, genre: '存在しないジャンル',
    }), 'INVALID_GENRE');
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失敗した項目:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
