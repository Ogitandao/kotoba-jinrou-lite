// キックされた側の画面遷移の jsdom 検証（SimBackend）
// 実行: node scripts/verify-kick-side.mjs
//
// 2026-11-27 おぎ実機報告の再発防止：
// マスターにキックされた側のクライアントが、0人の待機室画面に
// 取り残されず、ロビーへ戻ってトーストが出ること。
// 実サーバーでは「自分のメンバー行が消えた」がポーリングで届く。
// ここでは KL_DATA.getRoom の戻りを差し替えてその状態を再現する
// （pollRoom は DATA 経由で毎回プロパティ参照するため差し替えが効く）。
// 同じ経路で「ルーム自体が closed になった」場合の退出も確認する。
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
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
for (const rel of ['js/dummy-data.js', 'js/data-adapter.js', 'js/app.js']) {
  window.eval(readFileSync(path.join(client, rel), 'utf8'));
}
document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

const $ = (id) => document.getElementById(id);
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const visible = (el) => el && !el.classList.contains('hidden');
async function waitFor(fn, timeoutMs = 6000, stepMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await tick(stepMs);
  }
  return fn();
}

await tick(80);

// --- けん の部屋へ DM 招待カードから入室（メンバー側になる） ---
$('tabbtn-friends').click();
await tick(30);
const kenRow = [...document.querySelectorAll('#talk-list .talk-row')]
  .find((r) => r.querySelector('.talk-name')?.textContent === 'けん');
check('トーク一覧にけんとの会話がある', !!kenRow);
kenRow.click();
await tick(30);
const inviteCard = document.querySelector('#dm-msgs-inner .dm-invite-card');
check('DMに招待カードがある', !!inviteCard);
inviteCard.click();
await tick(60);

// 初回入室はチュートリアル同意が挟まる：最後のスライドまで進めて同意
if (visible($('modal-tutorial'))) {
  for (let i = 0; i < 8 && !visible($('btn-tutorial-agree')); i++) $('btn-tutorial-next').click();
  $('btn-tutorial-agree').click();
  await tick(60);
}
check('招待から待機室に入れた（メンバー側）',
  visible($('room-screen')) && $('room-screen-title').textContent.includes('経験者もOK'),
  $('room-screen-title')?.textContent);

// --- キック再現：次のポーリングから「自分がメンバーでない」詳細を返す ---
const KL = window.KL_DATA;
const origGetRoom = KL.getRoom.bind(KL);
let serverView = 'member';
KL.getRoom = async (roomId) => {
  const d = await origGetRoom(roomId);
  if (serverView === 'kicked') {
    return { ...d, isMember: false, isHost: false, players: 0, members: [], roomMessages: d.roomMessages ?? [] };
  }
  if (serverView === 'closed') {
    return { ...d, status: 'closed' };
  }
  return d;
};

serverView = 'kicked';
const kickedOut = await waitFor(() => !$('room-screen').classList.contains('open'), 5000);
check('キックされたら待機室が自動で閉じる', kickedOut);
check('「マスターにキックされました」のトーストが出る',
  $('toast').textContent.includes('キックされました'), $('toast').textContent);
await tick(500);
check('ロビー（ルーム一覧）に戻っている',
  visible($('room-list')) || document.querySelectorAll('#room-list .room-card').length > 0);

// --- 部屋終了の再現：もう一度入室してから closed を返す ---
serverView = 'member';
KL.getRoom = origGetRoom;
$('tabbtn-friends').click();
await tick(30);
const kenRow2 = [...document.querySelectorAll('#talk-list .talk-row')]
  .find((r) => r.querySelector('.talk-name')?.textContent === 'けん');
kenRow2.click();
await tick(30);
const inviteCard2 = document.querySelector('#dm-msgs-inner .dm-invite-card');
inviteCard2.click();
await tick(60);
check('再入室できる', visible($('room-screen')));
KL.getRoom = async (roomId) => {
  const d = await origGetRoom(roomId);
  return serverView === 'closed' ? { ...d, status: 'closed' } : d;
};
serverView = 'closed';
const closedOut = await waitFor(() => !$('room-screen').classList.contains('open'), 5000);
check('ルームが終了したら待機室が自動で閉じる', closedOut);
check('「ルームは終了しました」のトーストが出る',
  $('toast').textContent.includes('終了しました'), $('toast').textContent);

const failures = results.filter((r) => !r.ok).length;
console.log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.length} checks) ===`);
process.exit(failures ? 1 : 0);
