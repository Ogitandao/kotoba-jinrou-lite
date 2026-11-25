// 簡易検証：ロビー画面が開く・各要素が表示される・タブ切り替えと
// スティッキーボタンの挙動・主要なタップ操作が効くことを jsdom で確認する。
// 実行：npm run verify（要 jsdom。kl-config.js が無い状態＝ダミーモードで検証）
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const base = new URL('../client/', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const dom = new JSDOM(html, {
  // file:// を基点にして相対パスの CSS/JS をディスクから読ませる
  // （kl-config.js は存在しないので 404 相当になるが、config.js の既定値に落ちる）
  url: pathToFileURL(new URL('index.html', base).pathname).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

await new Promise((resolve) => {
  if (dom.window.document.readyState === 'complete') resolve();
  else dom.window.addEventListener('load', resolve);
});
// DOMContentLoaded ハンドラ内の初期描画が済むまで少し待つ
await new Promise((r) => setTimeout(r, 50));

const { document } = dom.window;
const $ = (id) => document.getElementById(id);
const visible = (el) => el && !el.classList.contains('hidden') && !el.classList.contains('panel-off');

// --- 表示要素 ---
check('タイトルバー＋⚙️設定ボタンが表示される',
  visible($('btn-settings')) && document.querySelector('.topbar-logo')?.getAttribute('alt') === 'ことば人狼');
check('プロフィール（名前・ID・自己紹介）が表示される',
  $('my-name').textContent === 'おぎ' &&
  $('my-id').textContent === 'ogi_2847' &&
  $('my-bio').textContent.length > 0);
check('自分のアイコンが四角（avatarクラス）でプリセット画像（おおかみ）表示される',
  $('my-avatar').classList.contains('avatar')
  && $('my-avatar').querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-wolf.webp');
check('コインピル（1,240＋チャージ）が表示される',
  visible($('pill-coins')) && $('coin-count').textContent === '1,240');
check('コインピルに「コイン」のラベル文字が無い（アイコン＋数字のみ）',
  !$('pill-coins').textContent.includes('コイン'));
check('人気度ピル（98）が表示される',
  visible($('pill-popularity')) && $('popularity-count').textContent === '98');
check('人気度ピルに「人気度」のラベル文字が無い（アイコン＋数字のみ）',
  !$('pill-popularity').textContent.includes('人気度'));
await new Promise((r) => setTimeout(r, 60));
check('ギフト帯が価格順に専用アート＋個数（2行表示）で並ぶ',
  document.querySelectorAll('#gift-strip .gift-strip-item').length === 16 &&
  document.querySelector('#gift-strip .gift-strip-item .gift-icon-img')?.getAttribute('src') === 'gifts/gift-diamond.webp' &&
  document.querySelector('#gift-strip .gift-strip-item .gift-count')?.textContent === '×1' &&
  $('gift-strip').textContent.includes('×34'));
check('ギフト帯は表示専用（ボタンではない・すべて見るも無い）',
  $('gift-strip').tagName === 'DIV' && !$('gift-strip').textContent.includes('すべて見る'));
check('ログインボーナスバナーが表示される', visible($('bonus-banner')));
check('オンラインの友達が12人表示される',
  document.querySelectorAll('#online-friends .friend-item').length === 12);
check('ランダム入室ボタンが表示される', visible($('btn-random')));
check('ルーム一覧に8件表示される',
  document.querySelectorAll('#room-list .room-card').length === 8);
const r3CardEl = [...document.querySelectorAll('#room-list .room-card')]
  .find((c) => c.dataset.roomId === 'r3');
const r8CardEl = [...document.querySelectorAll('#room-list .room-card')]
  .find((c) => c.dataset.roomId === 'r8');
check('逆転回答なしの部屋はカードにも「逆転回答なし」が出る',
  r3CardEl?.textContent.includes('逆転回答なし'));
check('逆転回答あり（標準）の部屋のカードには逆転ラベルが出ない',
  !r8CardEl?.textContent.includes('逆転回答'));
check('最長サンプル部屋は 7/8人 と表示される',
  r8CardEl?.textContent.includes('7/8人'));
const firstCard = document.querySelector('#room-list .room-card');
check('対戦中ルームはアバターに点滅ドット付き LIVE バッジが付く',
  !!firstCard.querySelector('.live-badge .pulse-dot') && firstCard.querySelector('.live-badge').textContent.includes('対戦中'));
check('対戦中バッジはタグ行には出ない（横幅対策）',
  !firstCard.querySelector('.room-meta').textContent.includes('対戦中'));
const r1Card = [...document.querySelectorAll('#room-list .room-card')]
  .find((c) => c.textContent.includes('はじめてさん集合'));
check('ルームカードに🔰初心者歓迎＋人数が入っていて、公開タグは無い',
  !r1Card.textContent.includes('公開') &&
  r1Card.textContent.includes('初心者歓迎') &&
  r1Card.textContent.includes('6/7人') &&
  !r1Card.querySelector('.room-lock'));
check('非公開ルームには鍵アイコンだけが出る（非公開の文字タグは無い）',
  [...document.querySelectorAll('#room-list .room-card')].some((c) => !!c.querySelector('.room-lock')) &&
  ![...document.querySelectorAll('#room-list .room-card')].some((c) => c.textContent.includes('非公開')));
check('一覧末尾にボタン分の余白（スペーサー）がある',
  !!document.querySelector('.list-end-spacer'));

// --- スティッキー作成ボタン ---
const createBar = $('create-bar');
const tabbar = document.querySelector('.tabbar');
check('ルームを作るボタンが下部メニューの直上にある（DOM順）',
  createBar.compareDocumentPosition(tabbar) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
  'create-bar → tabbar の順');
check('作成バーはスクロール領域の外（固定帯）にある',
  !document.querySelector('.scroll').contains(createBar));

// --- ログインボーナス受け取り ---
// データ層が非同期（Promise）になったため、反映を待ってから確認する
const tick = () => new Promise((r) => setTimeout(r, 10));
$('bonus-banner').click();
await tick();
check('ボーナス受け取りでコインが +10 される',
  $('coin-count').textContent === '1,250' && $('bonus-state').textContent === '獲得済み！');

// --- フレンドタブの同意ゲート（未同意の間は開けない） ---
check('未同意ではフレンドタブがグレーアウト（locked）になる',
  $('tabbtn-friends').classList.contains('locked'));
$('tabbtn-friends').click();
check('未同意ではフレンドタブをタップしても切り替わらない',
  visible($('tab-lobby')) && !visible($('tab-friends')));
check('未同意でフレンドタブをタップするとトーストで案内される',
  visible($('toast')) && $('toast').textContent.includes('チュートリアル'));

// --- ルーム作成（公開） ---
// 初回はチュートリアル（旧ルール同意を一本化）が先に出る
$('btn-create-room').click();
check('初回の作成前にはチュートリアルが出る（作成モーダルはまだ出ない）',
  visible($('modal-tutorial')) && !visible($('modal-create')));
check('チュートリアルは5枚のスライド構成',
  document.querySelectorAll('#tutorial-track .tutorial-slide').length === 5);
check('チュートリアルに遊び方とマナー（ペナルティ）の説明が入っている',
  $('modal-tutorial').textContent.includes('ウルフ')
  && $('modal-tutorial').textContent.includes('ペナルティ'));
check('最初のスライドでは「同意してはじめる」が出ない（キャンセルは出る）',
  !visible($('btn-tutorial-agree')) && visible($('btn-tutorial-cancel')));
$('modal-backdrop').click();
check('枠の外をタップしてもチュートリアルは閉じない',
  visible($('modal-tutorial')));
$('btn-tutorial-cancel').click();
check('キャンセルで同意せずに閉じられる（作成モーダルは開かない）',
  !visible($('modal-tutorial')) && !visible($('modal-create')));
$('btn-create-room').click();
check('キャンセル後は未同意のまま、再度試すとチュートリアルが再表示される',
  visible($('modal-tutorial')));
for (let i = 0; i < 4; i++) $('btn-tutorial-next').click();
check('最後のスライドでのみ「同意してはじめる」が出る',
  visible($('btn-tutorial-agree')));
$('btn-tutorial-agree').click();
await tick();
check('同意すると保留していた作成モーダルが開く', visible($('modal-create')));
check('同意するとフレンドタブのグレーアウトが解除される',
  !$('tabbtn-friends').classList.contains('locked'));
$('create-title').value = '検証用ルーム';
$('btn-create-confirm').click();
check('ティッカーにお知らせが流れている', $('ticker-track').textContent.includes('ことば人狼へようこそ'));
check('対戦中ルームは常時表示ではなく開始時に流れる（初期表示では流れない）', !$('ticker-track').textContent.includes('が対戦中です'));
check('公開ルームを作成すると一覧の先頭に増える',
  document.querySelectorAll('#room-list .room-card').length === 9 &&
  document.querySelector('#room-list .room-card').textContent.includes('検証用ルーム'));

check('新しく作ったルームはスライドイン用クラスが付く',
  document.querySelector('#room-list .room-card')?.classList.contains('enter') === true);
check('ルームを作るとティッカーに実イベントが流れる',
  $('ticker-track').textContent.includes('検証用ルーム') && $('ticker-track').textContent.includes('作りました'));
// --- ルーム作成（非公開：100コイン消費） ---
$('btn-create-room').click();
document.querySelector('input[name="create-visibility"][value="private"]').click();
$('create-title').value = '検証用・鍵部屋';
$('btn-create-confirm').click();
await tick();
check('非公開ルーム作成で100コイン減る',
  $('coin-count').textContent === '1,150' &&
  document.querySelector('#room-list .room-card').textContent.includes('検証用・鍵部屋'));

// --- コイン不足フロー ---
// 残高を不足状態にしてから作成すると、エラー＋チャージボタンが出ること
// 残高1,150から100ずつ消費：11回成功して50になり、12回目で不足エラーになる
for (let i = 0; i < 12; i++) {
  $('btn-create-room').click();
  document.querySelector('input[name="create-visibility"][value="private"]').click();
  $('btn-create-confirm').click();
  await tick();
}
check('コイン不足時は「コインが足りません」＋チャージボタンが出る',
  visible($('create-error')) && visible($('btn-create-charge')) && $('coin-count').textContent === '50',
  `残高=${$('coin-count').textContent}`);
$('btn-create-cancel').click();

// --- モーダル（設定／チャージ） ---
$('btn-settings').click();
check('⚙️で設定モーダル（ブロックリスト入り口）が開く',
  visible($('modal-settings')) && visible($('btn-blocklist')));
$('btn-rules').click();
check('設定からチュートリアルを再表示できる（閲覧モード：閉じるボタンだけ）',
  visible($('modal-tutorial')) && visible($('btn-tutorial-close')) && !visible($('btn-tutorial-cancel')));
$('btn-tutorial-close').click();
$('btn-settings').click();
document.querySelector('#modal-settings [data-close]').click();
$('pill-coins').click();
check('コインピルでチャージモーダルが開く', visible($('modal-charge')));
document.querySelector('#modal-charge [data-close]').click();

// --- 退室するとロビーに戻り、作成バーも戻る（作成で入室した状態から） ---
if (visible($('room-screen'))) { $('room-back').click(); await new Promise((r) => setTimeout(r, 450)); }
check('ルームを退室するとロビーに戻り、作成バーも戻る',
  !visible($('room-screen')) && visible($('create-bar')));

// --- 入室確認（他人のルームはカードタップで即入室しない） ---
const r1Card2 = [...document.querySelectorAll('#room-list .room-card')]
  .find((c) => c.dataset.roomId === 'r1');
r1Card2.click();
await tick();
check('ルームカードをタップすると入室確認が出る（即入室しない）',
  visible($('modal-join-confirm')) && !visible($('room-screen')));
check('入室確認にルーム名と人数が出る',
  $('jc-title').textContent.includes('はじめてさん集合') && $('jc-meta').textContent.includes('人'));
check('逆転回答あり（標準）の部屋は入室確認に逆転ラベルが出ない',
  !$('jc-meta').textContent.includes('逆転回答'));
document.querySelector('#modal-join-confirm [data-close]').click();
await tick();
check('入室確認でキャンセルするとロビーのまま', !visible($('room-screen')));
const r3Card = [...document.querySelectorAll('#room-list .room-card')]
  .find((c) => c.dataset.roomId === 'r3');
r3Card.click();
await tick();
check('逆転回答なしの部屋は入室確認に「逆転回答なし」が出る',
  visible($('modal-join-confirm')) && $('jc-meta').textContent.includes('逆転回答なし'));
document.querySelector('#modal-join-confirm [data-close]').click();
await tick();
r1Card2.click();
await tick();
$('jc-join').click();
await tick();
check('入室確認で「入室する」を押すと待機室が開く', visible($('room-screen')));
$('room-back').click();
await tick();

// --- タブ切り替え ---
$('tabbtn-friends').click();
check('フレンドタブへ切り替わる（ロビーが隠れ、作成バーも隠れる）',
  !visible($('tab-lobby')) && visible($('tab-friends')) && !visible($('create-bar')));
check('初期サブタブはトーク', visible($('subpanel-talk')) && !visible($('subpanel-friend')));
$('subtab-friend').click();
await new Promise((r) => setTimeout(r, 400)); // スライドアニメーション完了待ち
check('サブタブ（フレンド）へ切り替わる',
  visible($('subpanel-friend')) && !visible($('subpanel-talk')));
$('subtab-talk').click();
$('tabbtn-lobby').click();
check('ロビータブへ戻れる（作成バーも戻る）',
  visible($('tab-lobby')) && !visible($('tab-friends')) && visible($('create-bar')));

// --- 自己紹介の編集（0020） ---
$('my-bio').click();
check('自己紹介タップで編集モーダルが開き、現在の文が入っている',
  visible($('modal-bio')) && $('bio-input').value.length > 0);
$('bio-input').value = '検証用の自己紹介です';
$('bio-input').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
check('文字数カウンタが入力に追随する', $('bio-count').textContent === '10');
$('bio-save').click();
await new Promise((r) => setTimeout(r, 30));
check('保存するとロビーの自己紹介が即変わる',
  $('my-bio').textContent.includes('検証用の自己紹介です') && !visible($('modal-bio')));
$('my-bio').click();
$('bio-input').value = '';
$('bio-save').click();
await new Promise((r) => setTimeout(r, 30));
check('空で保存すると「自己紹介（タップで編集）」の案内表示に戻る',
  $('my-bio').textContent === '自己紹介（タップで編集）' && $('my-bio').classList.contains('empty'));

check('名前タップで編集モーダルが開く', (() => {
  $('my-name-btn').click();
  const open = !$('modal-name').classList.contains('hidden');
  const pencil = !!document.querySelector('.name-pencil');
  return open && pencil;
})());
check('名前を変更するとロビーに反映される', await (async () => {
  $('name-input').value = 'あたらしいなまえ';
  $('name-input').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  $('name-save').click();
  await new Promise((r) => setTimeout(r, 60));
  return $('my-name').textContent === 'あたらしいなまえ'
    && $('modal-name').classList.contains('hidden');
})());
check('縦固定：横向き案内オーバーレイがある', !!$('rotate-notice'));
check('縦固定：横向きメディアクエリで表示する CSS がある',
  readFileSync(new URL('styles.css', base), 'utf8').includes('(orientation: landscape)'));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
