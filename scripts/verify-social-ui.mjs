// ソーシャル画面の検証：フレンドタブ（トーク一覧／フレンド一覧・
// ID検索・申請承認）、DM画面（下端寄せ・送受信）、ギフト送信と
// コイン残高の連動を jsdom で確認する。
// 実行：npm run verify:social-ui（データ層は SimBackend＝デモデータ）
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const base = new URL('../client/', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const dom = new JSDOM(html, {
  url: pathToFileURL(new URL('index.html', base).pathname).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

await new Promise((resolve) => {
  if (dom.window.document.readyState === 'complete') resolve();
  else dom.window.addEventListener('load', resolve);
});
await tick(60);

const { document } = dom.window;
const $ = (id) => document.getElementById(id);
const visible = (el) => el && !el.classList.contains('hidden');
const rowByName = (container, name) =>
  [...container.querySelectorAll('.user-row, .talk-row')]
    .find((r) => r.textContent.includes(name));

// --- チュートリアル同意（フレンドタブは同意するまで開けない） ---
check('未同意ではフレンドタブがグレーアウトしている',
  $('tabbtn-friends').classList.contains('locked'));
$('tabbtn-friends').click();
await tick();
check('未同意ではフレンドタブへ切り替わらない', !visible($('tab-friends')));
$('btn-create-room').click();
await tick();
check('入室系アクションでチュートリアルが強制表示される', visible($('modal-tutorial')));
for (let i = 0; i < 4; i++) $('btn-tutorial-next').click();
$('btn-tutorial-agree').click();
await tick();
check('同意すると保留していた作成モーダルが開く', visible($('modal-create')));
$('btn-create-cancel').click();
check('同意でフレンドタブのロックが解除される',
  !$('tabbtn-friends').classList.contains('locked'));

// --- フレンドメニュー（ロビー帯アイコンタップ→2択） ---
const mikaStrip = [...document.querySelectorAll('#online-friends .friend-item')]
  .find((el) => el.textContent.includes('みか'));
mikaStrip.click();
await tick();
check('ロビー帯のフレンドをタップしても即入室せずメニューが出る',
  visible($('modal-friend-menu')) && !visible($('room-screen')));
check('メニューに相手の名前と居場所が出て、ルームに参加が押せる',
  $('fm-name').textContent === 'みか' &&
  $('fm-status').textContent.includes('はじめてさん集合') &&
  !$('fm-join').disabled);
$('fm-profile').click();
await tick();
check('プロフを見るでプロフィールが開く（自己紹介・勝利数つき）',
  visible($('modal-user-profile')) && $('up-name').textContent === 'みか' &&
  $('up-bio').textContent.includes('ワードウルフ大好き') &&
  $('up-wins').textContent === '42');
check('プロフにその人のギフト帯（王冠アート）が出る',
  document.querySelector('#up-gift-strip .gift-icon-img')?.getAttribute('src') === 'gifts/gift-crown.webp');
document.querySelector('#modal-user-profile [data-close]').click();
await tick();
mikaStrip.click();
await tick();
$('fm-join').click();
await tick(60);
check('ルームに参加で待機室に入れる', visible($('room-screen')));
$('room-back').click();
await tick();
check('待機室からロビーへ戻れる', !visible($('room-screen')));

// --- フレンドタブ：トーク一覧 ---
$('tabbtn-friends').click();
await tick();
const talkRows = document.querySelectorAll('#talk-list .talk-row');
check('トーク一覧に会話が3件出る（システム＋フレンド2人）', talkRows.length === 3, `${talkRows.length}件`);

// --- システム会話：ようこそDM＋チュートリアル導線 ---
const sysRow = rowByName($('talk-list'), 'システム');
check('トーク一覧にシステム会話（ようこそDM）が出る', !!sysRow);
sysRow.click();
await tick();
check('ようこそDMが開き、チュートリアルへの導線ボタンがある',
  visible($('dm-screen')) && $('dm-msgs-inner').textContent.includes('ようこそ')
  && !!document.querySelector('.welcome-tutorial-btn'));
check('システムDMは読み取り専用（入力欄が隠れる）', !visible($('dm-input-row')));
document.querySelector('.welcome-tutorial-btn').click();
await tick();
check('「チュートリアルはこちら」で閲覧モードのチュートリアルが開く',
  visible($('modal-tutorial')) && visible($('btn-tutorial-close')));
$('btn-tutorial-close').click();
$('dm-back').click();
await tick();
const mikaRow = rowByName($('talk-list'), 'みか');
check('みかの行に未読バッジ（1）が出る',
  mikaRow?.querySelector('.unread-badge')?.textContent === '1');
check('最新メッセージのプレビューが出る',
  mikaRow?.textContent.includes('部屋立てるから来て'));

// --- DM画面 ---
mikaRow.click();
await tick();
check('DM画面が開く（相手名つき）',
  visible($('dm-screen')) && $('dm-peer-name').textContent === 'みか');
const msgs = () => [...document.querySelectorAll('#dm-msgs-inner > *')];
check('DMの発言は下端寄せコンテナ（dm-msgs-inner）の中に時系列で並ぶ',
  msgs().length === 2 && msgs()[0].textContent.includes('昨日はありがとう')
  && msgs()[1].textContent.includes('部屋立てるから来て'));
check('DMを開くと未読バッジが消える',
  !rowByName($('talk-list'), 'みか')?.querySelector('.unread-badge'));

$('dm-input').value = 'うん、行く行く！';
$('dm-send').click();
await tick();
check('送信すると自分の吹き出しが末尾に追加される',
  msgs().length === 3 && msgs()[2].classList.contains('mine')
  && msgs()[2].textContent.includes('うん、行く行く！'));

$('dm-input').value = 'これ見て https://example.com';
$('dm-send').click();
await tick();
check('リンク入りメッセージは送れず、件数も増えない',
  msgs().length === 3 && $('toast').textContent.includes('リンク'));

// --- ギフト送信（DMから） ---
const coinsBefore = $('coin-count').textContent;
$('dm-gift-btn').click();
await tick();
check('ギフトモーダルが開き、カタログ8種が出る',
  visible($('modal-gift')) && document.querySelectorAll('#gift-grid .gift-item').length === 8);
document.querySelector('#gift-grid .gift-item[data-gift-key="heart"]').click();
await tick();
check('ギフトタップで確認ポップアップが出る（即送信しない）',
  visible($('modal-gift-confirm')) && $('gc-text').textContent.includes('ハート'));
$('gc-send').click();
await tick();
check('ギフト送信でコインピルが30減る',
  coinsBefore === '1,240' && $('coin-count').textContent === '1,210',
  `${coinsBefore} → ${$('coin-count').textContent}`);
check('DMにギフトカードが差し込まれる',
  msgs().length === 4 && msgs()[3].classList.contains('dm-gift-card')
  && msgs()[3].textContent.includes('ハート'));
check('送信後もギフト選択画面は開いたまま（連続で贈れる）',
  visible($('modal-gift')) && $('gift-balance').textContent === '1,210');
document.querySelector('#modal-gift [data-close]').click();
await tick();
check('ギフト画面の閉じるでモーダルが閉じる', !visible($('modal-gift')));
$('dm-back').click();
check('戻るでDM画面が閉じる', !visible($('dm-screen')));

// --- 送ったギフトが相手プロフへ即時反映される ---
{
  const row = rowByName($('friend-list'), 'みか');
  row.querySelector('.avatar').click();
  await tick();
  $('fm-profile').click();
  await tick();
  const heartItem = [...document.querySelectorAll('#up-gift-strip .gift-strip-item')]
    .find((el) => el.querySelector('.gift-icon-img')?.getAttribute('src') === 'gifts/gift-heart.webp');
  check('送ったハートがみかのプロフに×1で即時反映される',
    heartItem?.querySelector('.gift-count')?.textContent === '×1'
    && $('up-popularity').textContent === '350');
  document.querySelector('#modal-user-profile [data-close]').click();
  await tick();
  document.querySelector('#modal-friend-menu [data-close]').click();
  await tick();
}

// --- フレンドサブタブ：申請承認 ---
$('subtab-friend').click();
await tick();
check('届いている申請（そら）が見える',
  visible($('request-section')) && !!rowByName($('request-list'), 'そら'));
const soraRow = rowByName($('request-list'), 'そら');
[...soraRow.querySelectorAll('button')].find((b) => b.textContent === '承認').click();
await tick();
check('承認するとフレンド一覧に移り、申請欄が消える',
  !visible($('request-section')) && !!rowByName($('friend-list'), 'そら'));
const mikaFriendRow = rowByName($('friend-list'), 'みか');
mikaFriendRow.querySelector('.avatar').click();
await tick();
check('フレンド一覧のアイコンタップでもフレンドメニューが出る',
  visible($('modal-friend-menu')) && $('fm-name').textContent === 'みか');
document.querySelector('#modal-friend-menu [data-close]').click();
await tick();
const kenFriendRow = rowByName($('friend-list'), 'けん');
kenFriendRow.querySelector('.avatar').click();
await tick();
$('fm-profile').click();
await tick();
check('大桁ユーザーのプロフは人気度560,000・1,024勝で表示される',
  $('up-popularity').textContent === '560,000' && $('up-wins').textContent === '1,024');
document.querySelector('#modal-user-profile [data-close]').click();
await tick();

// --- ID検索→申請 ---
$('friend-search-input').value = 'mochi_9012';
$('btn-friend-search').click();
await tick();
const found = rowByName($('search-result'), 'もち');
check('公開IDで検索するとユーザーが出る', !!found);
[...found.querySelectorAll('button')].find((b) => b.textContent === '申請する').click();
await tick();
check('申請すると「申請中」表示になり、申請中リストにも出る',
  rowByName($('search-result'), 'もち')?.textContent.includes('申請中')
  && visible($('outgoing-section'))
  && !!rowByName($('outgoing-list'), 'もち'));
$('friend-search-input').value = 'zzzz9999';
$('btn-friend-search').click();
await tick();
check('存在しないIDは「見つかりませんでした」',
  $('search-result').textContent.includes('見つかりませんでした'));

// --- ブロック ---
const kenRow = rowByName($('friend-list'), 'けん');
[...kenRow.querySelectorAll('button')].find((b) => b.textContent === 'ブロック').click();
await tick();
check('ブロックするとフレンド一覧から消える',
  !rowByName($('friend-list'), 'けん'));
$('tabbtn-lobby').click();
$('btn-settings').click();
$('btn-blocklist').click();
await tick();
check('ブロックリストにけんが出る（解除ボタンつき）',
  visible($('modal-blocklist')) && !!rowByName($('blocklist-items'), 'けん'));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
