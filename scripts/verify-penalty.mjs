// ペナルティ（離脱・放置／投票スルー／段階計算）の sim 検証。
//
// 計画書「ペナルティ」節（2026-11-24 おぎ確定）のうち、自動化対象の
// 離脱・放置系トラックを sim/server.mjs（＝実 DB 0010/0013/0014 の
// 移植元）で検証する。実行: npm run verify:penalty
//
// 検証する性質：
// (a) ハートビート途絶→猶予2分以内の復帰は無罪
// (b) 猶予超過→離脱確定→対戦強制終了→完了ゲームの勝敗は保持
// （ゲーム単位制：完了済みゲームは前ゲームのもの）
// (c) 違反ポイント制：発言あり＋未投票=0.5（記録のみ）、
// ルーム滞在中の合計1.0到達で強制退室＋階段適用＋システムDM
// （ポイントはゲームをまたいで累積し、退室でリセット）
// (d) 制限中は参加・作成を拒否（PENALTY_ACTIVE）、期限切れで解除
// (e) 段階の時間計算（階段値・上限・30日ごとの段階的軽減・
// ゼロリセットなし）
// (f) 発言0＋未投票=1.0で即退室／発言0＋投票あり=0.5、
// 異種ポイントの合算でも1.0到達で退室

import { SimDb} from '../sim/db.mjs';
import { WordWolfDbServer, WW_PHASE} from '../sim/server.mjs';
import { createRng} from '../sim/rng.mjs';
import { PENALTY, ladderMinutes, nextStepFor} from '../sim/penalty.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
if (cond) {
passed += 1;
console.log(` ✓ ${name}`);
} else {
failed += 1;
failures.push(name);
console.log(` ✗ ${name}${detail? ` — ${detail}`: ''}`);
}
}

function expectError(name, fn, code) {
try {
fn();
} catch (err) {
check(name, err.code === code, `期待 ${code} / 実際 ${err.code?? err.message}`);
return;
}
check(name, false, 'エラーになりませんでした');
}

function makeWorld(playerCount, { seed = 42} = {}) {
const db = new SimDb();
const server = new WordWolfDbServer(db, { rng: createRng(seed)});
const players = Array.from({ length: playerCount}, (_, i) => `user-${i + 1}`);
const room = server.createRoom({
hostId: players[0], memberIds: players, capacity: playerCount,
});
const w = { db, server, room, players, set: null, game: null};
startNextGame(w);
return w;
}

/** 待機室で全員（マスター以外）が準備OK→マスター開始。w.set/w.game を更新 */
function startNextGame(w) {
const { server, room, players} = w;
for (const p of players.slice(1)) server.setReady(room.id, p, true);
const { set, game} = server.startGame(room.id, players[0]);
w.set = set;
w.game = game;
return game;
}

function beat(server, roomId, ids) {
for (const id of ids) server.heartbeat(roomId, id);
}

function advancePhase(db, server, game) {
const before = game.phase;
db.advanceTime(Math.max(0, game.phaseDeadlineAt - db.now()) + 0.001);
return server.signalAdvance(game.id, before);
}

/** w.set の現在のゲームを result まで進める。votePlan(game) が投票フェーズで呼ばれる */
function driveToResult(w, votePlan) {
const { db, server, set} = w;
let guard = 0;
while (guard++ < 30) {
const game = server.currentGameOfSet(set.id);
if (game.phase === WW_PHASE.RESULT || game.phase === WW_PHASE.DONE) return game;
if (game.phase === WW_PHASE.VOTING) {
votePlan(game);
const r = server.signalAdvance(game.id, WW_PHASE.VOTING);
if (!r.advanced) {
db.advanceTime(game.phaseDeadlineAt - db.now() + 0.001);
server.sweep();
}
} else if (game.phase === WW_PHASE.REVERSAL) {
const secret = server._secretOf(game.id);
const view = server.playerView(game.id, game.exiledId);
const wrong = view.reversalChoices.find((c) => c!== secret.citizenTopic);
server.submitReversal(game.id, game.exiledId, wrong);
} else {
advancePhase(db, server, game);
}
}
throw new Error('driveToResult: ガード超過');
}

/** 全員が target を指す投票（target 本人は subTarget へ） */
function votesFor(players, target, subTarget) {
const votes = {};
for (const p of players) votes[p] = p === target? subTarget: target;
return votes;
}
function castVotes(server, game, votes) {
for (const [voter, target] of Object.entries(votes)) {
server.castVote(game.id, voter, target);
}
}

// ============================================================
// (e) 段階の時間計算（純粋関数）
// ============================================================
console.log('\n[e] 段階の時間計算');
{
check('階段：1時間→3時間→6時間→12時間→24時間',
[1, 2, 3, 4, 5].map((s) => ladderMinutes('afk', s)).join(',') === '60,180,360,720,1440');
check('5段目以降は24時間で頭打ち', ladderMinutes('afk', 6) === 1440 && ladderMinutes('afk', 99) === 1440);
check('嫌がらせ系は別トラック（7日→30日→無期限）',
ladderMinutes('harassment', 1) === 10080
&& ladderMinutes('harassment', 2) === 43200
&& ladderMinutes('harassment', 3) === -1);
check('猶予は2分', PENALTY.heartbeatGraceSec === 120);

const day = 86400;
check('履歴なしは1段目', nextStepFor([], 'afk', 0).step === 1);
const ev3 = [{ track: 'afk', step: 3, minutes: 360, atSec: 0}];
check('30日経過で1段軽減（3段→次は3段目）', nextStepFor(ev3, 'afk', 31 * day).step === 3);
check('60日経過で2段軽減（3段→次は2段目）', nextStepFor(ev3, 'afk', 61 * day).step === 2);
check('どれだけ経ってもゼロには戻らない（次は最低2段目）',
nextStepFor(ev3, 'afk', 3650 * day).step === 2);
const ev5 = [{ track: 'afk', step: 5, minutes: 1440, atSec: 0}];
check('上限段の次も上限（24時間）', nextStepFor(ev5, 'afk', 10).minutes === 1440);
check('トラックは混ざらない（afk履歴はharassmentに影響しない）',
nextStepFor(ev3, 'harassment', 0).step === 1);
}

// ============================================================
// (a) 猶予内の復帰は無罪
// ============================================================
console.log('\n[a] ハートビート猶予');
{
const w = makeWorld(4, { seed: 101});
const { db, server, room, set, players} = w;
const skipper = players[3];
const others = players.slice(0, 3);
beat(server, room.id, players);
expectError('非メンバーのハートビートは NOT_A_MEMBER',
() => server.heartbeat(room.id, 'outsider'), 'NOT_A_MEMBER');

// skipper だけ途絶。60秒時点ではまだ猶予内
db.advanceTime(60);
beat(server, room.id, others);
server.sweep();
check('途絶60秒では離脱にならない', server.getSet(set.id).status === 'running');
check('ペナルティ記録も無い', server.penaltyEventsOf(skipper).length === 0);

// 100秒時点で復帰（ハートビート再開）→ その後も無罪のまま
db.advanceTime(40);
beat(server, room.id, players);
db.advanceTime(100);
beat(server, room.id, players);
server.sweep();
check('猶予内に復帰すれば無罪（対戦継続）', server.getSet(set.id).status === 'running');
check('全員ペナルティなし', players.every((p) => server.penaltyEventsOf(p).length === 0));
}

// ============================================================
// (b) 猶予超過→離脱確定→対戦強制終了→完了ゲームの勝敗保持
// ============================================================
console.log('\n[b] 離脱確定と対戦強制終了');
{
const w = makeWorld(4, { seed: 102});
const { db, server, room, players} = w;
const set1 = w.set;
const leaver = players[3];
const others = players.slice(0, 3);
beat(server, room.id, players);

// ゲーム1を正常に完了させる（全員発言＋全員投票）
for (const p of players) server.postMessage(w.game.id, p, 'よろしくお願いします');
const g1 = driveToResult(w, (game) => {
beat(server, room.id, players);
castVotes(server, game, votesFor(players, players[1], players[2]));
});
check('ゲーム1が完了した', g1.phase === WW_PHASE.RESULT);
check('ゲーム1の結果が4人分ある', server.resultsOfSet(set1.id).length === 4);
advancePhase(db, server, g1); // result 終了 → 待機室へ戻る
check('ゲーム1のコンテナは finished', server.getSet(set1.id).status === 'finished');
check('ルームは待機室（lobby）に戻った', room.status === 'lobby');

// 待機室からゲーム2を開始する
const g2 = startNextGame(w);
const set2 = w.set;
check('ゲーム2が始まっている', g2.phase === WW_PHASE.INTRO && g2.id!== g1.id);
beat(server, room.id, players);

// ゲーム2で leaver だけが途絶する
db.advanceTime(60);
beat(server, room.id, others);
server.sweep();
check('途絶60秒ではまだ終了しない', server.getSet(set2.id).status === 'running');
db.advanceTime(70); // 合計130秒 > 猶予120秒
beat(server, room.id, others);
server.sweep();

const finalSet = server.getSet(set2.id);
check('ゲーム2の対戦が terminated になった', finalSet.status === 'terminated');
check('終了理由は abandon', finalSet.terminatedReason === 'abandon');
check('対象者が terminatedUserIds に入る',
finalSet.terminatedUserIds?.includes(leaver) === true);
check('ルームは lobby に戻った', room.status === 'lobby');
check('離脱者はルームメンバーから外れた',
!db.tables.roomMembers.some((m) => m.roomId === room.id && m.userId === leaver));
check('残り3人はメンバーに残っている',
others.every((p) => db.tables.roomMembers.some((m) => m.roomId === room.id && m.userId === p)));

const events = server.penaltyEventsOf(leaver);
check('離脱ペナルティが1件記録された', events.length === 1 && events[0].kind === 'abandon');
check('初回は1段目・60分', events[0]?.step === 1 && events[0]?.minutes === 60);
check('強制退室フラグつき', events[0]?.forcedRemoval === true);
const until = server.penaltyUntilOf(leaver);
check('制限終了は約60分後', until!== null && until - db.now() > 3500 && until - db.now() <= 3600,
`until-now=${until - db.now()}`);

check('完了済みゲーム1の勝敗は保持された（4人分）',
server.resultsOfSet(set1.id).length === 4);
check('進行中だったゲーム2の結果は無い（無効）',
server.resultsOfSet(set2.id).length === 0);
check('ゲーム2は done で勝者なし', g2.phase === WW_PHASE.DONE && g2.winner === null);

const logs = server.messagesOf(g2.id).filter((m) => m.kind === 'system');
check('ルーム内システムログが2件流れた', logs.length === 2, `実際 ${logs.length}`);
check('強制退室ログ（詳細理由なし）',
logs.some((m) => m.body.includes('強制退室となりました') && m.body.includes(leaver)));
check('対戦終了案内（勝敗有効の旨）',
logs.some((m) => m.body.includes('対戦は終了しました') && m.body.includes('勝敗は記録されています')));

const dms = server.systemDmsOf(leaver);
check('本人へシステムDMが届いた', dms.length === 1);
check('DMに理由・制限時間・累積の旨が入る',
dms[0]?.body.includes('離脱と判定されました')
&& dms[0]?.body.includes('今回の制限：1時間')
&& dms[0]?.body.includes('制限時間は長くなります'));
check('他メンバーにペナルティは無い',
others.every((p) => server.penaltyEventsOf(p).length === 0));
const view = server.playerView(g2.id, others[0]);
check('個人ビューに setStatus=terminated が出る', view.setStatus === 'terminated');
}

// ============================================================
// (c) 投票スルー（発言あり）：0.5ポイント×2回で1.0到達→強制退室
// ポイント制（2026-11-24 おぎ確定）：1回目はポイント記録のみで
// 制限もDMも発生しない。ポイントはゲームをまたいでルーム滞在中
// 累積し、2回目で合計1.0→階段1件（1段目・60分）
// ============================================================
console.log('\n[c] 投票スルー（ポイント制・ルーム滞在中累積）');
let worldC;
{
const w = makeWorld(4, { seed: 103});
worldC = w;
const { db, server, room, players} = w;
const set1 = w.set;
const skipper = players[3];
const speakAll = (game) => {
for (const p of players) server.postMessage(game.id, p, 'よろしくお願いします');
};

// ゲーム1：全員発言あり。skipper は明示的にスルー（棄権票）。他3人は投票
speakAll(w.game);
const g1 = driveToResult(w, (game) => {
const votes = votesFor(players, players[1], players[2]);
votes[skipper] = null;
castVotes(server, game, votes);
});
const ev1 = server.penaltyEventsOf(skipper);
check('スルー1回目はポイント記録のみ（vote_skip・0.5）',
ev1.length === 1 && ev1[0].kind === 'vote_skip' && ev1[0].points === 0.5);
check('1回目では制限は発生しない（minutes=0・penaltyUntilなし）',
ev1[0]?.minutes === 0 && server.penaltyUntilOf(skipper) === null);
check('1回目ではDMも届かない', server.systemDmsOf(skipper).length === 0);
check('ゲーム1は正常終了する', server.getSet(set1.id).status === 'running');
check('skipper はまだメンバー', db.tables.roomMembers.some(
(m) => m.roomId === room.id && m.userId === skipper));

advancePhase(db, server, g1); // result 終了 → 待機室へ
check('ゲーム1のコンテナは finished（ポイントは保持）',
server.getSet(set1.id).status === 'finished'
&& server._pointsInRoom(skipper, room.id) === 0.5);

// ゲーム2：全員発言あり。skipper は今度は投票そのものをしない（時間切れで解決）
const g2 = startNextGame(w);
const set2 = w.set;
speakAll(g2);
driveToResult(w, (game) => {
const votes = votesFor(players, players[1], players[2]);
delete votes[skipper];
castVotes(server, game, votes);
});
const ev2 = server.penaltyEventsOf(skipper);
check('スルー2回目でポイントが累積（0.5+0.5・ゲームをまたぐ）',
ev2.filter((e) => e.points > 0).length === 2);
const applied = ev2.filter((e) => e.minutes > 0);
check('合計1.0到達でペナルティ適用は1件（1段目・60分・強制退室）',
applied.length === 1 && applied[0].step === 1 && applied[0].minutes === 60
&& applied[0].forcedRemoval === true, JSON.stringify(applied));
check('制限は今回分のみ（残り約60分）',
server.penaltyUntilOf(skipper) - db.now() > 59 * 60
&& server.penaltyUntilOf(skipper) - db.now() <= 60 * 60,
`残り=${server.penaltyUntilOf(skipper) - db.now()}秒`);
check('ゲーム2の結果発表までは対戦継続（退室は結果終了時に確定）',
server.getSet(set2.id).status === 'running');

advancePhase(db, server, g2); // result 終了 → 強制退室＋対戦終了が確定
const finalSet = server.getSet(set2.id);
check('ゲーム2の対戦が terminated になった', finalSet.status === 'terminated');
check('終了理由は rule_violation', finalSet.terminatedReason === 'rule_violation');
check('skipper は退室させられた',!db.tables.roomMembers.some(
(m) => m.roomId === room.id && m.userId === skipper));
check('ルームは lobby に戻った', room.status === 'lobby');
check('完了した2ゲーム分の結果は保持（4+4人分）',
server.resultsOfSet(set1.id).length === 4
&& server.resultsOfSet(set2.id).length === 4,
`実際 ${server.resultsOfSet(set1.id).length}+${server.resultsOfSet(set2.id).length}`);
const logs = server.messagesOf(g2.id).filter((m) => m.kind === 'system');
check('ゲーム2のチャットにシステムログ（強制退室＋終了案内）',
logs.some((m) => m.body.includes('強制退室となりました'))
&& logs.some((m) => m.body.includes('対戦は終了しました')));
const dms = server.systemDmsOf(skipper);
check('システムDMは1通（強制退室の通知のみ）', dms.length === 1);
check('DMに強制退室の旨', dms[0]?.body.includes('強制退室となりました'));
check('発言＋投票した3人に違反記録は無い',
players.slice(0, 3).every((p) => server.penaltyEventsOf(p).length === 0));
}

// ============================================================
// (f) 発言ゼロ系のポイント（新ルール）
// (f1) 発言0＋未投票 → 1.0ポイントで即退室＋対戦終了
// (f2) 発言0＋投票あり（0.5）と発言あり＋未投票（0.5）の
// 異種合算でも1.0到達で退室する（ゲームをまたいで累積）
// ============================================================
console.log('\n[f] 発言ゼロ＋未投票は一発退室（ポイント制）');
{
// ---- (f1) ----
const w = makeWorld(4, { seed: 105});
const { db, server, room, players} = w;
const set1 = w.set;
const silent = players[3];
for (const p of players.slice(0, 3)) server.postMessage(w.game.id, p, 'よろしくお願いします');
const g1 = driveToResult(w, (game) => {
const votes = votesFor(players, players[1], players[2]);
delete votes[silent];
castVotes(server, game, votes);
});
const ev = server.penaltyEventsOf(silent);
check('f1: silent_no_vote の1.0ポイントが記録された',
ev.some((e) => e.kind === 'silent_no_vote' && e.points === 1.0), JSON.stringify(ev));
const applied = ev.filter((e) => e.minutes > 0);
check('f1: その場でペナルティ適用（1段目・60分・強制退室）',
applied.length === 1 && applied[0].step === 1 && applied[0].minutes === 60
&& applied[0].forcedRemoval === true, JSON.stringify(applied));
check('f1: 結果発表までは対戦継続', server.getSet(set1.id).status === 'running');
advancePhase(db, server, g1);
check('f1: 対戦が terminated', server.getSet(set1.id).status === 'terminated');
check('f1: silent は退室させられた',!db.tables.roomMembers.some(
(m) => m.roomId === room.id && m.userId === silent));
check('f1: そのゲームの結果も加算されている（4人分）',
server.resultsOfSet(set1.id).length === 4,
`実際 ${server.resultsOfSet(set1.id).length}`);
const logs = server.messagesOf(g1.id).filter((m) => m.kind === 'system');
check('f1: ルームにシステムログ（強制退室）',
logs.some((m) => m.body.includes('強制退室となりました')));
const dms = server.systemDmsOf(silent);
check('f1: システムDMに「発言も投票もなかったため」',
dms.length === 1 && dms[0].body.includes('発言も投票もなかったため'),
dms[0]?.body?? 'DMなし');
check('f1: 発言＋投票した3人に違反記録は無い',
players.slice(0, 3).every((p) => server.penaltyEventsOf(p).length === 0));
}
{
// ---- (f2) ----
const w = makeWorld(4, { seed: 106});
const { db, server, room, players} = w;
const set1 = w.set;
const target = players[3];
const others = players.slice(0, 3);
const speakOthers = (game) => {
for (const p of others) server.postMessage(game.id, p, 'よろしくお願いします');
};
// ゲーム1：target は発言0だが投票する → silent_play 0.5（退室しない）
speakOthers(w.game);
const g1 = driveToResult(w, (game) => {
castVotes(server, game, votesFor(players, players[1], players[2]));
});
const ev1 = server.penaltyEventsOf(target);
check('f2: 発言0＋投票ありは silent_play 0.5 のみ（適用なし）',
ev1.length === 1 && ev1[0].kind === 'silent_play' && ev1[0].points === 0.5
&& server.penaltyUntilOf(target) === null, JSON.stringify(ev1));
check('f2: ゲーム1は正常終了し target も残る',
server.getSet(set1.id).status === 'running'
&& db.tables.roomMembers.some((m) => m.roomId === room.id && m.userId === target));
advancePhase(db, server, g1); // 待機室へ（ポイントは滞在中保持）
// ゲーム2：target は発言するが投票しない → vote_skip 0.5、合計1.0で退室
const g2 = startNextGame(w);
const set2 = w.set;
speakOthers(g2);
server.postMessage(g2.id, target, '今度は話します');
driveToResult(w, (game) => {
const votes = votesFor(players, players[1], players[2]);
delete votes[target];
castVotes(server, game, votes);
});
const ev2 = server.penaltyEventsOf(target);
const applied = ev2.filter((e) => e.minutes > 0);
check('f2: 異種ポイントの合算1.0でペナルティ適用（1段目・60分・強制退室）',
applied.length === 1 && applied[0].minutes === 60 && applied[0].forcedRemoval === true,
JSON.stringify(ev2));
advancePhase(db, server, g2);
check('f2: 対戦 terminated＋target 退室',
server.getSet(set2.id).status === 'terminated'
&&!db.tables.roomMembers.some((m) => m.roomId === room.id && m.userId === target));
check('f2: 2ゲーム分の結果は保持（4+4人分）',
server.resultsOfSet(set1.id).length === 4
&& server.resultsOfSet(set2.id).length === 4);
}

// ============================================================
// (d) 制限中の参加・作成拒否
// ============================================================
console.log('\n[d] 制限中の拒否');
{
const { db, server, players} = worldC;
const skipper = players[3];
const other = players[0];
check('制限中である', server.penaltyUntilOf(skipper)!== null);
expectError('制限中の参加は PENALTY_ACTIVE',
() => server.assertJoinable(skipper), 'PENALTY_ACTIVE');
expectError('制限中のルーム作成は PENALTY_ACTIVE',
() => server.createRoom({ hostId: skipper, memberIds: [skipper]}), 'PENALTY_ACTIVE');
const room2 = server.createRoom({ hostId: other, memberIds: [other]});
expectError('制限中の他ルーム参加も PENALTY_ACTIVE',
() => server.joinRoom(room2.id, skipper), 'PENALTY_ACTIVE');
check('制限のないユーザーは参加できる',!!server.joinRoom(room2.id, players[1]));

// 制限時間を過ぎれば参加できる
db.advanceTime(25 * 3600);
check('期限切れで制限は解除される', server.penaltyUntilOf(skipper) === null);
server.assertJoinable(skipper);
check('解除後は参加できる',!!server.joinRoom(room2.id, skipper));
}

// ============================================================
// (e2) 段階の適用（サーバー経由：軽減と上限）
// ============================================================
console.log('\n[e2] 段階の適用（サーバー）');
{
const { db, server} = makeWorld(4, { seed: 104});
const user = 'decay-user';
// 4段目（12時間）を過去に受けた履歴を直接置く
db.tables.penalties.push({
userId: user, track: 'afk', kind: 'abandon', roomId: null, setId: null,
gameId: null, step: 4, minutes: 720, penaltyUntilSec: 0, forcedRemoval: true, atSec: 0,
});
const day = 86400;
db.advanceTime(31 * day);
const applied1 = server._applyPenalty(user, {
kind: 'abandon', reasonText: 'テスト',
});
check('30日経過で1段軽減して適用（4段→次は4段目・12時間）',
applied1.step === 4 && applied1.minutes === 720,
`step=${applied1.step} minutes=${applied1.minutes}`);
db.advanceTime(61 * day);
const applied2 = server._applyPenalty(user, {
kind: 'abandon', reasonText: 'テスト',
});
check('さらに60日経過で2段軽減（4段→次は3段目・6時間）',
applied2.step === 3 && applied2.minutes === 360,
`step=${applied2.step} minutes=${applied2.minutes}`);
}

console.log(`\n結果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
console.log('失敗した項目:');
for (const f of failures) console.log(` - ${f}`);
process.exit(1);
}
