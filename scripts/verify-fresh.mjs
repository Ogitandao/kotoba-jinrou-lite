// まっさら体験（?fresh=1）の検証：新規登録直後の状態で起動し、
// ログイン→名前セットアップ→空のロビー、の本番初回フローと
// 空表示の前提（コイン100・人気度0・ギフトなし・ルーム0・未同意）
// を jsdom で確認する。
// 実行：node scripts/verify-fresh.mjs（データ層は SimBackend）
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const base = new URL('../client/', import.meta.url);
const html = readFileSync(new URL('index.html', base), 'utf8');
const dom = new JSDOM(html, {
  url: `${pathToFileURL(new URL('index.html', base).pathname).href}?fresh=1`,
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
await tick(80);

const { document } = dom.window;
const $ = (id) => document.getElementById(id);
const visible = (el) => el && !el.classList.contains('hidden');

check('ログイン画面が表示され、名前セットアップはまだ出ていない',
  visible($('login-screen')) && !visible($('modal-name')));

$('btn-login-google').click();
await tick(1300);
check('ログインすると名前セットアップが出る（ログイン→名前の順）',
  !visible($('login-screen')) && visible($('modal-name')));

$('name-input').value = 'まっさら太郎';
$('name-input').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
$('name-save').click();
await tick(80);
check('名前を決めると閉じてロビーに反映される',
  !visible($('modal-name')) && $('my-name').textContent === 'まっさら太郎');

check('コインは登録ボーナスの100・人気度は0',
  $('coin-count').textContent === '100' && $('popularity-count').textContent === '0');
check('ギフト帯は空表示（まだギフトがありません）',
  $('gift-strip').textContent.includes('まだギフトがありません'));
check('ルーム一覧は0件（カードが無い）',
  document.querySelectorAll('#room-list .room-card').length === 0);
check('自己紹介は未設定の案内表示',
  $('my-bio').textContent === '自己紹介（タップで編集）');
check('フレンドタブは未同意でロックされている',
  $('tabbtn-friends').classList.contains('locked'));
check('オンラインフレンド帯は空',
  document.querySelectorAll('#online-friends .online-friend').length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
