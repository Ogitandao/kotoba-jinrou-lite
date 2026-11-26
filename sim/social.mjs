// ソーシャル系（プロフィール／フレンド／DM／ギフト／コイン）の
// 「サーバー側ロジック」ローカル実証版。
//
// supabase/migrations/0005_rpc_social.sql の RPC 群
// （kl_search_user / kl_send_friend_request / kl_respond_friend_request /
// kl_remove_friend / kl_block_user / kl_unblock_user / kl_send_dm /
// kl_mark_dm_read / kl_send_gift / kl_claim_login_bonus）と、
// 0001〜0004 のテーブル・トリガ（登録ボーナス100、財布の無料／課金分離、
// 消費は無料分から）を、インメモリで再現したもの。
// エラーコードは SQL 側と揃えてある（raise exception 'CODE: ...' に対応）。
//
// 実環境との対応：
// - createUser の登録ボーナス = handle_new_user トリガ
// - claimLoginBonus の today 引数 = DB 側の JST 日付（テストが日付を渡す）
// - 同期実行 = トランザクションの直列化

export const GIFT_CATALOG = Object.freeze([
  { key: 'heart', name: 'ハート', icon: '❤️', price: 30 },
  { key: 'flower', name: 'お花', icon: '🌸', price: 50 },
  { key: 'candy', name: 'キャンディ', icon: '🍬', price: 100 },
  { key: 'coffee', name: 'コーヒー', icon: '☕', price: 100 },
  { key: 'cake', name: 'ケーキ', icon: '🎂', price: 300 },
  { key: 'teddy', name: 'テディベア', icon: '🧸', price: 500 },
  { key: 'ring', name: '指輪', icon: '💍', price: 1000 },
  { key: 'devil', name: '小悪魔', icon: '😈', price: 2000 },
  { key: 'crown', name: '王冠', icon: '👑', price: 3000 },
  { key: 'dragon', name: 'ドラゴン', icon: '🐲', price: 5000 },
  { key: 'diamond', name: 'ダイヤモンド', icon: '💎', price: 10000 },
]);

export const WELCOME_COINS = 100;
export const LOGIN_BONUS_COINS = 10;
export const DM_MAX_LENGTH = 500;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

const pairKey = (a, b) => [a, b].sort().join('|');

export class SocialSim {
  constructor() {
    this.users = new Map(); // id -> profile
    this.wallets = new Map(); // id -> { free, paid, lastLoginBonusDate }
    this.ledger = []; // { userId, deltaFree, deltaPaid, reason, refId }
    this.requests = []; // { fromId, toId }
    this.friendships = new Set(); // pairKey
    this.blocks = []; // { blockerId, blockedId }
    this.dm = []; // { id, senderId, recipientId, kind, body, invitePayload, giftPayload, readAt, at }
    this.giftHistory = []; // { id, senderId, receiverId, giftKey, price }
    this.seq = 0;
  }

  _nextId(prefix) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  // ---------- 登録（handle_new_user トリガ相当） ----------

  createUser({ id, publicId, name, icon = '🐺', iconBg = '#eef4ff', bio = '' }) {
    if (this.users.has(id)) fail('USER_EXISTS', 'ユーザーが既に存在します');
    const user = {
      id, publicId, name, icon, iconBg, bio,
      popularity: 0, wordwolfWins: 0, lastSeenAt: null,
    };
    this.users.set(id, user);
    this.wallets.set(id, { free: WELCOME_COINS, paid: 0, lastLoginBonusDate: null });
    this.ledger.push({ userId: id, deltaFree: WELCOME_COINS, deltaPaid: 0, reason: 'welcome', refId: null });
    return user;
  }

  getUser(id) {
    const u = this.users.get(id);
    if (!u) fail('USER_NOT_FOUND', 'ユーザーが存在しません');
    return u;
  }

  walletOf(id) {
    this.getUser(id);
    return this.wallets.get(id);
  }

  balanceOf(id) {
    const w = this.walletOf(id);
    return { free: w.free, paid: w.paid, total: w.free + w.paid };
  }

  // ---------- 関係ヘルパー ----------

  areFriends(a, b) {
    return this.friendships.has(pairKey(a, b));
  }

  blockedEither(a, b) {
    return this.blocks.some(
      (x) => (x.blockerId === a && x.blockedId === b)
        || (x.blockerId === b && x.blockedId === a),
    );
  }

  _blockedByMe(a, b) {
    return this.blocks.some((x) => x.blockerId === a && x.blockedId === b);
  }

  _hasRequest(fromId, toId) {
    return this.requests.some((r) => r.fromId === fromId && r.toId === toId);
  }

  _dropRequest(fromId, toId) {
    this.requests = this.requests.filter((r) => !(r.fromId === fromId && r.toId === toId));
  }

  // ---------- ID 検索（kl_search_user） ----------

  searchUser(meId, publicId) {
    this.getUser(meId);
    const needle = String(publicId ?? '').trim().toUpperCase();
    for (const u of this.users.values()) {
      if (u.publicId.toUpperCase() !== needle) continue;
      if (u.id === meId) return null;
      if (this._blockedByMe(meId, u.id)) return null;
      let relation = 'none';
      if (this.areFriends(meId, u.id)) relation = 'friend';
      else if (this._hasRequest(meId, u.id)) relation = 'requested_out';
      else if (this._hasRequest(u.id, meId)) relation = 'requested_in';
      else if (this.blocks.some((x) => x.blockerId === u.id && x.blockedId === meId)) relation = 'blocked_by';
      return { ...u, relation };
    }
    return null;
  }

  // ---------- フレンド申請（kl_send_friend_request 等） ----------

  sendFriendRequest(meId, toId) {
    this.getUser(meId);
    if (toId === meId) fail('SELF_ACTION', '自分には申請できません');
    this.getUser(toId);
    if (this.blockedEither(meId, toId)) fail('BLOCKED', 'このユーザーとは申請できません');
    if (this.areFriends(meId, toId)) fail('ALREADY_FRIENDS', 'すでにフレンドです');
    if (this._hasRequest(meId, toId)) fail('ALREADY_REQUESTED', 'すでに申請中です');
    if (this._hasRequest(toId, meId)) {
      this._dropRequest(toId, meId);
      this.friendships.add(pairKey(meId, toId));
      return 'accepted';
    }
    this.requests.push({ fromId: meId, toId });
    return 'requested';
  }

  respondFriendRequest(meId, fromId, accept) {
    if (!this._hasRequest(fromId, meId)) fail('REQUEST_NOT_FOUND', '申請が存在しません');
    this._dropRequest(fromId, meId);
    if (accept) {
      this.friendships.add(pairKey(meId, fromId));
      return 'accepted';
    }
    return 'rejected';
  }

  removeFriend(meId, otherId) {
    this.friendships.delete(pairKey(meId, otherId));
  }

  friendsOf(meId) {
    const out = [];
    for (const key of this.friendships) {
      const [a, b] = key.split('|');
      if (a === meId) out.push(this.users.get(b));
      else if (b === meId) out.push(this.users.get(a));
    }
    return out;
  }

  incomingRequests(meId) {
    return this.requests.filter((r) => r.toId === meId).map((r) => this.users.get(r.fromId));
  }

  outgoingRequests(meId) {
    return this.requests.filter((r) => r.fromId === meId).map((r) => this.users.get(r.toId));
  }

  // ---------- ブロック（kl_block_user / kl_unblock_user） ----------

  blockUser(meId, otherId) {
    this.getUser(meId);
    if (otherId === meId) fail('SELF_ACTION', '自分はブロックできません');
    this.getUser(otherId);
    this.friendships.delete(pairKey(meId, otherId));
    this._dropRequest(meId, otherId);
    this._dropRequest(otherId, meId);
    if (!this._blockedByMe(meId, otherId)) {
      this.blocks.push({ blockerId: meId, blockedId: otherId });
    }
  }

  unblockUser(meId, otherId) {
    this.blocks = this.blocks.filter(
      (x) => !(x.blockerId === meId && x.blockedId === otherId),
    );
  }

  blockedList(meId) {
    return this.blocks
      .filter((x) => x.blockerId === meId)
      .map((x) => this.users.get(x.blockedId));
  }

  // ---------- DM（kl_send_dm / kl_mark_dm_read） ----------

  sendDm(meId, toId, bodyRaw) {
    this.getUser(meId);
    if (toId === meId) fail('SELF_ACTION', '自分には送れません');
    this.getUser(toId);
    if (this.blockedEither(meId, toId)) fail('BLOCKED', 'このユーザーには送れません');
    if (!this.areFriends(meId, toId)) fail('NOT_FRIENDS', 'DM はフレンド同士でのみ送れます');
    const body = String(bodyRaw ?? '').trim();
    if (body.length === 0) fail('EMPTY_MESSAGE', '本文が空です');
    if (body.length > DM_MAX_LENGTH) fail('MESSAGE_TOO_LONG', '500文字以内で入力してください');
    if (/https?:\/\/|www\./i.test(body)) fail('URL_NOT_ALLOWED', 'DM ではリンクを送れません');
    const msg = {
      id: this._nextId('dm'), senderId: meId, recipientId: toId,
      kind: 'text', body, invitePayload: null, giftPayload: null,
      readAt: null, at: this.seq,
    };
    this.dm.push(msg);
    return msg;
  }

  messagesWith(meId, otherId) {
    const cut = this.clearSeqOf(meId, otherId);
    return this.dm.filter(
      (m) => m.at >= cut
        && ((m.senderId === meId && m.recipientId === otherId)
          || (m.senderId === otherId && m.recipientId === meId)),
    );
  }

  // 0053：トーク削除は「自分の画面からだけ」。相手の画面には影響せず、
  // 削除後に来たメッセージだけが再び見える（clearedSeq 方式）
  clearConversation(meId, partnerId) {
    if (!this.clears) this.clears = new Map();
    this.clears.set(`${meId}:${partnerId}`, ++this.seq);
  }

  clearSeqOf(meId, partnerId) {
    return this.clears?.get(`${meId}:${partnerId}`) ?? -1;
  }

  markDmRead(meId, otherId) {
    let n = 0;
    for (const m of this.dm) {
      if (m.senderId === otherId && m.recipientId === meId && m.readAt === null) {
        m.readAt = ++this.seq;
        n += 1;
      }
    }
    return n;
  }

  unreadCount(meId, otherId) {
    const cut = this.clearSeqOf(meId, otherId);
    return this.dm.filter(
      (m) => m.at >= cut && m.senderId === otherId && m.recipientId === meId && m.readAt === null,
    ).length;
  }

  conversations(meId) {
    const byPartner = new Map();
    for (const m of this.dm) {
      const partner = m.senderId === meId ? m.recipientId : m.recipientId === meId ? m.senderId : null;
      if (!partner) continue;
      if (m.at < this.clearSeqOf(meId, partner)) continue;
      const cur = byPartner.get(partner) ?? { partnerId: partner, last: null, unread: 0 };
      cur.last = m;
      if (m.recipientId === meId && m.readAt === null) cur.unread += 1;
      byPartner.set(partner, cur);
    }
    return [...byPartner.values()]
      .map((c) => ({ ...c, partner: this.users.get(c.partnerId) }))
      .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0));
  }

  // ---------- ギフト（kl_send_gift） ----------

  giftCatalog() {
    return GIFT_CATALOG;
  }

  sendGift(meId, toId, giftKey) {
    this.getUser(meId);
    if (toId === meId) fail('SELF_ACTION', '自分には送れません');
    const receiver = this.getUser(toId);
    if (this.blockedEither(meId, toId)) fail('BLOCKED', 'このユーザーには送れません');
    const gift = GIFT_CATALOG.find((g) => g.key === giftKey);
    if (!gift) fail('GIFT_NOT_FOUND', 'ギフトが存在しません');

    const w = this.walletOf(meId);
    if (w.free + w.paid < gift.price) fail('INSUFFICIENT_COINS', 'コインが足りません');
    const spentFree = Math.min(w.free, gift.price);
    const spentPaid = gift.price - spentFree;
    w.free -= spentFree;
    w.paid -= spentPaid;

    const hist = {
      id: this._nextId('gift'), senderId: meId, receiverId: toId,
      giftKey: gift.key, price: gift.price,
    };
    this.giftHistory.push(hist);
    this.ledger.push({
      userId: meId, deltaFree: -spentFree, deltaPaid: -spentPaid,
      reason: 'gift_sent', refId: hist.id,
    });

    // もらった側にコインは入らず、人気度だけが価格分上がる（本家ルール）
    receiver.popularity += gift.price;

    this.dm.push({
      id: this._nextId('dm'), senderId: meId, recipientId: toId,
      kind: 'gift', body: null, invitePayload: null,
      giftPayload: {
        historyId: hist.id, giftKey: gift.key,
        name: gift.name, icon: gift.icon, price: gift.price,
      },
      readAt: null, at: this.seq,
    });

    return {
      historyId: hist.id, price: gift.price,
      freeBalance: w.free, paidBalance: w.paid,
      receiverPopularity: receiver.popularity,
    };
  }

  giftsReceived(userId) {
    const counts = new Map();
    for (const h of this.giftHistory) {
      if (h.receiverId !== userId) continue;
      const cur = counts.get(h.giftKey) ?? { giftKey: h.giftKey, count: 0 };
      cur.count += 1;
      counts.set(h.giftKey, cur);
    }
    return [...counts.values()];
  }

  // ---------- ログインボーナス（kl_claim_login_bonus） ----------

  claimLoginBonus(meId, todayJst) {
    const w = this.walletOf(meId);
    if (w.lastLoginBonusDate === todayJst) {
      return { claimed: false, amount: 0, freeBalance: w.free, paidBalance: w.paid };
    }
    w.free += LOGIN_BONUS_COINS;
    w.lastLoginBonusDate = todayJst;
    this.ledger.push({ userId: meId, deltaFree: LOGIN_BONUS_COINS, deltaPaid: 0, reason: 'daily_login', refId: null });
    return { claimed: true, amount: LOGIN_BONUS_COINS, freeBalance: w.free, paidBalance: w.paid };
  }

  // ---------- 検算 ----------

  /** 台帳の合計が財布の残高と一致するか（welcome 100 を初期値として検算） */
  ledgerMatchesWallet(userId) {
    const w = this.walletOf(userId);
    let free = 0;
    let paid = 0;
    for (const row of this.ledger) {
      if (row.userId !== userId) continue;
      free += row.deltaFree;
      paid += row.deltaPaid;
    }
    return free === w.free && paid === w.paid;
  }
}
