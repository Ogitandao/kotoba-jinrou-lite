// ソーシャル系ロジックの検証：sim/social.mjs（RPC 相当のサーバー側
// ロジック）に対して、フレンド申請フロー／DM／ギフトとコイン整合を
// 自動テストする。エラーコードは supabase/migrations/0005_rpc_social.sql
// の RPC と揃えてあることを前提に、コードで分岐を確認する。
// 実行：npm run verify:social
import { SocialSim, GIFT_CATALOG } from '../sim/social.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function expectCode(name, fn, code) {
  try {
    fn();
    check(name, false, '例外が出なかった');
  } catch (e) {
    check(name, e.code === code, `code=${e.code}`);
  }
}

const sim = new SocialSim();
sim.createUser({ id: 'alice', publicId: 'ALICE001', name: 'ありす' });
sim.createUser({ id: 'bob', publicId: 'BOB00002', name: 'ぼぶ' });
sim.createUser({ id: 'carol', publicId: 'CAROL003', name: 'きゃろる' });
sim.createUser({ id: 'dave', publicId: 'DAVE0004', name: 'でいぶ' });

// --- 登録ボーナス（handle_new_user 相当） ---
check('登録ボーナス100コインが無料残高に入る',
  sim.balanceOf('alice').free === 100 && sim.balanceOf('alice').paid === 0);
check('登録ボーナスが台帳に welcome で残る',
  sim.ledger.some((r) => r.userId === 'alice' && r.reason === 'welcome' && r.deltaFree === 100));

// --- ID 検索 ---
check('公開IDの完全一致で検索できる（大小文字不問）',
  sim.searchUser('alice', 'bob00002')?.id === 'bob');
check('存在しないIDは null', sim.searchUser('alice', 'ZZZZ9999') === null);
check('自分は検索結果に出ない', sim.searchUser('alice', 'ALICE001') === null);

// --- フレンド申請フロー ---
check('申請を送ると requested', sim.sendFriendRequest('alice', 'bob') === 'requested');
expectCode('二重申請は ALREADY_REQUESTED', () => sim.sendFriendRequest('alice', 'bob'), 'ALREADY_REQUESTED');
check('相手側に届いている申請が見える',
  sim.incomingRequests('bob').map((u) => u.id).join() === 'alice');
check('検索結果の関係が requested_in になる',
  sim.searchUser('bob', 'ALICE001')?.relation === 'requested_in');
check('却下すると申請が消える',
  sim.respondFriendRequest('bob', 'alice', false) === 'rejected'
  && sim.incomingRequests('bob').length === 0
  && !sim.areFriends('alice', 'bob'));
sim.sendFriendRequest('alice', 'bob');
check('承認するとフレンド成立',
  sim.respondFriendRequest('bob', 'alice', true) === 'accepted'
  && sim.areFriends('alice', 'bob')
  && sim.friendsOf('alice').map((u) => u.id).join() === 'bob');
expectCode('フレンド同士の申請は ALREADY_FRIENDS',
  () => sim.sendFriendRequest('alice', 'bob'), 'ALREADY_FRIENDS');
expectCode('無い申請への回答は REQUEST_NOT_FOUND',
  () => sim.respondFriendRequest('carol', 'alice', true), 'REQUEST_NOT_FOUND');
check('逆向き申請は自動で承認になる（相互申請）',
  sim.sendFriendRequest('carol', 'dave') === 'requested'
  && sim.sendFriendRequest('dave', 'carol') === 'accepted'
  && sim.areFriends('carol', 'dave'));

// --- DM ---
const m1 = sim.sendDm('alice', 'bob', 'こんにちは！');
check('フレンド同士で DM が送れる', m1.kind === 'text' && m1.body === 'こんにちは！');
sim.sendDm('bob', 'alice', 'やっほー');
check('未読数が数えられる', sim.unreadCount('alice', 'bob') === 1);
check('既読にすると未読が消える',
  sim.markDmRead('alice', 'bob') === 1 && sim.unreadCount('alice', 'bob') === 0);
check('会話一覧に相手と最新メッセージが出る',
  sim.conversations('alice').length === 1
  && sim.conversations('alice')[0].last.body === 'やっほー');
expectCode('フレンドでない相手への DM は NOT_FRIENDS',
  () => sim.sendDm('alice', 'carol', 'hi'), 'NOT_FRIENDS');
expectCode('空メッセージは EMPTY_MESSAGE',
  () => sim.sendDm('alice', 'bob', '   '), 'EMPTY_MESSAGE');
expectCode('URL は URL_NOT_ALLOWED（DM のリンク禁止）',
  () => sim.sendDm('alice', 'bob', '見て https://example.com'), 'URL_NOT_ALLOWED');
expectCode('501文字は MESSAGE_TOO_LONG',
  () => sim.sendDm('alice', 'bob', 'あ'.repeat(501)), 'MESSAGE_TOO_LONG');

// --- ギフトとコイン整合 ---
const heart = GIFT_CATALOG.find((g) => g.key === 'heart'); // 30コイン
const beforeBobPop = sim.getUser('bob').popularity;
const g1 = sim.sendGift('alice', 'bob', 'heart');
check('ギフト送信で残高が価格分減る（無料分から）',
  g1.freeBalance === 70 && g1.paidBalance === 0);
check('もらった側は人気度だけが価格分上がり、コインは増えない',
  sim.getUser('bob').popularity === beforeBobPop + heart.price
  && sim.balanceOf('bob').total === 100);
check('ギフト台帳（gift_sent）と残高が検算で一致する',
  sim.ledgerMatchesWallet('alice')
  && sim.ledger.some((r) => r.reason === 'gift_sent' && r.deltaFree === -30 && r.refId === g1.historyId));
check('ギフトカードが DM に差し込まれる',
  sim.messagesWith('alice', 'bob').some((m) => m.kind === 'gift' && m.giftPayload.giftKey === 'heart'));
check('もらったギフトの集計に出る',
  sim.giftsReceived('bob').some((g) => g.giftKey === 'heart' && g.count === 1));
expectCode('存在しないギフトは GIFT_NOT_FOUND',
  () => sim.sendGift('alice', 'bob', 'spaceship'), 'GIFT_NOT_FOUND');
expectCode('残高不足のギフトは INSUFFICIENT_COINS',
  () => sim.sendGift('alice', 'bob', 'crown'), 'INSUFFICIENT_COINS');
check('失敗したギフトで残高・台帳は変わらない',
  sim.balanceOf('alice').total === 70 && sim.ledgerMatchesWallet('alice'));

// 課金残高が混ざるケース：無料→課金の順で消費されること
// IAP 購入相当：財布と台帳の両方に purchase として入れる（実環境の姿）
sim.wallets.get('carol').paid = 1000;
sim.ledger.push({ userId: 'carol', deltaFree: 0, deltaPaid: 1000, reason: 'purchase', refId: null });
const g2 = sim.sendGift('carol', 'dave', 'ring'); // 1000 = 無料100 + 課金900
check('消費は無料分から先（無料100→0、課金1000→100）',
  g2.freeBalance === 0 && g2.paidBalance === 100 && sim.ledgerMatchesWallet('carol'));

// --- ログインボーナス ---
const b1 = sim.claimLoginBonus('alice', '2026-11-24');
check('ログインボーナス +10（1日1回）',
  b1.claimed === true && b1.freeBalance === 80);
const b2 = sim.claimLoginBonus('alice', '2026-11-24');
check('同日2回目は claimed=false で増えない',
  b2.claimed === false && sim.balanceOf('alice').free === 80);
const b3 = sim.claimLoginBonus('alice', '2026-11-25');
check('翌日はまた受け取れる',
  b3.claimed === true && sim.balanceOf('alice').free === 90 && sim.ledgerMatchesWallet('alice'));

// --- ブロック ---
sim.blockUser('alice', 'bob');
check('ブロックでフレンド関係が解除される', !sim.areFriends('alice', 'bob'));
expectCode('ブロック相手への DM は BLOCKED',
  () => sim.sendDm('alice', 'bob', 'hi'), 'BLOCKED');
expectCode('ブロックされた側からの申請も BLOCKED',
  () => sim.sendFriendRequest('bob', 'alice'), 'BLOCKED');
check('ブロックした相手は自分の検索に出ない',
  sim.searchUser('alice', 'BOB00002') === null);
check('ブロックリストに出る／解除できる',
  sim.blockedList('alice').map((u) => u.id).join() === 'bob'
  && (sim.unblockUser('alice', 'bob'), sim.blockedList('alice').length === 0));
check('解除後は申請がまた通る',
  sim.sendFriendRequest('alice', 'bob') === 'requested');

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
process.exit(failed.length ? 1 : 0);
