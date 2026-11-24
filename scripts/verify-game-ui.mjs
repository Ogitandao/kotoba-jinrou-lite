// 対戦画面（待機室→対戦→結果→待機室へ戻る）の jsdom 検証（SimBackend）
// 実行: node scripts/verify-game-ui.mjs
//
// 2026-11-24 おぎの実機フィードバック反映分の検証を含む：
// [1] 自分の吹き出し幅（CSS）／[10] 吹き出し幅は日本語15文字／行基準（CSS）
// [2] 試合中に待機室へ戻る導線がない
// [4] 挨拶タイム（お題は話し合いまで出ない）
// [5] 投票UIにスルーボタンがない
// [6] フェーズ切替で見切れないための高さ設計（CSS）
// [7] 投票・結果フェーズでは参加者アイコン帯を出さない
// [8] 無発言警告バナー（発言0件＋残り1分未満で表示、発言で消える）
// [9] 発言0＋未投票は一発退室（対戦強制終了＋システムDM）
// [11] プレイヤー番号バッジ（参加順・名前が出る場所に一貫表示）
// [12] 結果の説明文は2行（1行目=決着理由、2行目=お題開示）
//
// 2026-11-24 夜の新仕様（ゲーム単位制＋新開始フロー）の検証：
// [13] 開始条件＝満室＋マスター以外の全員の準備OK＋マスターの開始。
// カウントダウン方式は廃止（要素自体がない）
// [14] ゲーム終了後は終了パネルから「待機室に戻る」「ロビーに戻る」
// [15] 待機室チャット（ゲーム前・ゲーム間の雑談）
// [16] マスターのキック（待機室のみ・キック後は満室でなくなり開始不可）
// [17] ルーム作成時の人数選択（4〜8人）
// [18] 丸ゴシック M PLUS Rounded 1c の採用（CDNリンク＋CSS）
// [19] ジャンル表示・選択（2026-11-25 おぎ決定）：作成時にジャンルを
// 選べる／カード・待機室に対象ジャンル表示／対戦中は全フェーズで
// ジャンル表示（挨拶タイム中も）
//
// 2026-11-25 バッチの検証：
// [20] DM招待カードの発行（待機室の「友達を招待」→フレンド選択→
// DM に招待カード。パスワード照合・フレンド確認はサーバー判定）
// [21] オンラインバッジ（緑ドット）は待機室・対戦画面に出ない
// （2026-11-25 おぎ。出す場所はロビーの友達帯と DM 画面だけ）
// [22] チュートリアル（2026-11-25 おぎ承認）：初回入室で5枚スライドの
// モーダルが強制表示され、キャンセルでは入室できず再表示される。
// 同意ボタンは最後のスライドのみ。旧ルール同意ポップアップは廃止
import { readFileSync} from 'node:fs';
import path from 'node:path';
import { fileURLToPath} from 'node:url';
import { JSDOM} from 'jsdom';
import { loadTopics} from '../sim/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'client');

const results = [];
function check(name, cond, detail = '') {
results.push({ name, ok:!!cond, detail});
console.log(`${cond? 'PASS': 'FAIL'} ${name}${cond? '': ' — ' + detail}`);
}

const html = readFileSync(path.join(client, 'index.html'), 'utf8');
const css = readFileSync(path.join(client, 'styles.css'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true});
const { window} = dom;
const { document} = window;

for (const rel of ['js/dummy-data.js', 'js/data-adapter.js', 'js/app.js']) {
window.eval(readFileSync(path.join(client, rel), 'utf8'));
}
document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true}));

const $ = (id) => document.getElementById(id);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const sleep = tick;
const visible = (el) => el &&!el.classList.contains('hidden');
const KL = () => window.KL_DATA;

/** 実時間で条件が真になるまで待つ（ポーリング追従用） */
async function waitFor(fn, timeoutMs = 6000, stepMs = 150) {
const start = Date.now();
while (Date.now() - start < timeoutMs) {
if (fn()) return true;
await sleep(stepMs);
}
return fn();
}

/** CSS の単一ルールを取り出す。'.dm-msg' が '.dm-msgs-inner' に
部分一致しないよう、セレクタ直後の文字が英数字・ハイフンで
ない出現箇所を採用し、そこから最初の {} を返す */
function cssRule(selector) {
let idx = css.indexOf(selector);
while (idx >= 0) {
const next = css[idx + selector.length]?? '';
if (!/[\w-]/.test(next)) {
const open = css.indexOf('{', idx);
const close = css.indexOf('}', open);
return css.slice(open, close + 1);
}
idx = css.indexOf(selector, idx + 1);
}
return '';
}

// ============ CSS検証（[1][6][10][18]：jsdomにレイアウトエンジンが無いため
// ルール文字列での確認。実機の見え方は最終確認待ち） ============
check('[10] DM吹き出しは日本語15文字／行基準（calc(15em）',
cssRule('.dm-msg').includes('calc(15em'), cssRule('.dm-msg'));
check('[1][10] 対戦の自分の吹き出しも同じ15文字基準で、%の二重掛けをしていない',
cssRule('.game-msg-row .dm-msg').includes('calc(15em')
&&!cssRule('.game-msg-row .dm-msg').includes('max-width: 78%'),
cssRule('.game-msg-row .dm-msg'));
check('[6] チャット領域は min-height: 0 で縮められる（パネルがはみ出さない）',
cssRule('.game-messages').includes('min-height: 0'), cssRule('.game-messages'));
check('[6] 投票・結果パネルに高さ上限があり、内部スクロールで吸収する',
cssRule('.game-panel').includes('max-height')
&& cssRule('#game-vote-list').includes('overflow-y: auto'),
cssRule('.game-panel'));
check('[11] 番号バッジのスタイル（小さい四角）がある',
cssRule('.no-badge').includes('border-radius')
&& cssRule('.no-badge').includes('font-weight: 800'), cssRule('.no-badge'));
check('[18] 丸ゴシック M PLUS Rounded 1c を読み込む（Google Fonts CDN）',
html.includes('fonts.googleapis.com') && html.includes('M PLUS Rounded 1c'),
'index.html にフォントリンクがない');
check('[18] body のフォントに M PLUS Rounded 1c が入っている',
css.includes('font-family: "M PLUS Rounded 1c"'), 'styles.css の font-family');
check('お題テキストの大きな文字スタイルが当たる（topic-words クラス一致）',
html.includes('id="game-my-topic" class="topic-words"')
&& cssRule('.topic-words').includes('font-size: 26px'),
cssRule('.topic-words'));

await tick(60);

// ============ 共通ヘルパー ============
/** 結果発表までプレイヤーとして操作して進める（同票延長・逆転回答対応） */
async function waitForResult(maxRounds = 16) {
for (let i = 0; i < maxRounds; i++) {
if (visible($('game-result-panel')) && $('game-result-banner').textContent.length > 0) return true;
const label = $('game-phase-label').textContent;
if (label.includes('話し合い')) {
KL().__simAdvanceTime(400);
await sleep(750);
} else if (label.includes('投票')) {
const b = document.querySelector('#game-vote-list .vote-btn:not(:disabled)');
if (b) b.click();
await sleep(850);
} else if (visible($('game-reversal-panel'))) {
const c = document.querySelector('#game-reversal-choices .reversal-choice');
if (c) c.click();
await sleep(850);
} else {
await sleep(700);
}
}
return visible($('game-result-panel')) && $('game-result-banner').textContent.length > 0;
}

/** 1ゲームを発言＋投票しながら完走し、終了パネルが出るまで進める */
async function playOutGame(maxRounds = 60) {
let posted = false;
for (let i = 0; i < maxRounds; i++) {
if (visible($('game-end-panel'))) return true;
const vb = document.querySelector('#game-vote-list .vote-btn:not(:disabled)');
if (visible($('game-vote-panel')) && vb) {
vb.click();
await sleep(700);
continue;
}
const rc = document.querySelector('#game-reversal-choices .reversal-choice');
if (visible($('game-reversal-panel')) && rc) {
rc.click();
await sleep(700);
continue;
}
if (!posted && visible($('game-input-row')) &&!$('game-input').disabled) {
posted = true;
$('game-input').value = '様子を見ています';
$('game-send').click();
await sleep(350);
continue;
}
KL().__simAdvanceTime(600);
await sleep(700);
}
return visible($('game-end-panel'));
}

const roomCard = (roomId) => [...document.querySelectorAll('#room-list .room-card')]
.find((c) => c.dataset.roomId === roomId);

// ============ フローA：入室→待機室チャット→準備OK→自動開始→対戦→待機室へ ============
check('ロビーにルームカードがある',
await waitFor(() =>!!document.querySelector('#room-list .room-card'), 4000));
const firstCard = document.querySelector('#room-list .room-card');
firstCard.click();
await tick(30);
check('初回入室ではチュートリアルが出て、待機室はまだ開かない',
visible($('modal-tutorial')) &&!visible($('room-screen')));
check('チュートリアルに遊び方とペナルティの概要が入っている',
$('modal-tutorial').textContent.includes('ペナルティ')
&& $('modal-tutorial').textContent.includes('離脱'));
check('最初のスライドでは同意ボタンが出ない',
!visible($('btn-tutorial-agree')));
$('btn-tutorial-cancel').click();
await tick(30);
check('同意しないと入室できない',!visible($('room-screen')));
firstCard.click();
await tick(30);
check('キャンセルしても未同意のまま、入室を試みると再表示される',
visible($('modal-tutorial')));
for (let i = 0; i < 4; i++) $('btn-tutorial-next').click();
check('最後のスライドで同意ボタンが出る', visible($('btn-tutorial-agree')));
$('btn-tutorial-agree').click();
await tick(30);
check('同意すると待機室が開く', visible($('room-screen')));
check('待機室にメンバー一覧が出る（既存6人＋自分=7人・満室）',
document.querySelectorAll('#room-members .member-row').length === 7,
`rows=${document.querySelectorAll('#room-members .member-row').length}`);
{
const badges = [...document.querySelectorAll('#room-members .member-row .no-badge')]
.map((b) => b.textContent);
check('[11] 待機室のメンバーに番号バッジ（参加順1〜7）',
badges.join(',') === '1,2,3,4,5,6,7', badges.join(','));
const myRow = [...document.querySelectorAll('#room-members .member-row')]
.find((r) => r.textContent.includes('（あなた）'));
check('[11] 自分は最後に参加したので7番',
myRow?.querySelector('.no-badge')?.textContent === '7', myRow?.textContent?? '');
}
check('[13] カウントダウン方式は廃止（要素自体がない）',
!$('start-countdown-box') &&!$('btn-cd-cancel') &&!$('btn-cd-leave'));
check('[13] マスターでない自分には「準備OK！」が出て、開始ボタンは出ない',
visible($('btn-ready')) &&!visible($('btn-start-game')));
check('[13] 満室でも全員の準備OKがそろうまでは開始しない（案内文）',
$('room-status-note').textContent.includes('準備OKを待っています'),
$('room-status-note').textContent);

// ---- [15] 待機室チャット ----
check('[15] 待機室にチャット欄と入力欄がある',
visible($('room-chat')) && visible($('room-chat-input-row')));
$('room-chat-input').value = 'よろしくお願いします！';
$('room-chat-send').click();
await tick(60);
check('[15] 待機室チャットに投稿でき、自分の吹き出しが出る',
$('room-chat-msgs-inner').textContent.includes('よろしくお願いします！'),
$('room-chat-msgs-inner').textContent.slice(0, 80));
{
const detail = await KL().getRoom('r1');
check('[15] 待機室チャットはデータ層にも残る（roomMessages）',
(detail.roomMessages?? []).some((m) => m.body === 'よろしくお願いします！'),
JSON.stringify(detail.roomMessages));
}

$('btn-ready').click();
await tick(60);
check('[13] 全員（自分含む）の準備OKがそろうとマスターが開始し、対戦画面へ進む',
await waitFor(() => visible($('game-screen'))));
check('[2] 対戦画面に待機室へ戻る導線がない（要素自体がない）',!$('game-back'));

// ---- [4] 挨拶タイム：お題はまだ出ない ----
check('[4] 挨拶タイムの表示（あと○秒でお題が出ます）',
$('game-phase-label').textContent.includes('挨拶タイム')
&& $('game-phase-label').textContent.includes('お題が出ます'),
$('game-phase-label').textContent);
check('[4] 挨拶タイム中はお題カードが隠れている',!visible($('game-topic-card')));
{
const detail = await KL().getRoom('r1');
const view = await KL().getGameView(detail.currentGame.gameId);
check('[4] サーバー（Sim）からも挨拶タイム中はお題が渡らない',
view.myTopic === null || view.myTopic === undefined, `myTopic=${view.myTopic}`);
}
$('game-input').value = 'こんばんは';
$('game-send').click();
await tick(60);
{
const myBubble = document.querySelector('#game-msgs-inner .game-msg-row.mine .dm-msg');
check('挨拶タイムでも発言でき、自分の吹き出しが出る',
!!myBubble && myBubble.textContent.includes('こんばんは'));
const senderBadge = document.querySelector('#game-msgs-inner .game-msg-row.mine .game-msg-sender .no-badge');
check('[11] チャットの発言者名の左にも番号バッジ（自分=7）',
senderBadge?.textContent === '7', senderBadge?.textContent?? 'バッジなし');
}

KL().__simAdvanceTime(20);
check('挨拶タイム終了で話し合いへ進む',
await waitFor(() => $('game-phase-label').textContent.includes('話し合い')),
$('game-phase-label').textContent);
const myTopic = $('game-my-topic').textContent.trim();
check('[4] 話し合いに入るとお題カードが出る', visible($('game-topic-card')) && myTopic.length > 0,
'myTopic empty');
const pair = loadTopics().find((t) => t.citizen === myTopic || t.wolf === myTopic);
check('お題が既知のペアに含まれる',!!pair, myTopic);
if (pair) {
const other = pair.citizen === myTopic? pair.wolf: pair.citizen;
check('相手陣営のお題は対戦画面のどこにも出ていない',
!$('game-screen').textContent.includes(other),
`other="${other}" が画面に漏れている`);
}
check('[7] 話し合いでは参加者アイコン帯が出る', visible($('game-players')));
check('[11] アイコン帯の名前にも番号バッジ',
document.querySelectorAll('#game-players .no-badge').length === 7,
`n=${document.querySelectorAll('#game-players .no-badge').length}`);

$('game-input').value = 'そのお題、週末によく使います';
$('game-send').click();
await tick(30);
check('話し合いで発言でき、吹き出しが表示される',
$('game-msgs-inner').textContent.includes('週末によく使います'));

// 締め切り後の発言はサーバー（Sim）に拒否される
const roomDetailA = await KL().getRoom('r1');
const currentGameId = roomDetailA.currentGame.gameId;
KL().__simAdvanceTime(500);
let deadlineError = null;
try {
await KL().postGameMessage(currentGameId, '遅すぎる発言');
} catch (e) { deadlineError = e;}
check('締め切り後の発言は DEADLINE_PASSED で拒否される',
deadlineError && deadlineError.code === 'DEADLINE_PASSED',
deadlineError? deadlineError.code: 'no error');

check('締め切り後は投票フェーズに進み、入力欄が閉じる',
await waitFor(() => $('game-phase-label').textContent.includes('投票')),
$('game-phase-label').textContent);
check('[5] 投票UIに「スルーする」ボタンがない（要素自体がない）',!$('game-vote-pass'));
check('[5] 投票の警告文は出ている（ペナルティ加算の注意）',
document.querySelector('#game-vote-panel .vote-warning')?.textContent.includes('ペナルティ')?? false);
check('[7] 投票では参加者アイコン帯を出さない',!visible($('game-players')));
check('[11] 投票の選択肢にも番号バッジ',
document.querySelectorAll('#game-vote-list .vote-btn .no-badge').length === 6,
`n=${document.querySelectorAll('#game-vote-list .vote-btn .no-badge').length}`);

const voteBtn = document.querySelector('#game-vote-list .vote-btn');
check('投票ボタン（自分以外）が出る',!!voteBtn);
voteBtn.click();
await tick(60);
check('投票すると「投票しました」表示になる',
$('game-vote-state').textContent.includes('投票しました'),
$('game-vote-state').textContent);

const reachedResult = await waitForResult();
check('結果発表：勝敗バナーと全員の正体・お題が出る',
reachedResult
&& document.querySelectorAll('#game-reveal-list .reveal-row').length === 7,
`banner=${$('game-result-banner').textContent} rows=${document.querySelectorAll('#game-reveal-list .reveal-row').length} label=${$('game-phase-label').textContent}`);
check('[7] 結果発表でも参加者アイコン帯を出さない',!visible($('game-players')));
check('[11] 結果リストにも番号バッジ',
document.querySelectorAll('#game-reveal-list .reveal-row .no-badge').length === 7,
`n=${document.querySelectorAll('#game-reveal-list .reveal-row .no-badge').length}`);
{
const detailLines = [...$('game-result-detail').children].map((d) => d.textContent);
check('[12] 結果の説明文は2行に分かれる（1行目=決着理由、2行目=お題開示）',
detailLines.length === 2 && detailLines[1].startsWith('お題：')
&&!detailLines[0].includes('お題：'),
JSON.stringify(detailLines));
}

check('[14] ゲーム終了で終了パネル（待機室に戻る／ロビーに戻る）が出る',
await playOutGame());
check('[14] 通常終了の終了パネルに強制終了の注記はない',
!$('game-end-note').textContent.includes('強制'), $('game-end-note').textContent);
$('btn-end-towaiting').click();
await tick(60);
check('[14] 「待機室に戻る」で待機室に戻れる（メンバー7人のまま）',
visible($('room-screen')) &&!visible($('game-screen'))
&& document.querySelectorAll('#room-members .member-row').length === 7,
`rows=${document.querySelectorAll('#room-members .member-row').length}`);
check('[13] ゲーム後は自分の準備OKがリセットされている',
$('btn-ready').textContent === '準備OK！', $('btn-ready').textContent);
$('room-back').click();
await tick(30);
check('待機室から退室してロビーに戻れる',!visible($('room-screen')));

// ============ フローB：ホストとして作成 → 開始 → [8] 無発言警告 ============
$('btn-create-room').click();
check('[17] 作成モーダルに人数選択（4〜8人）がある',
!!$('create-capacity') && $('create-capacity').querySelectorAll('option').length === 5);
await tick(60);
check('[19] 作成モーダルにジャンル選択（おまかせ＋19種）がある',
!!$('create-genre') && $('create-genre').querySelectorAll('option').length === 20,
`options=${$('create-genre')?.querySelectorAll('option').length}`);
$('create-genre').value = '恋愛';
$('create-title').value = '対戦テスト部屋';
$('btn-create-confirm').click();
await tick(60);
check('作成すると待機室が開く（自分＋ボット3人で満室・4人）',
visible($('room-screen'))
&& document.querySelectorAll('#room-members .member-row').length === 4,
`rows=${document.querySelectorAll('#room-members .member-row').length}`);
check('[19] 待機室のタグに選んだジャンルが出る',
$('room-screen-tags').textContent.includes('ジャンル：恋愛'),
$('room-screen-tags').textContent);
check('[13] マスターには「ゲームスタート！」が出て、満室＋全員準備OKで押せる',
visible($('btn-start-game')) &&!$('btn-start-game').disabled
&& $('btn-start-game').textContent.includes('ゲームスタート'));
check('[13] マスターには準備OKボタンは出ない',!visible($('btn-ready')));
{
const myRow = [...document.querySelectorAll('#room-members .member-row')]
.find((r) => r.textContent.includes('（あなた）'));
check('[11] 自分の部屋では自分が1番', myRow?.querySelector('.no-badge')?.textContent === '1',
myRow?.textContent?? '');
}
$('btn-start-game').click();
check('[13] マスターが押すと対戦画面が開く',
await waitFor(() => visible($('game-screen'))));
check('[21] 対戦画面の参加者アイコン帯にオンラインバッジ（緑ドット）が無い',
document.querySelectorAll('#game-players .dot').length === 0);
check('[4] 挨拶タイム中はお題が出ない',
$('game-phase-label').textContent.includes('挨拶タイム')
&&!visible($('game-topic-card')), $('game-phase-label').textContent);
check('[19] 挨拶タイム中もジャンルは表示される',
visible($('game-genre-line')) && $('game-genre-name').textContent === '恋愛',
$('game-genre-line')?.textContent ?? '');

// ---- [8] 無発言警告バナー（このゲームではまだ発言しない） ----
KL().__simAdvanceTime(20);
check('話し合いへ進む', await waitFor(() => $('game-phase-label').textContent.includes('話し合い')));
check('[4] 話し合いではお題が出る', visible($('game-topic-card')));
check('[19] 話し合いでもジャンル表示が続く',
visible($('game-genre-line')) && $('game-genre-name').textContent === '恋愛');
check('[8] 残り時間が多いうちは警告バナーは出ない',!visible($('game-afk-warning')));
KL().__simAdvanceTime(250);
check('[8] 発言0件＋残り1分未満で警告バナーが出る',
await waitFor(() => visible($('game-afk-warning'))));
check('[8] バナー文言はの予告どおり',
$('game-afk-warning').textContent.includes('まだ発言がありません。このまま発言も投票もないと、強制退室になります'),
$('game-afk-warning').textContent);
$('game-input').value = '遅れてごめん、話します';
$('game-send').click();
check('[8] 発言するとバナーは消える',
await waitFor(() =>!visible($('game-afk-warning'))));

check('ゲームを完走して終了パネルが出る', await playOutGame());
$('btn-end-tolobby').click();
await tick(30);
check('ロビーへ戻れる',!visible($('game-screen')) &&!visible($('room-screen')));
check('[19] ロビーのルームカードにジャンルタグが出る',
[...document.querySelectorAll('#room-list .room-card')]
.some((c) => c.textContent.includes('対戦テスト部屋') && c.textContent.includes('恋愛')),
[...document.querySelectorAll('#room-list .room-card')].map((c) => c.textContent).join(' / ').slice(0, 120));

// ============ フローF：[16] マスターのキック＋[17] 人数選択 ============
$('btn-create-room').click();
$('create-title').value = 'キック検証部屋';
$('create-capacity').value = '5';
$('btn-create-confirm').click();
await tick(60);
check('[17] 人数5人で作るとボットが満室まで入る（5人）',
document.querySelectorAll('#room-members .member-row').length === 5,
`rows=${document.querySelectorAll('#room-members .member-row').length}`);
check('[16] マスターには各メンバーにキックボタンが出る（自分以外4人分）',
document.querySelectorAll('#room-members .kick-btn').length === 4,
`n=${document.querySelectorAll('#room-members .kick-btn').length}`);
check('[13] 満室＋全員準備OKなので開始ボタンが押せる',
!$('btn-start-game').disabled);
document.querySelector('#room-members .kick-btn').click();
await tick(60);
check('[16] キックするとメンバーが減る（4人）',
document.querySelectorAll('#room-members .member-row').length === 4,
`rows=${document.querySelectorAll('#room-members .member-row').length}`);
check('[16] キック後は満室でなくなり、開始ボタンが押せなくなる',
$('btn-start-game').disabled
&& $('room-status-note').textContent.includes('満室'),
$('room-status-note').textContent);
$('room-back').click();
await tick(30);

// ============ フローC：DM招待カードから非公開ルームへ入室 ============
$('tabbtn-friends').click();
await tick(30);
const kenRow = [...document.querySelectorAll('#talk-list .talk-row')]
.find((r) => r.textContent.includes('けん'));
check('トーク一覧にけんとの会話がある',!!kenRow);
kenRow.click();
await tick(30);
const inviteCard = document.querySelector('#dm-msgs-inner .dm-invite-card');
check('DMに招待カード（パスワード表示つき）がある',
!!inviteCard && inviteCard.textContent.includes('パスワード'));
if (inviteCard) {
inviteCard.click();
await tick(60);
check('招待カードから待機室に入れる',
visible($('room-screen')) && $('room-screen-title').textContent.includes('真剣勝負'));
$('room-back').click();
await tick(30);
}

// ============ フローG：[20] DM招待カードの発行（待機室から） ============
$('tabbtn-lobby').click();
await tick(30);
$('btn-create-room').click();
document.querySelector('input[name="create-visibility"][value="private"]').click();
$('create-title').value = '招待検証部屋';
$('create-password').value = 'invite123';
$('btn-create-confirm').click();
await tick(60);
check('[20] 非公開ルームの待機室が開く', visible($('room-screen')));
check('[21] 待機室メンバーにオンラインバッジ（緑ドット）が無い',
document.querySelectorAll('#room-members .dot').length === 0);
check('[20] 待機室に「友達を招待」導線が出る', visible($('btn-invite')));
$('btn-invite').click();
await tick(60);
check('[20] 招待モーダルが開き、フレンド一覧（4人）が出る',
visible($('modal-invite'))
&& document.querySelectorAll('#invite-friend-list .user-row').length === 4,
`rows=${document.querySelectorAll('#invite-friend-list .user-row').length}`);
check('[20] 非公開なのでパスワード欄が出て、作成時のパスワードが初期値に入る',
visible($('invite-password-row')) && $('invite-password').value === 'invite123',
`pw=${$('invite-password').value}`);
const inviteBtnFor = (name) => {
const row = [...document.querySelectorAll('#invite-friend-list .user-row')]
.find((r) => r.textContent.includes(name));
return [...row.querySelectorAll('button')].find((b) => b.textContent === '招待する');
};
// パスワードを間違えるとサーバー判定（Sim）で拒否され、送信済みにならない
$('invite-password').value = 'wrong999';
inviteBtnFor('みか').click();
await tick(60);
check('[20] パスワード不一致は拒否され、理由がトーストに出る',
$('toast').textContent.includes('パスワードが違います')
&& inviteBtnFor('みか') != null, $('toast').textContent);
// データ層でも同じエラーコードで返る
const invRoom = (await KL().listRooms()).find((r) => r.title === '招待検証部屋');
const eWrong = await KL().sendInvite('u-ken', invRoom.id, 'badpass')
.then(() => null, (e) => e);
check('[20] データ層：パスワード不一致は WRONG_PASSWORD', eWrong?.code === 'WRONG_PASSWORD',
eWrong?.code ?? 'no error');
const eFriend = await KL().sendInvite('u-sora', invRoom.id, 'invite123')
.then(() => null, (e) => e);
check('[20] データ層：フレンド以外への招待は NOT_FRIENDS', eFriend?.code === 'NOT_FRIENDS',
eFriend?.code ?? 'no error');
// 正しいパスワードで送ると送信済みになり、DM に招待カードが入る
$('invite-password').value = 'invite123';
inviteBtnFor('みか').click();
await tick(60);
check('[20] 正しいパスワードで送信でき、ボタンが「送信済み」になる',
$('toast').textContent.includes('招待を送りました')
&& [...document.querySelectorAll('#invite-friend-list .user-row')]
.find((r) => r.textContent.includes('みか'))?.textContent.includes('送信済み'),
$('toast').textContent);
document.querySelector('#modal-invite [data-close]').click();
await tick(30);
$('room-back').click();
await tick(30);
$('tabbtn-friends').click();
await tick(30);
[...document.querySelectorAll('#talk-list .talk-row')]
.find((r) => r.textContent.includes('みか')).click();
await tick(40);
const sentCard = [...document.querySelectorAll('#dm-msgs-inner .dm-invite-card')]
.find((c) => c.textContent.includes('招待検証部屋'));
check('[20] 送った招待カードが DM に残る（ルーム名＋パスワード表示）',
!!sentCard && sentCard.classList.contains('mine')
&& sentCard.textContent.includes('パスワード：invite123'),
sentCard?.textContent ?? 'no card');
$('dm-back').click();
await tick(20);

// ============ フローD：ペナルティ表示（バナー／参加拒否／システムDM） ============
$('tabbtn-lobby').click();
await tick(30);
await KL().__simApplyMyPenalty();
$('btn-refresh').click();
await tick(60);
check('ペナルティ中はロビーにバナー（解除時刻つき）が出る',
visible($('penalty-banner')) && $('penalty-banner').textContent.includes('ペナルティ期間中'),
$('penalty-banner').textContent);
const roomsNow = await KL().listRooms();
const targetRoom = roomsNow.find(
(r) =>!r.isPrivate &&!r.isMember &&!r.isHost && r.status === 'lobby');
const targetCard = [...document.querySelectorAll('#room-list .room-card')]
.find((c) => c.dataset.roomId === targetRoom?.id);
check('未参加の公開ルームカードがある',!!targetCard);
targetCard.click();
await tick(60);
check('制限中は入室できず、理由がトーストに出る',
!visible($('room-screen')) && $('toast').textContent.includes('ペナルティ'),
$('toast').textContent);
$('tabbtn-friends').click();
await tick(30);
const sysRow = [...document.querySelectorAll('#talk-list .talk-row')]
.find((r) => r.textContent.includes('システム'));
check('トーク一覧にシステムからのお知らせが出る',!!sysRow);
check('システム行に未読バッジが出る',!!sysRow?.querySelector('.unread-badge'));
sysRow.click();
await tick(30);
check('システムDMが開き、ペナルティ通知の本文が見える',
visible($('dm-screen')) && $('dm-msgs-inner').textContent.includes('ペナルティのお知らせ')
&& $('dm-msgs-inner').textContent.includes('離脱と判定されました'),
$('dm-msgs-inner').textContent.slice(0, 80));
check('システムDMは読み取り専用（入力欄とギフトが隠れる）',
!visible($('dm-input-row')) &&!visible($('dm-gift-btn')));
$('dm-back').click();
await tick(30);
check('システムDMを開くと未読バッジが消える',
![...document.querySelectorAll('#talk-list .talk-row')]
.find((r) => r.textContent.includes('システム'))?.querySelector('.unread-badge'));

// ============ フローE：[9] 発言0＋未投票は一発退室 ============
// 自分がマスターのルーム（フローBで作成）で [9] を検証する。
// ペナルティ（フローDで適用）は十分に時間を進めて期限切れにする。
$('tabbtn-lobby').click();
await tick(30);
KL().__simAdvanceTime(500000);
await tick(30);
const hostRoom = (await KL().listRooms()).find((r) => r.isHost);
check('[9] 自分のルーム（マスター）がある',!!hostRoom);
roomCard(hostRoom.id).click();
await tick(30);
check('[9] ペナルティ明けに待機室へ入れる', visible($('room-screen')));
check('[9] 満室＋ボット準備OKで開始ボタンが押せる',!$('btn-start-game').disabled);
$('btn-start-game').click();
check('[9] 対戦画面が開く', await waitFor(() => visible($('game-screen'))));
// このゲームでは発言も投票もしない。
// 仮想時間を一括で進めると自分のハートビート送信（実時間ポーリング）が
// 追いつかず離脱判定で対戦が落ちることがあるため、小刻みに進めて
// 間に実時間の同期待ちを挟む
const advanceSlow = async (totalSec) => {
  for (let done = 0; done < totalSec; done += 20) {
    KL().__simAdvanceTime(Math.min(20, totalSec - done));
    await tick(160);
  }
};
await advanceSlow(20); // 挨拶タイム終了
await waitFor(() => $('game-phase-label').textContent.includes('話し合い'));
await advanceSlow(400); // 話し合い終了
await waitFor(() => $('game-phase-label').textContent.includes('投票'));
await advanceSlow(90); // 投票締め切り → 解決（逆転回答フェーズも消化）
check('[9] 自分が投票しなくても結果発表まで進む',
await waitFor(() => visible($('game-result-panel'))
&& $('game-result-banner').textContent.length > 0, 20000));
await advanceSlow(20); // result 終了 → 強制退室＋対戦終了が確定
check('[9] 終了パネルが出て、強制退室の注記がある',
await waitFor(() => visible($('game-end-panel'))
&& $('game-end-note').textContent.includes('強制退室'), 20000),
$('game-end-note').textContent);
check('[9] 強制退室された本人には「待機室に戻る」が出ない',
!visible($('btn-end-towaiting')));
check('[9] ルームのチャットにシステムログ（強制退室）が出ている',
$('game-msgs-inner').textContent.includes('強制退室となりました'),
$('game-msgs-inner').textContent.slice(-120));
$('btn-end-tolobby').click();
await tick(30);
$('tabbtn-friends').click();
await tick(30);
const sysRow2 = [...document.querySelectorAll('#talk-list .talk-row')]
.find((r) => r.textContent.includes('システム'));
sysRow2.click();
await tick(30);
check('[9] 本人へシステムDM（発言も投票もなかったため）が届く',
$('dm-msgs-inner').textContent.includes('発言も投票もなかったため、強制退室となりました'),
$('dm-msgs-inner').textContent.slice(-160));

const failed = results.filter((r) =>!r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
window.close();
process.exit(failed.length? 1: 0);
