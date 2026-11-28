// テスト仕様書（docs/test-spec.md）の未実装行のうち、クライアント挙動を
// jsdom（SimBackend）で検証するスイート。
// 実行: node scripts/verify-spec-gaps-ui.mjs
//
// カバー範囲：
// §1-1 プロフィール初期表示は空白（静的）／§1-2 オンライン帯30秒追随／
// §1-3 最終アクセス記録の間隔（ソース確認）／§1-4 復帰時の即再描画／
// §1-14 ペナルティバナー／§2-6 ランダム入室／§3-6 空の待機室チャット／
// §4-12 紙吹雪の出る・出ない／§4-14 結果画面20秒で自動帰室／
// §5-8 試合中ギフト通知の保留→done で表示／§5-10 ダイヤの Lottie と静止画／
// §6-2 未読バッジ消去・既読表示なし／§6-12 自分の発言の送信直後ピン留め／
// §8-13 フレンド一覧の並び順／§11-7 大元OFFの表示連動（保持・復元）／
// §11-8 アイコンバッジ独立トグル／§13-7 チュートリアル第6スライドの内容／
// §14-9 ログアウト（Sim）／§14-13 規約・プライバシーへの導線
//
// 注意：実時間待ちは素の setTimeout で行う（verify-lobby の tick は使わない）。
// 紙吹雪は canvas 2d コンテキストをスタブして「canvas が表示されたか」で判定する。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'client');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
}

const html = readFileSync(path.join(client, 'index.html'), 'utf8');
const appSrc = readFileSync(path.join(client, 'js/app.js'), 'utf8');
const adapterSrc = readFileSync(path.join(client, 'js/data-adapter.js'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

// --- 評価前のスタブ（app.js より先に必要） ---
// 紙吹雪 canvas：jsdom は 2d コンテキストを返さないので no-op を返す
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (t, p) => (typeof p === 'string' ? () => {} : undefined),
  set: () => true,
});
// アイコンバッジ API の記録
const badgeCalls = { set: [], clear: 0 };
Object.defineProperty(window.navigator, 'setAppBadge', {
  value: async (n) => { badgeCalls.set.push(n); }, configurable: true,
});
Object.defineProperty(window.navigator, 'clearAppBadge', {
  value: async () => { badgeCalls.clear += 1; }, configurable: true,
});

for (const rel of ['js/dummy-data.js', 'js/data-adapter.js', 'js/app.js']) {
  window.eval(readFileSync(path.join(client, rel), 'utf8'));
}
document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visible = (el) => el && !el.classList.contains('hidden');
async function waitFor(fn, timeoutMs = 6000, stepMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return fn();
}
const KL = window.KL_DATA;

await waitFor(() => $('my-name').textContent.length > 0, 5000);
// Sim ではログイン画面が出たままなので、実利用と同じくログインして
// 閉じる（ギフト通知はログイン画面表示中は保留される仕様のため、
// 通知系の検証にはこの手順が前提になる）
$('btn-login-google').click();
await waitFor(() => $('login-screen').classList.contains('hidden'), 4000);
check('（前提）ログイン画面が閉じている', $('login-screen').classList.contains('hidden'));

// ============ §1-1 プロフィール初期表示（静的） ============
{
  const grab = (re) => (html.match(re) ?? [])[1] ?? 'NOTFOUND';
  check('§1-1 初期HTMLの名前欄は空（サンプル値を置かない）',
    grab(/<span id="my-name"[^>]*>([^<]*)<\/span>/) === '');
  check('§1-1 初期HTMLのID欄は空',
    grab(/<span id="my-id">([^<]*)<\/span>/) === '');
  check('§1-1 初期HTMLのコイン・人気度は空',
    grab(/<span id="coin-count">([^<]*)<\/span>/) === ''
    && grab(/<span id="popularity-count">([^<]*)<\/span>/) === '');
  check('§1-1 初期HTMLの自己紹介欄は空',
    grab(/<button id="my-bio"[^>]*>([^<]*)<\/button>/) === '');
}

// ============ §1-3 最終アクセス記録の間隔（ソース確認） ============
// Sim では touchSeen が早期 return するため、実DBモードの定数を
// ソースで確認する（ロビー検証が CSS を文字列で確認する流儀と同じ）
check('§1-3 表示中は1分おきに最終アクセス記録を試みる',
  /setInterval\(\(\) => \{\s*if \(document\.visibilityState === 'visible'\) touchSeenThrottled\(\);\s*\}, 60 \* 1000\)/.test(appSrc));
check('§1-3 記録の間引きは2分（オンライン窓5分より短い）',
  appSrc.includes('now - lastTouchSeen < 2 * 60 * 1000'));
check('§1-3 オンライン判定の窓は5分',
  adapterSrc.includes('Date.now() - new Date(p.last_seen_at).getTime() < 5 * 60 * 1000'));

// ============ §14-13 規約・プライバシー導線 ============
{
  const hrefs = [...document.querySelectorAll('.login-terms a')].map((a) => a.getAttribute('href'));
  check('§14-13 ログイン画面に規約・プライバシーへのリンクがある',
    hrefs.includes('terms.html') && hrefs.includes('privacy.html'), hrefs.join(','));
  const opened = [];
  window.open = (u) => { opened.push(u); return null; };
  $('btn-settings').click();
  await sleep(60);
  $('btn-terms').click();
  $('btn-privacy').click();
  check('§14-13 設定から規約・プライバシーの実ページが開く',
    opened.includes('terms.html') && opened.includes('privacy.html'), opened.join(','));
  document.querySelector('#modal-settings [data-close]').click();
  await sleep(30);
}

// ============ §13-7 チュートリアル第6スライド ============
$('btn-create-room').click();
await sleep(60);
check('初回作成でチュートリアルが出る', visible($('modal-tutorial')));
for (let i = 0; i < 5; i++) $('btn-tutorial-next').click();
await sleep(30);
{
  const slides = document.querySelectorAll('#tutorial-track .tutorial-slide');
  const s6 = slides[5];
  check('§13-7 第6スライドは「困ったときは」',
    s6?.textContent.includes('困ったときは'), s6?.textContent.slice(0, 40));
  check('§13-7 通報の仕方（長押し／プロフから）が載っている',
    s6.textContent.includes('長押し') && s6.textContent.includes('通報する')
    && s6.textContent.includes('プロフィール'), s6.textContent.slice(0, 120));
  check('§13-7 結果はDMで通知・相手には分からない・ブロック可が載っている',
    s6.textContent.includes('DMでお知らせ') && s6.textContent.includes('相手には分かりません')
    && s6.textContent.includes('ブロック'), s6.textContent.slice(0, 160));
  check('§13-7 6枚目が表示位置に来ている',
    $('tutorial-track').style.transform === 'translateX(-500%)',
    $('tutorial-track').style.transform);
}
$('btn-tutorial-agree').click();
await sleep(60);
check('同意すると保留していた作成モーダルが開く', visible($('modal-create')));

// ============ §3-6 空の待機室チャット ============
$('create-title').value = '空チャット検証';
$('btn-create-confirm').click();
await sleep(120);
check('ルーム作成で待機室が開く', visible($('room-screen')));
{
  const box = $('room-chat-messages');
  const empties = box.querySelectorAll('.room-chat-empty');
  check('§3-6 空の待機室チャットは「まだ発言がありません。」だけ',
    empties.length === 1 && empties[0].textContent === 'まだ発言がありません。'
    && box.querySelectorAll('.dm-msg, .chat-msg, .msg-row').length === 0,
    box.textContent.trim().slice(0, 60));
}
$('room-back').click();
await sleep(60);

// ============ §2-6 ランダム入室 ============
$('btn-random').click();
await sleep(80);
check('§2-6 ランダム入室で入室確認ポップアップが出る',
  visible($('modal-join-confirm')) && $('jc-title').textContent.length > 0,
  $('jc-title')?.textContent);
const jcTitle = $('jc-title').textContent;
$('jc-join').click();
await sleep(120);
check('§2-6 確認を挟んで待機室に入る',
  visible($('room-screen')) && $('room-screen-title').textContent === jcTitle,
  `${$('room-screen-title')?.textContent} vs ${jcTitle}`);
$('room-back').click();
await sleep(60);

// ============ §11-8 アイコンバッジ独立トグル ============
$('btn-settings').click();
await sleep(60);
$('btn-push-settings').click();
await sleep(60);
check('通知設定ポップアップが開く', visible($('modal-push')));
{
  const before = { set: badgeCalls.set.length, clear: badgeCalls.clear };
  check('§11-8 起動時点で未読数ぶんのバッジが付いている（既定ON）',
    before.set > 0 && badgeCalls.set[before.set - 1] > 0,
    JSON.stringify(badgeCalls.set));
  $('push-badge').checked = false;
  $('push-badge').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(80);
  check('§11-8 バッジOFFでクリアされ、再セットされない（プッシュとは独立）',
    badgeCalls.clear > before.clear && badgeCalls.set.length === before.set,
    `clear ${before.clear}->${badgeCalls.clear}, set ${before.set}->${badgeCalls.set.length}`);
  $('push-badge').checked = true;
  $('push-badge').dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(80);
  check('§11-8 バッジONに戻すと未読数で再セットされる',
    badgeCalls.set.length > before.set, `set ${before.set}->${badgeCalls.set.length}`);
}

// ============ §11-7 大元OFFの表示連動（保持・復元） ============
// onPushToggle は表示の再描画を同期的に行い、その後サーバー保存と
// 購読確認に進む（Sim では購読が成立せず最終的にOFFへ戻る）。
// ここでは「 change 直後の同期描画」を切り取って表示仕様だけを見る。
{
  const syncState = () => ({
    master: $('push-master').checked,
    dm: $('push-dm').checked, invite: $('push-invite').checked, announce: $('push-announce').checked,
    dmDis: $('push-dm').disabled, inviteDis: $('push-invite').disabled, announceDis: $('push-announce').disabled,
    op: $('push-dm').closest('li').style.opacity,
  });
  // 選択を作る：マスターON、dm/invite ON、announce OFF
  $('push-master').checked = true;
  $('push-dm').checked = true;
  $('push-invite').checked = true;
  $('push-announce').checked = false;
  $('push-master').dispatchEvent(new window.Event('change', { bubbles: true }));
  let s = syncState();
  check('§11-7 マスターONで選んだカテゴリがそのまま表示される',
    s.master && s.dm && s.invite && !s.announce && !s.dmDis && s.op === '',
    JSON.stringify(s));
  await sleep(150); // 非同期の後処理（Simでは購読不可でOFF表示へ戻る）を流す
  // 大元OFF：表示は一斉に外れて無効化（薄表示）
  $('push-master').checked = false;
  $('push-master').dispatchEvent(new window.Event('change', { bubbles: true }));
  s = syncState();
  check('§11-7 マスターOFFでカテゴリが表示上一斉に外れ、無効化＋薄表示になる',
    !s.dm && !s.invite && !s.announce && s.dmDis && s.inviteDis && s.announceDis && s.op === '0.45',
    JSON.stringify(s));
  await sleep(150);
  // 大元ONに戻す：保持されていた選択（announce OFF）が復元される
  $('push-master').checked = true;
  $('push-master').dispatchEvent(new window.Event('change', { bubbles: true }));
  s = syncState();
  check('§11-7 マスターONに戻すと元の選択が復元される（announce OFFのまま）',
    s.dm && s.invite && !s.announce && !s.dmDis && s.op === '',
    JSON.stringify(s));
  await sleep(150);
}
document.querySelector('#modal-push [data-close]').click();
await sleep(30);
document.querySelector('#modal-settings [data-close]')?.click();
await sleep(30);

// ============ §8-13 フレンド一覧の並び順 ============
$('tabbtn-friends').click();
await sleep(60);
{
  const sub = document.querySelector('[data-subtab="friend"]') ?? $('subtab-friend');
  sub?.click();
}
await sleep(80);
{
  const friends = await KL.listFriends();
  const expected = [...friends].sort((a, b) =>
    ((b.online ? 1 : 0) - (a.online ? 1 : 0))
    || ((a.lastActiveMin ?? Infinity) - (b.lastActiveMin ?? Infinity))).map((u) => u.id);
  const domOrder = [...document.querySelectorAll('#friend-list .friend-card')].map((el) => el.dataset.userId);
  check('§8-13 フレンド一覧はオンラインが上→最終ログインが新しい順',
    JSON.stringify(domOrder) === JSON.stringify(expected),
    `dom=${domOrder.join(',')} expected=${expected.join(',')}`);
  const rawOrder = friends.map((u) => u.id);
  check('§8-13 （前提）未ソート順とソート順が実際に異なるデータである',
    JSON.stringify(rawOrder) !== JSON.stringify(expected));
}

// ============ §5-10 ダイヤの表示（ピッカー） ============
{
  const giftBtn = [...document.querySelectorAll('#friend-list .friend-card .friend-actions button')]
    .find((b) => b.textContent.includes('ギフト'));
  giftBtn?.click();
  await sleep(120);
  const cell = document.querySelector('#gift-grid .gift-item[data-gift-key="diamond"]');
  check('§5-10 ピッカーのダイヤは Lottie 用プレースホルダで出る',
    !!cell?.querySelector('[data-gift-art="diamond"]') && !cell?.querySelector('img'),
    cell?.innerHTML.slice(0, 120));
  const heart = document.querySelector('#gift-grid .gift-item[data-gift-key="heart"]');
  check('§5-10 ダイヤ以外のギフトは通常アート（対照）',
    !!heart && !heart.querySelector('[data-gift-art]'));
  document.querySelector('#modal-gift [data-close]')?.click();
  await sleep(30);
}
// ロビーのギフト帯
$('tabbtn-lobby').click();
await sleep(60);
check('§5-10 ギフト帯のダイヤも Lottie 用プレースホルダ',
  !!document.querySelector('#gift-strip [data-gift-art="diamond"]'));

// ============ §6-2 / §5-10 DMカード / §6-12 DM送信ピン留め ============
$('tabbtn-friends').click();
await sleep(60);
{
  const talkSub = document.querySelector('[data-subtab="talk"]') ?? $('subtab-talk');
  talkSub?.click();
}
await sleep(80);
const kenRow = [...document.querySelectorAll('#talk-list .talk-row')]
  .find((r) => r.querySelector('.talk-name')?.textContent === 'けん');
check('トーク一覧にけんの行がある', !!kenRow);
const kenBadge = kenRow.querySelector('.unread-badge');
check('§6-2 開く前はけんの行に未読バッジがある',
  !!kenBadge && Number(kenBadge.textContent) > 0, kenBadge?.textContent);
const tabBadgeBefore = Number($('badge-tab-friends').textContent || 0);
// §6-12 の前提：スクロール量を先にスタブしておく（開いた直後の
// renderMessages が scrollTop=scrollHeight／_lastTop を決めるため、
// 後から差すと「読み返し中」の状態を作れない）
{
  const box = $('dm-messages');
  Object.defineProperty(box, 'scrollHeight', { get: () => 2000, configurable: true });
  Object.defineProperty(box, 'clientHeight', { get: () => 400, configurable: true });
}
kenRow.click();
await sleep(120);
check('DMが開く', visible($('dm-screen')));
{
  const card = document.querySelector('#dm-msgs-inner .dm-gift-card');
  check('§5-10 DMのギフトカードは静止画（img）で、Lottie プレースホルダは使わない',
    !!card?.querySelector('img.gift-card-img')
    && (card.querySelector('img.gift-card-img').getAttribute('src') ?? '').includes('gifts/gift-crown.webp')
    && !document.querySelector('#dm-msgs-inner [data-gift-art]'),
    card?.innerHTML.slice(0, 140));
  check('§6-2 DM内に既読表示は出ない',
    !$('dm-msgs-inner').textContent.includes('既読'));
}
// §6-12：上に読み返してから送信すると、必ず最新位置に戻る
{
  const box = $('dm-messages');
  box.scrollTop = 100;
  box.dispatchEvent(new window.Event('scroll'));
  await sleep(30);
  check('§6-12 上に読んでいる間は「最新へ」ボタンが出る',
    visible($('dm-scroll-bottom')));
  $('dm-input').value = '送信ピン留めの検証です';
  $('dm-send').click();
  await sleep(150);
  check('§6-12 送信直後は最新位置に自分の発言が見える（末尾へピン留め）',
    box.scrollTop === 2000 && !visible($('dm-scroll-bottom')),
    `scrollTop=${box.scrollTop}`);
  const msgs = document.querySelectorAll('#dm-msgs-inner .dm-msg');
  check('§6-12 自分の発言が末尾に追加されている',
    msgs[msgs.length - 1]?.textContent.includes('送信ピン留めの検証です'));
}
$('dm-back').click();
await sleep(100);
{
  const kenRow2 = [...document.querySelectorAll('#talk-list .talk-row')]
    .find((r) => r.querySelector('.talk-name')?.textContent === 'けん');
  check('§6-2 DMを読むとその行の未読バッジが消える',
    !kenRow2?.querySelector('.unread-badge'));
  const tabBadgeAfter = Number($('badge-tab-friends').textContent || 0);
  check('§6-2 下部タブのバッジも未読ぶん減る',
    tabBadgeAfter < tabBadgeBefore, `${tabBadgeBefore} -> ${tabBadgeAfter}`);
}

// ============ §5-10 通知サムネは静止画（ギフト通知テスト連射） ============
$('tabbtn-lobby').click();
await sleep(60);
{
  const expected = ['heart', 'crown', 'dragon', 'diamond'];
  for (let i = 0; i < expected.length; i++) {
    $('btn-settings').click();
    await sleep(50);
    $('btn-gift-test').click();
    const shown = await waitFor(() => $('gift-notify').classList.contains('show'), 4000);
    const src = $('gn-art').getAttribute('src') ?? '';
    check(`§5-10 通知${i + 1}回目（${expected[i]}）のサムネは静止画 gifts/gift-${expected[i]}.webp`,
      shown && src.includes(`gifts/gift-${expected[i]}.webp`), src);
    await waitFor(() => !$('gift-notify').classList.contains('show'), 5000);
    await sleep(500);
  }
}

// ============ §4-12 紙吹雪 / §4-14 結果画面の自動帰室 ============
async function runResultDemo(btnId) {
  $('btn-settings').click();
  await sleep(50);
  $(btnId).click();
  const done = await waitFor(
    () => visible($('game-result-panel')) && $('game-result-banner').textContent.length > 0, 7000);
  return done;
}
// 市民勝ち：紙吹雪が出て、20秒カウントダウンで自動的にルームへ戻る
{
  const done = await runResultDemo('btn-citizens-test');
  check('結果デモ（市民勝ち）が確定まで進む', done, $('game-result-banner')?.textContent);
  const confetti = await waitFor(() => !$('confetti-canvas').classList.contains('hidden'), 3000, 100);
  check('§4-12 市民勝ちでは紙吹雪が出る', confetti);
  check('§4-14 結果画面に20秒カウントダウンのピルが出る',
    visible($('game-end-countdown')) && $('game-end-countdown').textContent.includes('秒後にルームに戻ります'),
    $('game-end-countdown')?.textContent);
  const back = await waitFor(() => $('game-screen').classList.contains('hidden'), 26000, 300);
  check('§4-14 20秒経つと自動でルーム（ロビー）に戻る', back);
}
// 通常のウルフ勝ち：紙吹雪が出る
{
  await runResultDemo('btn-wolves-test');
  const confetti = await waitFor(() => !$('confetti-canvas').classList.contains('hidden'), 3000, 100);
  check('§4-12 通常のウルフ勝ちでも紙吹雪が出る', confetti);
  $('btn-end-tolobby').click();
  await sleep(150);
}
// 逆転勝ち：紙吹雪は出ない（カットイン担当）
{
  await runResultDemo('btn-result-test');
  await sleep(1200);
  check('§4-12 逆転勝ちでは紙吹雪は出ない',
    $('confetti-canvas').classList.contains('hidden'));
  $('btn-end-tolobby').click();
  await sleep(150);
}
// 強制終了：紙吹雪は出ない
{
  await runResultDemo('btn-terminated-test');
  await sleep(1200);
  check('§4-12 強制終了では紙吹雪は出ない',
    $('confetti-canvas').classList.contains('hidden'));
  $('btn-end-tolobby').click();
  await sleep(150);
}
// prefers-reduced-motion：紙吹雪は出ない
{
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion/.test(q), media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  await runResultDemo('btn-citizens-test');
  await sleep(1200);
  check('§4-12 prefers-reduced-motion 時は紙吹雪が出ない',
    $('confetti-canvas').classList.contains('hidden'));
  delete window.matchMedia;
  $('btn-end-tolobby').click();
  await sleep(150);
}

// ============ §5-8 試合中ギフト通知の保留 ============
{
  $('btn-settings').click();
  await sleep(50);
  $('btn-result-test').click();
  const tally = await waitFor(() => $('game-phase-label').textContent.includes('集計中'), 4000);
  check('結果デモが集計中（試合中扱い）に入る', tally, $('game-phase-label')?.textContent);
  $('btn-settings').click();
  await sleep(50);
  $('btn-gift-test').click();
  await sleep(1600);
  check('§5-8 試合中（集計中）に届いたギフト通知は出ない（保留）',
    !$('gift-notify').classList.contains('show'));
  const shownLater = await waitFor(() => $('gift-notify').classList.contains('show'), 9000, 200);
  check('§5-8 done（結果画面）になると保留されていた通知が出る', shownLater);
  $('btn-end-tolobby').click();
  await sleep(150);
}

// ============ §1-14 ペナルティバナー ============
$('btn-settings').click();
await sleep(50);
$('btn-penalty-test').click();
await sleep(150);
check('§1-14 ペナルティ制限中はロビーに解除日時つきバナーが出る',
  visible($('penalty-banner'))
  && /ペナルティ期間中のため、\d+月\d+日 \d{2}:\d{2} までルームに参加・作成できません/.test($('penalty-banner').textContent),
  $('penalty-banner')?.textContent);
document.querySelector('#modal-settings [data-close]')?.click();
await sleep(30);

// ============ §1-4 / §1-2 オンライン帯の追随 ============
{
  const orig = KL.listOnlineFriends.bind(KL);
  let extras = [];
  KL.listOnlineFriends = async () => {
    const base = await orig();
    return [...base, ...extras];
  };
  const mkFriend = (id, name) => ({
    ...(window.KL_DATA ? {} : {}),
    id, name, iconKey: 'cat', icon: '🐱', iconBg: '#e8f3ff', online: true,
  });
  $('tabbtn-lobby').click();
  await sleep(100);
  // §1-4：復帰（visibilitychange）で即再描画
  extras = [mkFriend('u-presence-a', '検証はなこ')];
  document.dispatchEvent(new window.Event('visibilitychange'));
  const quick = await waitFor(
    () => [...document.querySelectorAll('#online-friends .friend-name')].some((n) => n.textContent === '検証はなこ'),
    3000, 120);
  check('§1-4 画面復帰でオンライン帯が即再描画され、新しく来た友達が出る', quick);
  // §1-2：30秒ごとの自動再描画で追随
  extras = [mkFriend('u-presence-a', '検証はなこ'), mkFriend('u-presence-b', '検証たろう')];
  const followed = await waitFor(
    () => [...document.querySelectorAll('#online-friends .friend-name')].some((n) => n.textContent === '検証たろう'),
    35000, 500);
  check('§1-2 ロビー滞在中、30秒ごとの自動再描画で来た友達が画面遷移なしで現れる', followed);
  KL.listOnlineFriends = orig;
}

// ============ §14-9 ログアウト（Sim） ============
$('btn-settings').click();
await sleep(50);
$('btn-logout').click();
await sleep(120);
check('§14-9 ログアウトするとログイン画面に戻る（Sim）',
  visible($('login-screen')));

const failures = results.filter((r) => !r.ok).length;
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks) ===`);
process.exit(failures ? 1 : 0);
