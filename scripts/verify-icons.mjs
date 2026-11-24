// アイコンシステム＋オンラインバッジ表示範囲の jsdom 検証（SimBackend）
// 実行: node scripts/verify-icons.mjs
//
// 2026-11-25 バッチの検証：
// [I1] 無料プリセット15種の同梱画像が揃っている
// [I2] ロビーの自分のアイコンをタップ → 選択グリッド（15種・選択中表示）
// [I3] 選択すると即反映され、Sim でも再読込で維持される
//      （実 DB では profiles.icon_key が正本）
// [I4] 他プレイヤーのアイコンも画像で表示される（プリセットが無い
//      ユーザーは絵文字にフォールバック）
// [I5] オンラインバッジ（緑ドット）はロビーの「オンラインの友達」枠と
//      DM 画面だけに出る（フレンド一覧・トーク一覧には出ない。
//      待機室・対戦画面分は verify-game-ui の [21] で確認）
// [I6] DM招待カードにルーム名が出て、パスワード表示＋コピーは
//      非公開の招待だけに付く
import { readFileSync, existsSync } from 'node:fs';
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
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const KEYS = ['dog', 'cat', 'rabbit', 'bear', 'panda', 'penguin', 'owl', 'fox',
  'tanuki', 'chick', 'frog', 'koala', 'tiger', 'seal', 'wolf'];

check('[I1] 無料プリセット15種の画像が client/icons/ に同梱されている',
  KEYS.every((k) => existsSync(path.join(client, 'icons', `icon-${k}.webp`))));

function boot(preseedIconKey = null) {
  const html = readFileSync(path.join(client, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  if (preseedIconKey) window.localStorage.setItem('kl_icon_key', preseedIconKey);
  // このスイートはアイコン検証が目的のため、チュートリアル同意は
  // 済ませた状態で起動する（同意ゲート自体は lobby/social-ui で検証）
  window.localStorage.setItem('kl_rules_agreed', '1');
  for (const rel of ['js/dummy-data.js', 'js/data-adapter.js', 'js/app.js']) {
    window.eval(readFileSync(path.join(client, rel), 'utf8'));
  }
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return dom;
}

const dom = boot();
const { window } = dom;
const { document } = window;
const $ = (id) => document.getElementById(id);
const visible = (el) => el && !el.classList.contains('hidden');
const KL = () => window.KL_DATA;
await tick(80);

// --- データ層 ---
const catalog = await KL().listIcons();
check('[I2] カタログは無料15種・全て所有扱い',
  catalog.length === 15 && catalog.every((c) => c.tier === 'free' && c.owned),
  `n=${catalog.length}`);
check('[I2] 初期選択は おおかみ（wolf）',
  catalog.find((c) => c.selected)?.key === 'wolf');
check('[I1] KL_ICON_SRC は同梱キーだけ URL を返し、未知キーは null',
  window.KL_ICON_SRC('wolf') === 'icons/icon-wolf.webp'
  && window.KL_ICON_SRC('bogus') === null
  && window.KL_ICON_SRC(null) === null);
const badIcon = await KL().setIcon('bogus').then(() => null, (e) => e);
check('[I3] 存在しないアイコンの選択は ICON_NOT_FOUND で拒否',
  badIcon?.code === 'ICON_NOT_FOUND', badIcon?.code ?? 'no error');

// --- ロビー表示 ---
check('[I4] 自分のアイコンが画像（おおかみ）で表示される',
  $('my-avatar').querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-wolf.webp');
const firstCard = document.querySelector('#room-list .room-card');
check('[I4] ルームカードのホストアイコンも画像（みか＝うさぎ）',
  firstCard?.querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-rabbit.webp',
  firstCard?.innerHTML.slice(0, 120) ?? 'no card');
const stripItems = [...document.querySelectorAll('#online-friends .friend-item')];
const mikaStrip = stripItems.find((el) => el.textContent.includes('みか'));
check('[I5] オンラインの友達帯：画像アイコン＋緑ドットが出る',
  mikaStrip?.querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-rabbit.webp'
  && !!mikaStrip?.querySelector('.dot.dot-on'));

// --- 選択モーダル ---
$('my-avatar').click();
await tick(60);
check('[I2] アイコンをタップすると選択モーダルが開く', visible($('modal-avatar')));
check('[I2] グリッドに15種が出て、おおかみに選択中が付く',
  document.querySelectorAll('#icon-grid .icon-choice').length === 15
  && document.querySelector('#icon-grid .icon-choice[data-icon-key="wolf"]')
    ?.classList.contains('selected'));
check('[I2] 勝利数解放・コイン購入は「今後追加」の案内が出る',
  visible($('icon-win-note')) && visible($('icon-coin-note')));
document.querySelector('#icon-grid .icon-choice[data-icon-key="cat"]').click();
await tick(60);
check('[I3] ねこを選ぶとロビーの自分のアイコンが即変わる',
  $('my-avatar').querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-cat.webp');
check('[I3] プレビューとグリッドの選択中もねこに移る',
  $('avatar-modal-preview').querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-cat.webp'
  && document.querySelector('#icon-grid .icon-choice[data-icon-key="cat"]')
    ?.classList.contains('selected'));
check('[I3] 選択が localStorage に残る（Sim の再読込維持）',
  window.localStorage.getItem('kl_icon_key') === 'cat');
document.querySelector('#modal-avatar [data-close]').click();
await tick(20);

// --- フレンド／トーク／DM の表示 ---
$('tabbtn-friends').click();
await tick(40);
const friendRow = (name) => [...document.querySelectorAll('#friend-list .user-row')]
  .find((r) => r.textContent.includes(name));
check('[I4] フレンド一覧：みかは画像（うさぎ）で表示される',
  friendRow('みか')?.querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-rabbit.webp');
check('[I4] フレンド一覧：りすはプリセットが無いので絵文字のまま',
  !friendRow('りす')?.querySelector('img.avatar-img')
  && (friendRow('りす')?.textContent.includes('🐿️') ?? false));
check('[I5] フレンド一覧に緑ドットは出ない',
  document.querySelectorAll('#friend-list .dot').length === 0);
const talkRow = (name) => [...document.querySelectorAll('#talk-list .talk-row')]
  .find((r) => r.textContent.includes(name));
check('[I5] トーク一覧に緑ドットは出ない（画像アイコンは出る）',
  document.querySelectorAll('#talk-list .dot').length === 0
  && talkRow('みか')?.querySelector('img.avatar-img') != null);
talkRow('みか').click();
await tick(40);
check('[I5] DM画面：相手アイコンに画像＋緑ドットが出る',
  $('dm-peer-avatar').querySelector('img.avatar-img')?.getAttribute('src') === 'icons/icon-rabbit.webp'
  && !!$('dm-peer-avatar').querySelector('.dot.dot-on'));
$('dm-back').click();
await tick(20);

// --- 招待カードの表示（シード：けんからの非公開招待） ---
talkRow('けん').click();
await tick(40);
const card = document.querySelector('#dm-msgs-inner .dm-invite-card');
check('[I6] 招待カードにルーム名が出る',
  !!card && card.textContent.includes('経験者もOK！真剣勝負部屋'),
  card?.textContent ?? 'no card');
check('[I6] 非公開の招待にはパスワード表示＋コピーボタンが付く',
  card?.textContent.includes('パスワード：wolf777')
  && [...card.querySelectorAll('button')].some((b) => b.textContent === 'コピー'));
$('dm-back').click();
window.close();

// --- 再読込での維持（Sim は localStorage が肩代わり） ---
const dom2 = boot('cat');
const doc2 = dom2.window.document;
await tick(80);
check('[I3] 再読込後も選択したアイコン（ねこ）が維持される',
  doc2.getElementById('my-avatar').querySelector('img.avatar-img')
    ?.getAttribute('src') === 'icons/icon-cat.webp');
dom2.window.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
