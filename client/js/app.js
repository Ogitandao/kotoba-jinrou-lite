// ことば人狼 Lite — クライアント（ロビー／フレンド／DM／ギフト）
//
// データへは必ず window.KL_DATA（data-adapter.js）越しに触る。
// 実 DB（Supabase）未適用・未ログインの間はアダプタが SimBackend
// （デモ用インメモリ実装、RPC と同じ判定・エラーコード）で動く。
// 画面の部品と ID は基盤フェーズ（ロビーモックv1準拠）から維持している。
(function () {
  'use strict';
  const DATA = window.KL_DATA;
  const state = {
    me: null,
    coins: 0,
    popularity: 0,
    bonusClaimed: false,
    rooms: [],
    tab: 'lobby',
    subtab: 'talk',
    users: new Map(), // id -> 公開プロフィール（DM・ギフトの宛先解決用）
    dmPeer: null,
    dmGroup: null,
    giftTarget: null,
    roomId: null,        // 待機室を開いているルーム
    roomDetail: null,    // 待機室の表示データ
    roomPoll: null,      // 待機室ポーリングのタイマ
    gameId: null,        // 対戦画面を開いているゲーム
    gameView: null,      // 対戦画面の表示データ
    gamePoll: null,      // 対戦画面ポーリングのタイマ
    signaledVersion: -1, // 合図（advance）を送った phaseVersion
    endShownGameId: null, // ゲーム終了パネルを表示済みの gameId
    roomTitle: null,     // 対戦画面の見出しに使うルーム名
    rulesAgreed: false,  // チュートリアル同意済みか（サーバー側が正）
    tutorialIndex: 0,    // チュートリアルの表示中スライド（0始まり）
    tutorialMode: 'view', // 'consent'（強制フロー）／'view'（再表示）
    penaltyUntilMs: null, // ペナルティ制限の終了時刻（ms）。制限中のみ未来
    pendingEntry: null,  // 同意後に実行する入室処理
    // 非公開ルームの平文パスワード（メモリのみ・永続化しない）。
    // DB はハッシュしか持たないため、自分が作った部屋／招待カードで
    // 入った部屋についてだけ、招待発行時の照合入力に使えるよう保持する
    roomPasswords: new Map(),
  };
  const PRIVATE_ROOM_COST = 100;

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString('ja-JP');
  const IC = {
    lock: '<svg class="svg-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/></svg>',
    people: '<svg class="svg-ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8.5" r="3.4"/><path d="M3.2 19.8c.7-3.2 3-4.9 5.8-4.9s5.1 1.7 5.8 4.9"/><circle cx="17.2" cy="9.8" r="2.7"/><path d="M15.6 15.1c2.4.2 4.4 1.8 5 4.7"/></svg>',
    tag: '<svg class="svg-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.6 13.4 11 3.8a2 2 0 0 0-1.4-.6H4.2A1.2 1.2 0 0 0 3 4.4v5.4c0 .5.2 1 .6 1.4l9.6 9.6a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.8z"/><circle cx="7.6" cy="7.6" r="1.4" fill="currentColor" stroke="none"/></svg>',
    dice: '<svg class="svg-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="9.2" cy="9.2" r="1.6" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.2" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="9.2" cy="14.8" r="1.6" fill="currentColor" stroke="none"/><circle cx="14.8" cy="14.8" r="1.6" fill="currentColor" stroke="none"/></svg>',
    wakaba: '<svg class="svg-ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 21.2C7.2 17.3 4.7 12.7 4.7 6.4c4.3.5 7.6 2.9 7.3 14.8z" fill="#35b558"/><path d="M12 21.2c4.8-3.9 7.3-8.5 7.3-14.8-4.3.5-7.6 2.9-7.3 14.8z" fill="#ffd83d"/></svg>',
    coin: '<svg class="svg-ic" viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#ffc93c" stroke="#dfa40f" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="#dfa40f"/></svg>',
    trophy: '<svg class="svg-ic" viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 4h9v5.2a4.5 4.5 0 0 1-9 0V4z"/><path d="M7.5 5.6H4.6c0 2.7 1.1 4.1 3.4 4.5"/><path d="M16.5 5.6h2.9c0 2.7-1.1 4.1-3.4 4.5"/><path d="M12 13.7v3.6"/><path d="M8.6 20.4h6.8"/></svg>',
  };

  let toastTimer = null;
  let toastFadeTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    t.classList.remove('hidden');
    t.classList.add('toast-out');
    void t.offsetWidth; // フェードインを効かせるためのリフロー
    t.classList.remove('toast-out');
    toastTimer = setTimeout(() => {
      t.classList.add('toast-out');
      toastFadeTimer = setTimeout(() => {
        t.classList.add('hidden');
        t.classList.remove('toast-out');
      }, 400);
    }, 2600);
  }
  function toastError(err) {
    toast(err?.message ?? 'エラーが発生しました');
  }
  function rememberUsers(list) {
    for (const u of list ?? []) if (u?.id) state.users.set(u.id, u);
  }
  // アイコン描画：プリセット（iconKey）があれば同梱画像、無ければ
  // 従来の絵文字＋背景色にフォールバックする。
  // オンラインバッジ（緑ドット）は付けないのが原則（2026-11-25 おぎ）：
  // ルームに居る時点でオンラインは自明なため、待機室・対戦画面・
  // 一覧類には付けず、opts.online を渡した場所（ロビーの
  // 「オンラインの友達」枠と DM 画面）だけに出す。
  function fillAvatar(el, u, opts = {}) {
    el.innerHTML = '';
    const src = window.KL_ICON_SRC ? window.KL_ICON_SRC(u?.iconKey) : null;
    if (src) {
      el.style.background = '';
      const img = document.createElement('img');
      img.className = 'avatar-img';
      img.src = src;
      img.alt = '';
      el.appendChild(img);
    } else {
      el.style.background = u?.iconBg ?? '';
      el.textContent = u?.icon ?? '';
    }
    if (opts.online && u?.online) {
      const d = document.createElement('span');
      d.className = 'dot dot-on';
      el.appendChild(d);
    }
    return el;
  }
  function avatarSpan(u, size = 'avatar-md', opts = {}) {
    const s = document.createElement('span');
    s.className = `avatar ${size}`;
    return fillAvatar(s, u, opts);
  }
  // グループのアバター：メンバーの顔を最大4つ、2×2に敷く
  function groupAvatarEl(g, size = 'avatar-md') {
    const s = document.createElement('span');
    s.className = `avatar ${size} group-avatar`;
    const members = (g.members ?? []).slice(0, 4);
    for (const m of members) {
      const cell = document.createElement('span');
      cell.className = 'ga-cell';
      const src = window.KL_ICON_SRC ? window.KL_ICON_SRC(m.iconKey) : null;
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = '';
        cell.appendChild(img);
      } else {
        cell.classList.add('emoji-cell');
        cell.style.background = m.iconBg ?? '';
        cell.textContent = m.icon ?? '';
      }
      s.appendChild(cell);
    }
    return s;
  }

  // プレイヤー番号バッジ（2026-11-24 おぎ）：ルーム内での参加順番号を
  // 名前の前に出す小さい四角バッジ。番号はデータ層が参加順で一意に
  // 決める（待機室＝現在の参加順／対戦中＝セット開始時の順で固定）
  function noBadge(no) {
    if (no == null) return null;
    const s = document.createElement('span');
    s.className = 'no-badge';
    s.textContent = no;
    return s;
  }
  /** テキスト文中に名前を出すときの「[番号]名前」表記 */
  function nameWithNo(p) {
    if (!p) return 'プレイヤー';
    return p.no != null ? `[${p.no}]${p.name}` : p.name;
  }

  // ---------- モーダル（履歴スタック式：閉じる＝1つ前に戻る） ----------
  let modalStack = [];
  function showTopModal() {
    const top = modalStack[modalStack.length - 1];
    $('modal-backdrop').classList.toggle('hidden', !top);
    for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
    if (top) $(top).classList.remove('hidden');
  }
  function openModal(id) {
    const at = modalStack.indexOf(id);
    if (at >= 0) modalStack = modalStack.slice(0, at + 1);
    else modalStack.push(id);
    showTopModal();
  }
  // 1つ前のポップアップに戻る（無ければ全部閉じる）
  function backModal() {
    modalStack.pop();
    showTopModal();
  }
  // 全部閉じる（送信完了・画面遷移など、戻る必要がない場面用）
  function closeModal() {
    modalStack = [];
    showTopModal();
  }

  // ---------- プロフィール ----------
  function renderProfile() {
    const me = state.me;
    if (!me) return;
    fillAvatar($('my-avatar'), me);
    $('my-name').textContent = me.name;
    // 長い名前は名前行に収まるよう一段小さくする（改行させない）
    $('my-name').classList.toggle('long', [...(me.name ?? '')].length >= 7);
    $('my-id').textContent = me.publicId;
    const bioEl = $('my-bio');
    if (me.bio) {
      bioEl.textContent = me.bio;
      bioEl.classList.remove('empty');
    } else {
      // 未設定のときは「タップで編集できる」ことが分かる案内を出す（2026-11-25 おぎ）
      bioEl.textContent = '自己紹介（タップで編集）';
      bioEl.classList.add('empty');
    }
    $('avatar-modal-name').textContent = me.name;
    fillAvatar($('avatar-modal-preview'), me);
    renderGiftStrip();
  }

  // もらったギフト帯：単品価格が高い順に1行、入りきらない分は
  // 横スクロールで見られる（詳細画面へは飛ばさない。2026-11-25 おぎ）
  async function renderGiftStrip() {
    const el = $('gift-strip');
    if (!el) return;
    try {
      fillGiftStrip(el, await DATA.myGiftSummary());
    } catch { /* 取得失敗時は帯を空のままにする */ }
  }

  // ギフト帯の中身を描く（自分のロビー帯と他人のプロフで共用）
  function fillGiftStrip(el, items) {
    if (!items.length) {
      el.innerHTML = '<span class="gift-strip-empty">🎁 まだギフトがありません</span>';
      return;
    }
    el.innerHTML = items
      .map((g) => `<span class="gift-strip-item"><img class="gift-icon-img" src="gifts/gift-${g.giftKey}.webp" alt="${g.name}" data-emoji="${g.icon}" /><span class="gift-count">×${g.count}</span></span>`)
      .join('');
    // 専用アートが無いギフトは絵文字表示にフォールバックする
    el.querySelectorAll('.gift-icon-img').forEach((img) => {
      img.addEventListener('error', () => {
        const s = document.createElement('span');
        s.className = 'gift-icon-emoji';
        s.textContent = img.dataset.emoji ?? '🎁';
        img.replaceWith(s);
      });
    });
  }

  // ---------- フレンドメニュー／他人のプロフィール ----------
  // アイコンを押していきなりルームに入ってしまう事故防止に、まず
  // 「プロフを見る／ルームに参加」の2択を出す（2026-11-25 おぎ）
  function openFriendMenu(u) {
    state.menuUser = u;
    fillAvatar($('fm-avatar'), u);
    $('fm-name').textContent = u.name;
    const room = u.roomTitle
      ? state.rooms.find((r) => r.title === u.roomTitle)
      : null;
    state.menuRoom = room ?? null;
    $('fm-status').textContent = room
      ? `ルーム：『${u.roomTitle}』にいます`
      : (u.online ? 'オンライン中です' : 'オフラインです');
    $('fm-join').disabled = !room;
    openModal('modal-friend-menu');
  }

  async function openUserProfile(u) {
    state.profileUser = u;
    fillAvatar($('up-avatar'), u);
    $('up-name').textContent = u.name;
    $('up-id').textContent = u.publicId;
    $('up-bio').textContent = u.bio || '（自己紹介はまだありません）';
    $('up-popularity').textContent = fmt(u.popularity ?? 0);
    $('up-wins').textContent = '…';
    fillGiftStrip($('up-gift-strip'), []);
    openModal('modal-user-profile');
    refreshUserProfileData(u);
  }
  // プロフの詳細（人気度・ギフト等）を最新化する。開き直さず中身だけ差し替える
  async function refreshUserProfileData(u) {
    try {
      const p = await DATA.userProfile(u.id);
      if (state.profileUser !== u) return;
      $('up-bio').textContent = p.bio || '（自己紹介はまだありません）';
      $('up-popularity').textContent = fmt(p.popularity);
      $('up-wins').textContent = fmt(p.wordwolfWins);
      // 数字が長いほどフォントを段階的に小さくする（ギフト貰いおばけ対策）
      document.querySelectorAll('#modal-user-profile .up-stat-value').forEach((el) => {
        const len = el.textContent.replace(/,/g, '').length;
        el.style.fontSize = len <= 6 ? '' : len <= 8 ? '16.5px' : len <= 10 ? '14.5px' : '13px';
      });
      fillGiftStrip($('up-gift-strip'), p.gifts);
    } catch { /* 一覧で持っている情報だけで表示する */ }
  }

  // ---------- アイコン選択 ----------
  // 自分のアイコンをタップすると開く。無料15種は選択可。勝利数解放・
  // コイン購入のティアは将来 DB カタログへ行が増えたら自動で選択肢に
  // 出る（未所有はロック表示）。当面は「今後追加」の案内だけ出す。
  async function openIconModal() {
    try {
      renderIconGrid(await DATA.listIcons());
    } catch (e) { toastError(e); return; }
    openModal('modal-avatar');
  }
  function renderIconGrid(catalog) {
    fillAvatar($('avatar-modal-preview'), state.me);
    const grid = $('icon-grid');
    grid.innerHTML = '';
    for (const c of catalog) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `icon-choice${c.selected ? ' selected' : ''}`;
      b.dataset.iconKey = c.key;
      const src = window.KL_ICON_SRC ? window.KL_ICON_SRC(c.key) : null;
      // 中身は絶対配置のインナーに閉じ込め、セル寸法（正方形）に影響させない
      const inner = document.createElement('span');
      inner.className = 'icon-choice-inner';
      b.appendChild(inner);
      if (src) {
        const img = document.createElement('img');
        img.className = 'avatar-img';
        img.src = src;
        img.alt = '';
        inner.appendChild(img);
      }
      if (c.selected) {
        const check = document.createElement('span');
        check.className = 'icon-choice-check';
        check.textContent = '✓';
        b.appendChild(check);
      }
      if (!c.owned) {
        b.classList.add('locked');
        const lock = document.createElement('span');
        lock.className = 'icon-choice-lock';
        lock.innerHTML = c.tier === 'coin'
          ? `${IC.coin}${fmt(c.priceCoins ?? 0)}コイン`
          : `${IC.trophy}${c.winThreshold ?? 0}勝で解放`;
        inner.appendChild(lock);
        b.addEventListener('click', () => {
          toast(c.tier === 'coin'
            ? `このアイコンは${fmt(c.priceCoins ?? 0)}コインで購入できます`
            : `${c.winThreshold ?? 0}勝で解放されます`);
        });
      } else {
        b.addEventListener('click', () => selectIcon(c.key));
      }
      grid.appendChild(b);
    }
  }
  async function selectIcon(key) {
    try {
      const r = await DATA.setIcon(key);
      state.me.iconKey = r.iconKey;
      rememberUsers([state.me]);
      renderProfile();
      renderIconGrid(await DATA.listIcons());
      toast('アイコンを変更しました');
    } catch (e) { toastError(e); }
  }
  function renderCoins() {
    $('coin-count').textContent = fmt(state.coins);
    $('charge-balance').textContent = fmt(state.coins);
  }
  function renderPopularity() {
    $('popularity-count').textContent = fmt(state.popularity);
  }
  function renderBonus() {
    $('bonus-banner').classList.toggle('claimed', state.bonusClaimed);
    $('bonus-state').textContent = state.bonusClaimed ? '獲得済み！' : '受け取る';
  }
  function renderPenalty() {
    const b = $('penalty-banner');
    if (state.penaltyUntilMs && state.penaltyUntilMs > Date.now()) {
      const d = new Date(state.penaltyUntilMs);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      b.textContent = `⏰ ペナルティ期間中のため、${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm} までルームに参加・作成できません`;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }
  async function refreshPenalty() {
    try {
      const me = await DATA.getMe();
      state.penaltyUntilMs = me.penaltyUntilMs ?? null;
      renderPenalty();
    } catch { /* 表示更新のみの処理なので失敗は無視 */ }
  }

  // ---------- オンラインの友達（ロビー帯） ----------
  async function renderOnlineFriends() {
    const friends = await DATA.listOnlineFriends();
    rememberUsers(friends);
    const wrap = $('online-friends');
    wrap.innerHTML = '';
    for (const f of friends) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'friend-item';
      const av = avatarSpan(f, 'avatar-sm', { online: true });
      const name = document.createElement('span');
      name.className = 'friend-name';
      name.textContent = f.name;
      b.append(av, name);
      b.addEventListener('click', () => openFriendMenu(f));
      wrap.appendChild(b);
    }
  }

  // ---------- ルーム一覧 ----------
  function roomCard(room) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'room-card';
    b.dataset.roomId = room.id;
    // 公開はデフォルトなのでタグ自体を廃止。非公開だけ鍵アイコンを
    // タイトル行の右端に小さく置く（2026-11-25 おぎ：公開タグの形が崩れる問題）
    const lock = room.isPrivate ? `<span class="room-lock">${IC.lock}</span>` : '';
    const beginner = room.beginner ? `<span class="tag tag-beginner">${IC.wakaba} 初心者歓迎</span>` : '';
    // 対戦中はタグ行ではなくアバター下端の LIVE バッジで出す（おぎ：3つ並ぶと横幅が足りない）
    const liveBadge = room.status === 'playing' ? '<span class="live-badge"><span class="pulse-dot"></span>対戦中</span>' : '';
    const genre = `<span class="tag tag-genre">${room.genre ? `${IC.tag} ${room.genre}` : `${IC.dice} おまかせ`}</span>`;
    const hostSrc = window.KL_ICON_SRC ? window.KL_ICON_SRC(room.hostIconKey) : null;
    const hostAvatar = hostSrc
      ? `<span class="avatar avatar-md"><img class="avatar-img" src="${hostSrc}" alt="" /></span>`
      : `<span class="avatar avatar-md" style="background:${room.hostBg}">${room.hostIcon}</span>`;
    // メタ情報は2行固定：1行目＝人数＋ジャンル、2行目＝初心者歓迎＋逆転回答なし。
    // どちらの行も途中で改行させない（2026-11-25 おぎ）
    // 逆転回答は「あり」が標準なので、例外の「なし」の部屋だけカードにもラベルを出す（おぎ）
    const revOff = room.reversalEnabled === false ? '<span class="tag tag-rev-off">逆転回答なし</span>' : '';
    const metaRow2 = (beginner || revOff)
      ? `<span class="meta-row">${beginner}${revOff}</span>`
      : '';
    b.innerHTML =
      `<span class="room-avatar-wrap">${hostAvatar}${liveBadge}</span>` +
      `<span class="room-main"><span class="room-title-row"><span class="room-title"></span>${lock}</span>` +
      `<span class="room-meta"><span class="meta-row"><span class="room-players">${IC.people} ${room.players}/${room.capacity}人</span>${genre}</span>${metaRow2}</span></span>`;
    b.querySelector('.room-title').textContent = room.title;
    b.addEventListener('click', () => requestJoin(room));
    return b;
  }
  function renderRooms() {
    detectRoomEvents(state.rooms);
    const list = $('room-list');
    list.innerHTML = '';
    // 新しく現れたルームだけふわっとスライドインさせる（初回表示は対象外）
    const first = !state.knownRoomIds;
    const known = state.knownRoomIds ?? new Set();
    const next = new Set();
    for (const r of state.rooms) {
      const card = roomCard(r);
      if (!first && !known.has(r.id)) card.classList.add('enter');
      next.add(r.id);
      list.appendChild(card);
    }
    state.knownRoomIds = next;
    renderTicker();
  }

  // ---------- ライブティッカー ----------
  // ロビーに「今起きていること」を流す帯。お知らせ（固定）＋ルーム一覧の
  // 変化から拾う実イベント（作成／対戦開始）を流す（2026-11-25 おぎ）
  const TICKER_BASE = [
    '📣 ことば人狼へようこそ！マナーを守って楽しく遊ぼう',
    '🎁 試合のあとは、活躍した人にギフトを贈ってみよう',
    '🔰 はじめての人は「初心者歓迎」のルームがおすすめ',
  ];
  function renderTicker() {
    const track = $('ticker-track');
    if (!track) return;
    const items = [
      ...(state.feedEvents ?? []).map((e) => e.text),
      ...(state.tickerEvents ?? []),
      ...TICKER_BASE,
    ];
    // 中身が変わっていないときは作り直さない（アニメーションが巻き戻るため）
    const key = items.join('\u0001');
    if (key === state.tickerKey) return;
    state.tickerKey = key;
    const setHtml = items
      .map((t) => `<span class="ticker-item">${t}</span>`)
      .join('');
    // 同じ並びを2セット並べて -50% まで流すと切れ目なくループする
    track.innerHTML = `<span class="ticker-set">${setHtml}</span><span class="ticker-set">${setHtml}</span>`;
    requestAnimationFrame(() => {
      const set = track.querySelector('.ticker-set');
      if (!set) return;
      const w = set.getBoundingClientRect().width;
      // 約45px/秒のゆっくりした速さ。短いときも最低18秒はかける
      track.style.animationDuration = `${Math.max(18, w / 45)}s`;
    });
  }
  // サーバー側フィード（100勝の節目／最高額ギフト）を取り込む
  async function refreshTickerFeed() {
    try {
      const evts = await DATA.tickerFeed();
      const key = evts.map((e) => e.id).join(',');
      if (key !== (state.feedKey ?? '')) {
        state.feedKey = key;
        state.feedEvents = evts;
        renderTicker();
      }
    } catch { /* フィード取得の失敗時は表示を維持 */ }
  }
  function pushTickerEvent(text) {
    state.tickerEvents = state.tickerEvents ?? [];
    state.tickerEvents.unshift(text);
    state.tickerEvents = state.tickerEvents.slice(0, 6);
    renderTicker();
  }
  function detectRoomEvents(rooms) {
    const prev = state.prevRooms;
    const next = new Map(rooms.map((r) => [r.id, { players: r.players, status: r.status }]));
    state.prevRooms = next;
    if (!prev) return; // 初回は種まきだけ（既存ルームをイベント化しない）
    for (const r of rooms) {
      const p = prev.get(r.id);
      if (!p) {
        if (r.hostName) pushTickerEvent(`🏠 ${r.hostName}さんがルーム『${r.title}』を作りました`);
      } else if (p.status !== 'playing' && r.status === 'playing') {
        // 対戦が始まったタイミングで1回だけ流す。同じルームでも
        // 対戦が始まるたびに流れる（2026-11-25 おぎ）
        pushTickerEvent(`🔥 ルーム『${r.title}』が対戦中です！`);
      }
    }
  }

  // ルーム作成バーは「ロビー表示中」だけ出す。ルーム／対戦／DM など
  // ロビーから一歩でも出たら消す（2026-11-25 おぎ：入室しても付いてくる不具合）
  function updateCreateBar() {
    const onLobby = state.tab === 'lobby'
      && $('room-screen').classList.contains('hidden')
      && $('game-screen').classList.contains('hidden')
      && $('dm-screen').classList.contains('hidden');
    $('create-bar').classList.toggle('hidden', !onLobby);
  }

  // ---------- タブ切り替え ----------
  function switchTab(tab) {
    state.tab = tab;
    $('tab-lobby').classList.toggle('hidden', tab !== 'lobby');
    $('tab-friends').classList.toggle('hidden', tab !== 'friends');
    $('tabbtn-lobby').classList.toggle('active', tab === 'lobby');
    $('tabbtn-friends').classList.toggle('active', tab === 'friends');
    updateCreateBar();
    $('scroll').scrollTop = 0;
  }
  // サブタブは LINE 式に横スライドで切り替える（おぎ要望 2026-11-25）。
  // 両パネルを横並びのトラックに入れて滑らせる。非アクティブ側は
  // visibility で消す（display:none は flex の並び位置をずらすため不可）。
  // 高さはアクティブ側に合わせ、ResizeObserver で内容の増減にも追随する
  let subtabAnimTimer = null;
  function finalizeSubtabAnim() {
    if (subtabAnimTimer) { clearTimeout(subtabAnimTimer); subtabAnimTimer = null; }
    const off = state.subtab === 'friend' ? $('subpanel-talk') : $('subpanel-friend');
    off.classList.add('panel-off');
  }
  function syncSubtabHeight() {
    const active = state.subtab === 'friend' ? $('subpanel-friend') : $('subpanel-talk');
    $('subpanel-track').style.height = active.offsetHeight + 'px';
  }
  function switchSubtab(sub) {
    if (state.subtab === sub) return;
    finalizeSubtabAnim();
    state.subtab = sub;
    $('subtab-talk').classList.toggle('active', sub === 'talk');
    $('subtab-friend').classList.toggle('active', sub === 'friend');
    const to = sub === 'friend' ? $('subpanel-friend') : $('subpanel-talk');
    to.classList.remove('panel-off');
    $('subpanel-track').classList.toggle('to-friend', sub === 'friend');
    syncSubtabHeight();
    subtabAnimTimer = setTimeout(finalizeSubtabAnim, 360);
  }

  // ---------- トーク一覧 ----------
  function lastMessagePreview(m) {
    if (!m) return '';
    if (m.kind === 'system' || m.kind === 'welcome') return '📢 システムからのお知らせ';
    if (m.kind === 'gift') return '🎁 ギフトが届きました';
    if (m.kind === 'invite') return '📩 ルームへの招待カード';
    return m.body ?? '';
  }
  // 未読DMの合計を、下部メニューのフレンドタブとトークタブの
  // 赤バッジに反映する（2026-11-25 おぎ）
  function updateNavBadges(convs) {
    const total = (convs ?? []).reduce((s, c) => s + (c.unread ?? 0), 0);
    for (const id of ['badge-tab-friends', 'badge-subtab-talk']) {
      const b = $(id);
      if (!b) continue;
      b.textContent = total > 99 ? '99+' : String(total);
      b.classList.toggle('hidden', total <= 0);
    }
  }

  // --- ギフト到着のスライド通知（おぎ） ---
  // 未読ギフトDMを検出して右からスライド表示する。ゲーム中（試合画面）は出さず、
  // 終わってから流す。相手のDMを開いているときはカード自体が見えるので出さない。
  const seenGiftNotifs = new Set();
  const giftNotifyQueue = [];
  let giftNotifyBusy = false;
  let giftNotifyRetry = null;

  function detectGiftNotifications(convs) {
    for (const c of convs ?? []) {
      const last = c.last;
      if (!last || last.kind !== 'gift' || !last.gift) continue;
      if (last.from !== c.partnerId || c.partnerId === 'system') continue;
      if ((c.unread ?? 0) <= 0) continue;
      if (seenGiftNotifs.has(last.id)) continue;
      seenGiftNotifs.add(last.id);
      if (state.dmPeer?.id === c.partnerId && !$('dm-screen').classList.contains('hidden')) continue;
      giftNotifyQueue.push({ partner: c.partner, gift: last.gift });
    }
    pumpGiftNotify();
  }

  function pumpGiftNotify() {
    if (giftNotifyBusy || giftNotifyQueue.length === 0) return;
    if (!$('game-screen').classList.contains('hidden')) {
      // 試合中は出さない。少し後に再試行する
      if (!giftNotifyRetry) {
        giftNotifyRetry = setTimeout(() => { giftNotifyRetry = null; pumpGiftNotify(); }, 3000);
      }
      return;
    }
    const { partner, gift } = giftNotifyQueue.shift();
    giftNotifyBusy = true;
    const el = $('gift-notify');
    $('gn-avatar').replaceChildren(avatarSpan(partner, 'avatar-sm'));
    $('gn-title').textContent = `${partner.name}さんから`;
    $('gn-gift').textContent = `${gift.name}が届きました`;
    const art = $('gn-art');
    art.src = `gifts/gift-${gift.giftKey}.webp`;
    art.onerror = () => { art.removeAttribute('src'); };
    el.onclick = () => {
      // タップではDM直行せず、トーク一覧まで（おぎ決定：Liteは既読表示なし。
      // 一覧止まりなら「見た」圧もなく、バッジから自分で開ける）
      dismissGiftNotify();
      switchTab('friends');
      switchSubtab('talk');
      renderTalkList();
    };
    el.classList.remove('bye');
    el.classList.add('show');
    setTimeout(dismissGiftNotify, 2450);
  }

  function dismissGiftNotify() {
    const el = $('gift-notify');
    if (!el.classList.contains('show')) return;
    el.classList.add('bye');
    el.classList.remove('show');
    setTimeout(() => {
      el.classList.remove('bye');
      giftNotifyBusy = false;
      pumpGiftNotify();
    }, 430);
  }

  async function renderTalkList() {
    const convs = await DATA.listConversations();
    updateNavBadges(convs);
    detectGiftNotifications(convs);
    rememberUsers(convs.map((c) => c.partner));
    for (const c of convs) if (c.isGroup) rememberUsers(c.partner.members);
    const list = $('talk-list');
    list.innerHTML = '';
    $('talk-empty').classList.toggle('hidden', convs.length > 0);
    for (const c of convs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'talk-row';
      row.dataset.userId = c.partnerId;
      const main = document.createElement('span');
      main.className = 'talk-main';
      const name = document.createElement('span');
      name.className = 'talk-name';
      name.textContent = c.partner.name;
      const preview = document.createElement('span');
      preview.className = 'talk-preview';
      // グループは発言者名を添える（誰の発言か一覧で分かるように）
      preview.textContent = c.isGroup && c.last && c.last.kind === 'text' && c.last.from !== state.me.id
        ? `${state.users.get(c.last.from)?.name ?? ''}：${c.last.body ?? ''}`
        : lastMessagePreview(c.last);
      main.append(name, preview);
      row.append(c.isGroup ? groupAvatarEl(c.partner) : avatarSpan(c.partner), main);
      const side = document.createElement('span');
      side.className = 'talk-side';
      if (c.last?.at) {
        const t = document.createElement('span');
        t.className = 'talk-time';
        t.textContent = fmtListTime(c.last.at);
        side.appendChild(t);
      }
      if (c.unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = String(c.unread);
        side.appendChild(badge);
      }
      if (side.childNodes.length) row.appendChild(side);
      row.addEventListener('click', () => (c.isGroup ? openGroupChat(c.partner) : openDm(c.partner)));
      list.appendChild(row);
    }
  }

  // ---------- フレンドパネル（検索／申請／一覧） ----------
  function userRow(u, actions) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.dataset.userId = u.id;
    const main = document.createElement('span');
    main.className = 'user-main';
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = u.name;
    const sub = document.createElement('span');
    sub.className = 'user-sub';
    sub.textContent = `ID: ${u.publicId}`;
    main.append(name, sub);
    row.append(avatarSpan(u), main);
    for (const a of actions) row.appendChild(a);
    return row;
  }
  function smallBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async function renderFriendPanel() {
    const [friends, incoming, outgoing] = await Promise.all([
      DATA.listFriends(), DATA.listIncomingRequests(), DATA.listOutgoingRequests(),
    ]);
    rememberUsers([...friends, ...incoming, ...outgoing]);

    const reqList = $('request-list');
    reqList.innerHTML = '';
    $('request-section').classList.toggle('hidden', incoming.length === 0);
    for (const u of incoming) {
      reqList.appendChild(userRow(u, [
        smallBtn('承認', 'mini-btn primary', async () => {
          try {
            await DATA.respondFriendRequest(u.id, true);
            toast(`${u.name}さんとフレンドになりました`);
            await refreshSocial();
          } catch (e) { toastError(e); }
        }),
        smallBtn('拒否', 'mini-btn', async () => {
          try {
            await DATA.respondFriendRequest(u.id, false);
            toast('申請を拒否しました');
            await refreshSocial();
          } catch (e) { toastError(e); }
        }),
      ]));
    }

    const outList = $('outgoing-list');
    outList.innerHTML = '';
    $('outgoing-section').classList.toggle('hidden', outgoing.length === 0);
    for (const u of outgoing) {
      const label = document.createElement('span');
      label.className = 'pending-label';
      label.textContent = '申請中';
      outList.appendChild(userRow(u, [label]));
    }

    const list = $('friend-list');
    list.innerHTML = '';
    $('friend-empty').classList.toggle('hidden', friends.length > 0);
    for (const u of friends) {
      const row = userRow(u, [
        smallBtn('トーク', 'mini-btn primary', () => openDm(u)),
        smallBtn('ギフト', 'mini-btn', () => openGift(u)),
        smallBtn('ブロック', 'mini-btn danger', async () => {
          try {
            await DATA.blockUser(u.id);
            toast(`${u.name}さんをブロックしました`);
            await refreshSocial();
          } catch (e) { toastError(e); }
        }),
      ]);
      // アイコンタップでもフレンドメニュー（プロフ／ルーム参加）を出す
      const av = row.querySelector('.avatar');
      if (av) {
        av.classList.add('tappable');
        av.addEventListener('click', () => openFriendMenu(u));
      }
      list.appendChild(row);
    }
  }

  async function doSearch() {
    const q = $('friend-search-input').value.trim();
    const box = $('search-result');
    box.innerHTML = '';
    if (!q) return;
    try {
      const u = await DATA.searchUser(q);
      if (!u) {
        box.innerHTML = '<p class="modal-note">その公開IDのユーザーは見つかりませんでした</p>';
        return;
      }
      rememberUsers([u]);
      let action;
      if (u.relation === 'friend') {
        action = smallBtn('フレンドです', 'mini-btn', () => {});
        action.disabled = true;
      } else if (u.relation === 'requested_out') {
        action = smallBtn('申請中', 'mini-btn', () => {});
        action.disabled = true;
      } else if (u.relation === 'requested_in') {
        action = smallBtn('承認する', 'mini-btn primary', async () => {
          await DATA.respondFriendRequest(u.id, true);
          toast(`${u.name}さんとフレンドになりました`);
          await refreshSocial();
          doSearch();
        });
      } else if (u.relation === 'blocked_by') {
        action = smallBtn('申請できません', 'mini-btn', () => {});
        action.disabled = true;
      } else {
        action = smallBtn('申請する', 'mini-btn primary', async () => {
          const r = await DATA.sendFriendRequest(u.id);
          toast(r === 'accepted' ? `${u.name}さんとフレンドになりました` : `${u.name}さんに申請を送りました`);
          await refreshSocial();
          doSearch();
        });
      }
      box.appendChild(userRow(u, [action]));
    } catch (e) { toastError(e); }
  }

  async function refreshSocial() {
    await Promise.all([renderTalkList(), renderFriendPanel(), renderOnlineFriends()]);
  }

  // ---------- DM ----------
  function messageNode(m) {
    if (m.kind === 'welcome') {
      // ようこそDM：本文＋「チュートリアルはこちら」（いつでも見返せる）
      const box = document.createElement('div');
      box.className = 'dm-system-msg';
      box.textContent = m.body ?? '';
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'welcome-tutorial-btn';
      link.textContent = '📖 チュートリアルはこちら';
      link.addEventListener('click', () => openTutorial('view'));
      box.appendChild(link);
      return box;
    }
    if (m.kind === 'system') {
      const box = document.createElement('div');
      box.className = 'dm-system-msg';
      box.textContent = m.body ?? '';
      return box;
    }
    const mine = m.from === state.me.id;
    if (m.kind === 'gift' && m.gift) {
      const card = document.createElement('div');
      card.className = `dm-gift-card ${mine ? 'mine' : 'theirs'}`;
      card.innerHTML =
        `<span class="gift-card-icon">${m.gift.icon}</span>` +
        `<span class="gift-card-main"><span class="gift-card-name"></span>` +
        `<span class="gift-card-price">${fmt(m.gift.price)}コイン</span></span>`;
      card.querySelector('.gift-card-name').textContent = m.gift.name;
      return card;
    }
    if (m.kind === 'invite' && m.invite) {
      const card = document.createElement('div');
      card.className = `dm-invite-card ${mine ? 'mine' : 'theirs'}`;
      const title = document.createElement('span');
      title.className = 'invite-card-title';
      title.textContent = '📩 ルームへの招待';
      card.appendChild(title);
      if (m.invite.roomTitle) {
        const room = document.createElement('span');
        room.className = 'invite-card-room';
        room.textContent = m.invite.roomTitle;
        card.appendChild(room);
      }
      // パスワード表示＋コピーは非公開ルームの招待だけ（Lite 決定）
      if (m.invite.password) {
        const pw = document.createElement('span');
        pw.className = 'invite-card-pw';
        pw.textContent = `パスワード：${m.invite.password}`;
        const copy = smallBtn('コピー', 'mini-btn', async (ev) => {
          ev.stopPropagation();
          try { await navigator.clipboard.writeText(m.invite.password ?? ''); } catch { /* jsdom等では失敗しても表示で代替 */ }
          toast('パスワードをコピーしました');
        });
        card.append(pw, copy);
      }
      // カード本体タップで、そのまま待機室へ入室する（初回はルール同意が先）
      card.addEventListener('click', () => {
        if (!m.invite.roomId) { toast('この招待からは入室できません'); return; }
        ensureRulesConsent(async () => {
          try {
            const detail = await DATA.joinRoom(m.invite.roomId, m.invite.password ?? undefined);
            // 招待で入った部屋のパスワードは、自分がさらに招待を出す
            // ときのためにメモリにだけ保持する（永続化はしない）
            if (m.invite.password) state.roomPasswords.set(m.invite.roomId, m.invite.password);
            closeDm();
            openRoomScreen(detail);
          } catch (e) { toastError(e); }
        });
      });
      return card;
    }
    const bubble = document.createElement('div');
    bubble.className = `dm-msg ${mine ? 'mine' : 'theirs'}`;
    bubble.textContent = m.body ?? '';
    return bubble;
  }
  // 日付・時刻表示（LINE式：日付は区切りピル、時刻は吹き出しの横）
  function fmtMsgTime(at) {
    if (!at) return '';
    const d = new Date(at);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function dayKeyOf(at) {
    if (!at) return '';
    const d = new Date(at);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function fmtDateSep(at) {
    const d = new Date(at);
    const wd = '日月火水木金土'[d.getDay()];
    const base = `${d.getMonth() + 1}月${d.getDate()}日（${wd}）`;
    return d.getFullYear() === new Date().getFullYear() ? base : `${d.getFullYear()}年${base}`;
  }
  function fmtListTime(at) {
    if (!at) return '';
    const d = new Date(at);
    const now = new Date();
    if (dayKeyOf(at) === dayKeyOf(now.getTime())) return fmtMsgTime(at);
    if (dayKeyOf(at) === dayKeyOf(now.getTime() - 86400e3)) return '昨日';
    if (now.getTime() - at < 6 * 86400e3) return '日月火水木金土'[d.getDay()];
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  function dateSepNode(at) {
    const s = document.createElement('div');
    s.className = 'date-sep';
    s.textContent = fmtDateSep(at);
    return s;
  }
  // 吹き出し＋時刻の横並び（自分の発言は時刻が左、相手は右）
  function timedRow(node, m) {
    const mine = m.from === state.me.id;
    const row = document.createElement('div');
    row.className = `msg-line ${mine ? 'mine' : 'theirs'}`;
    const t = document.createElement('span');
    t.className = 'msg-time';
    t.textContent = fmtMsgTime(m.at);
    if (mine) row.append(t, node); else row.append(node, t);
    return row;
  }
  // 日付が変わったら区切りを挟みながら1件追加する（描画・実況共通）
  function appendDmNode(inner, node, m) {
    const key = dayKeyOf(m.at);
    if (key && key !== inner.dataset.lastDay) {
      inner.appendChild(dateSepNode(m.at));
      inner.dataset.lastDay = key;
    }
    inner.appendChild(node);
  }
  function renderMessages(messages) {
    const inner = $('dm-msgs-inner');
    inner.innerHTML = '';
    inner.dataset.lastDay = '';
    for (const m of messages) {
      const timed = m.kind !== 'system' && m.kind !== 'welcome';
      appendDmNode(inner, timed ? timedRow(messageNode(m), m) : messageNode(m), m);
    }
    // 本家のクランチャット様式：最新が下端に来るよう末尾へスクロール
    $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
  }
  async function openDm(user) {
    state.dmPeer = user;
    state.dmGroup = null;
    rememberUsers([user]);
    $('dm-peer-name').textContent = user.name;
    // システムからのお知らせは読み取り専用（入力欄とギフトを隠す）
    const isSystem = user.id === 'system';
    $('dm-input-row').classList.toggle('hidden', isSystem);
    $('dm-gift-btn').classList.toggle('hidden', isSystem);
    $('dm-members-btn').classList.add('hidden');
    $('dm-screen').classList.remove('hidden');
    updateCreateBar();
    try {
      const messages = await DATA.listMessages(user.id);
      renderMessages(messages);
      await DATA.markRead(user.id);
      renderTalkList();
    } catch (e) { toastError(e); }
  }
  function closeDm() {
    state.dmPeer = null;
    state.dmGroup = null;
    $('dm-screen').classList.add('hidden');
    updateCreateBar();
  }
  // ---------- グループチャット ----------
  function groupMessageNode(m) {
    if (m.kind === 'system') {
      const box = document.createElement('div');
      box.className = 'dm-system-msg';
      box.textContent = m.body ?? '';
      return box;
    }
    if (m.from === state.me.id) return timedRow(messageNode(m), m);
    const wrap = document.createElement('div');
    wrap.className = 'gmsg';
    const name = document.createElement('span');
    name.className = 'gmsg-name';
    name.textContent = state.users.get(m.from)?.name ?? '';
    wrap.append(name, timedRow(messageNode(m), m));
    return wrap;
  }
  function renderGroupMessages(messages) {
    const inner = $('dm-msgs-inner');
    inner.innerHTML = '';
    inner.dataset.lastDay = '';
    for (const m of messages) appendDmNode(inner, groupMessageNode(m), m);
    $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
  }
  async function openGroupChat(g) {
    state.dmGroup = g;
    state.dmPeer = null;
    rememberUsers(g.members);
    $('dm-peer-name').textContent = g.name;
    $('dm-input-row').classList.remove('hidden');
    $('dm-gift-btn').classList.add('hidden');
    $('dm-members-btn').classList.remove('hidden');
    $('dm-screen').classList.remove('hidden');
    updateCreateBar();
    try {
      renderGroupMessages(await DATA.listGroupMessages(g.id));
      await DATA.markGroupRead(g.id);
      renderTalkList();
    } catch (e) { toastError(e); }
  }
  // ---------- グループ作成・設定 ----------
  const groupPick = new Set();
  const groupAddPick = new Set();
  function pickRow(u, set) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-row' + (set.has(u.id) ? ' selected' : '');
    b.append(avatarSpan(u, 'avatar-sm'));
    const n = document.createElement('span');
    n.textContent = u.name;
    b.appendChild(n);
    const check = document.createElement('span');
    check.className = 'pick-check';
    check.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5 L9.5 18 L20 6.5"/></svg>';
    b.appendChild(check);
    b.addEventListener('click', () => {
      if (set.has(u.id)) set.delete(u.id); else set.add(u.id);
      b.classList.toggle('selected', set.has(u.id));
    });
    return b;
  }
  async function openGroupCreate() {
    groupPick.clear();
    $('group-name-input').value = '';
    const friends = await DATA.listFriends();
    rememberUsers(friends);
    const list = $('group-friend-list');
    list.innerHTML = '';
    for (const f of friends) list.appendChild(pickRow(f, groupPick));
    openModal('modal-group-create');
  }
  async function doCreateGroup() {
    try {
      const g = await DATA.createGroup($('group-name-input').value, [...groupPick]);
      closeModal();
      toast('グループを作りました');
      switchTab('friends');
      switchSubtab('talk');
      await renderTalkList();
      openGroupChat(g);
    } catch (e) { toastError(e); }
  }
  async function openGroupMembers() {
    const g = state.dmGroup;
    if (!g) return;
    groupAddPick.clear();
    $('group-members-title').textContent = `グループ設定（${g.memberIds.length}人）`;
    $('group-rename-input').value = g.name;
    const ml = $('group-member-list');
    ml.innerHTML = '';
    for (const m of g.members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.append(avatarSpan(m, 'avatar-sm'));
      const n = document.createElement('span');
      n.textContent = m.name + (m.id === state.me.id ? '（あなた）' : '');
      row.appendChild(n);
      ml.appendChild(row);
    }
    const friends = await DATA.listFriends();
    const al = $('group-add-list');
    al.innerHTML = '';
    const candidates = friends.filter((f) => !g.memberIds.includes(f.id));
    if (!candidates.length) {
      const p = document.createElement('p');
      p.className = 'modal-note';
      p.textContent = '追加できるフレンドがいません';
      al.appendChild(p);
    }
    for (const f of candidates) al.appendChild(pickRow(f, groupAddPick));
    openModal('modal-group-members');
  }
  async function doAddGroupMembers() {
    const g = state.dmGroup;
    if (!g || !groupAddPick.size) return;
    try {
      const updated = await DATA.addGroupMembers(g.id, [...groupAddPick]);
      state.dmGroup = updated;
      rememberUsers(updated.members);
      $('dm-peer-name').textContent = updated.name;
      renderGroupMessages(await DATA.listGroupMessages(g.id));
      renderTalkList();
      openGroupMembers();
    } catch (e) { toastError(e); }
  }
  async function doRenameGroup() {
    const g = state.dmGroup;
    if (!g) return;
    try {
      const updated = await DATA.renameGroup(g.id, $('group-rename-input').value);
      state.dmGroup = updated;
      $('dm-peer-name').textContent = updated.name;
      toast('グループ名を変更しました');
      renderTalkList();
      backModal();
    } catch (e) { toastError(e); }
  }
  async function doLeaveGroup() {
    const g = state.dmGroup;
    if (!g) return;
    try {
      await DATA.leaveGroup(g.id);
      closeModal();
      closeDm();
      toast('グループを抜けました');
      renderTalkList();
    } catch (e) { toastError(e); }
  }
  // Realtime で届いた新着DM（実 DB モードのみ。Sim では発火しない）。
  // 開いている相手からならその場で末尾に追加して既読化し、常に
  // トーク一覧を更新する（並び替え・バッジ・ギフト通知が即時になる）
  async function onIncomingDm(msg) {
    if (state.dmPeer && msg.from === state.dmPeer.id
      && !$('dm-screen').classList.contains('hidden')) {
      appendDmNode($('dm-msgs-inner'), timedRow(messageNode(msg), msg), msg);
      $('dm-messages').scrollTop = $('dm-messages').scrollHeight;
      try { await DATA.markRead(msg.from); } catch { /* 一覧更新でも追随する */ }
    }
    renderTalkList();
  }
  async function sendDm() {
    const input = $('dm-input');
    const body = input.value;
    if (!body.trim()) return;
    try {
      if (state.dmGroup) {
        await DATA.sendGroupMessage(state.dmGroup.id, body);
        input.value = '';
        renderGroupMessages(await DATA.listGroupMessages(state.dmGroup.id));
        renderTalkList();
        return;
      }
      const peer = state.dmPeer;
      if (!peer) return;
      await DATA.sendMessage(peer.id, body);
      input.value = '';
      renderMessages(await DATA.listMessages(peer.id));
      renderTalkList();
    } catch (e) { toastError(e); }
  }

  // ---------- ギフト ----------
  async function openGift(user) {
    state.giftTarget = user;
    rememberUsers([user]);
    $('gift-target-name').textContent = user.name;
    $('gift-balance').textContent = fmt(state.coins);
    $('gift-error').classList.add('hidden');
    $('btn-gift-charge').classList.add('hidden');
    const catalog = await DATA.giftCatalog();
    const grid = $('gift-grid');
    grid.innerHTML = '';
    for (const g of catalog) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gift-item';
      b.dataset.giftKey = g.key;
      b.innerHTML = `<span class="gift-cell-art"><span class="gift-cell-emoji">${g.icon}</span><img src="gifts/gift-${g.key}.webp" alt="" onerror="this.remove()"></span>` +
        `<span class="gift-price"><svg class="gift-coin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#ffc93c"/><circle cx="12" cy="12" r="9" fill="none" stroke="#dfa40f" stroke-width="2"/><circle cx="12" cy="12" r="3.6" fill="#dfa40f"/></svg>${fmt(g.price)}</span>`;
      b.setAttribute('aria-label', g.name);
      b.addEventListener('click', () => confirmGift(g));
      grid.appendChild(b);
    }
    openModal('modal-gift');
  }
  // 送信前に確認ポップアップを挟む（外側タップでは閉じない）
  function confirmGift(g) {
    const target = state.giftTarget;
    if (!target) return;
    if (g.price > state.coins) {
      $('gift-error').classList.remove('hidden');
      $('btn-gift-charge').classList.remove('hidden');
      return;
    }
    state.pendingGift = g;
    $('gc-art').innerHTML = `<span class="gc-emoji">${g.icon}</span><img src="gifts/gift-${g.key}.webp" alt="" onerror="this.remove()">`;
    $('gc-text').textContent = `${target.name}さんへ\n${g.name}（${fmt(g.price)}コイン）を送りますか？`;
    $('modal-backdrop2').classList.remove('hidden');
    $('modal-gift-confirm').classList.remove('hidden');
  }
  function closeGiftConfirm() {
    $('modal-backdrop2').classList.add('hidden');
    $('modal-gift-confirm').classList.add('hidden');
  }
  async function sendGift(gift) {
    const target = state.giftTarget;
    if (!target) return;
    try {
      const res = await DATA.sendGift(target.id, gift.key);
      state.coins = res.coins;
      renderCoins();
      // 連続で贈れるよう、ギフト選択画面は閉じずに残す（残高表示だけ更新）
      $('gift-balance').textContent = fmt(state.coins);
      // 後ろに相手のプロフが開いていたら、そちらの数字もその場で最新化する
      if (state.profileUser?.id === target.id) refreshUserProfileData(state.profileUser);
      toast(`${target.name}さんに${gift.name}を送りました`);
      if (state.dmPeer?.id === target.id) {
        renderMessages(await DATA.listMessages(target.id));
      }
      renderTalkList();
      refreshTickerFeed();
    } catch (e) {
      if (e.code === 'INSUFFICIENT_COINS') {
        $('gift-error').classList.remove('hidden');
        $('btn-gift-charge').classList.remove('hidden');
      }
      toastError(e);
    }
  }

  // ---------- ブロックリスト ----------
  async function renderBlocklist() {
    const blocked = await DATA.listBlocked();
    rememberUsers(blocked);
    const box = $('blocklist-items');
    box.innerHTML = '';
    $('blocklist-empty').style.display = blocked.length ? 'none' : '';
    for (const u of blocked) {
      box.appendChild(userRow(u, [
        smallBtn('解除', 'mini-btn', async () => {
          await DATA.unblockUser(u.id);
          toast('ブロックを解除しました');
          await renderBlocklist();
        }),
      ]));
    }
  }

  // ---------- ルーム入室・待機室・対戦画面 ----------
  async function refreshRooms() {
    try {
      state.rooms = await DATA.listRooms();
      renderRooms();
    } catch { /* 一覧取得の失敗時は表示を維持 */ }
    refreshPenalty();
    refreshTickerFeed();
  }

  // チュートリアル（旧「初回ルール同意ポップアップ」を一本化）。
  // 未プレイの新規ユーザーが入室系アクション（入室／作成／ランダム／
  // 招待カード）を試みた時に強制表示し、同意はサーバーに記録される。
  // モーダル仕様（おぎ指定）：一個の大きいポップアップ内でスライドを
  // 左右に送り、枠の外をタップしても閉じられない。閉じる手段は
  // 最後のスライドの「同意してはじめる」と「キャンセル」だけ。
  // キャンセルしても未同意のままなので、入室を試みるたびに再表示される。
  // 設定／ようこそDMからは閲覧モード（「閉じる」で閉じられる）で開く。
  const TUTORIAL_LAST = 4; // スライドは5枚（0始まり）
  function ensureRulesConsent(action) {
    if (state.rulesAgreed) { action(); return; }
    state.pendingEntry = action;
    openTutorial('consent');
  }
  function openTutorial(mode) {
    state.tutorialMode = mode;
    state.tutorialIndex = 0;
    renderTutorial();
    openModal('modal-tutorial');
  }
  function renderTutorial() {
    const i = state.tutorialIndex;
    $('tutorial-track').style.transform = `translateX(-${i * 100}%)`;
    const dots = $('tutorial-dots');
    dots.innerHTML = '';
    for (let d = 0; d <= TUTORIAL_LAST; d++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tutorial-dot' + (d === i ? ' active' : '');
      b.setAttribute('aria-label', `${d + 1}枚目のスライド`);
      b.addEventListener('click', () => { state.tutorialIndex = d; renderTutorial(); });
      dots.appendChild(b);
    }
    $('btn-tutorial-prev').classList.toggle('hidden', i === 0);
    $('btn-tutorial-next').classList.toggle('hidden', i === TUTORIAL_LAST);
    const consent = state.tutorialMode === 'consent';
    // 「同意してはじめる」は最後のスライドにだけ出す（おぎ仕様）
    $('btn-tutorial-agree').classList.toggle('hidden', !(consent && i === TUTORIAL_LAST));
    $('btn-tutorial-cancel').classList.toggle('hidden', !consent);
    $('btn-tutorial-close').classList.toggle('hidden', consent);
  }
  function tutorialStep(dir) {
    state.tutorialIndex = Math.min(TUTORIAL_LAST, Math.max(0, state.tutorialIndex + dir));
    renderTutorial();
  }
  // フレンドタブの同意ゲート（おぎ仕様）：未同意の間はグレーアウトし、
  // タップしても切り替わらない。同意した瞬間に通常表示へ戻す。
  // 判定の正はサーバー側の同意状態（bootstrap で state.rulesAgreed へ反映）
  function renderFriendsLock() {
    $('tabbtn-friends').classList.toggle('locked', !state.rulesAgreed);
  }

  // カード／ランダム入室の入口：即入室せず入室確認を1回挟む（2026-11-25 おぎ）。
  // 自分の部屋への再入室は確認なし。非公開・対戦中・満室は理由を伝えて終わる
  function requestJoin(room) {
    if (room.isMember || room.isHost) { enterRoom(room); return; }
    if (room.isPrivate) { toast('非公開ルームは招待から入室します'); return; }
    if (room.status === 'playing') { toast('対戦中です'); return; }
    // ペナルティ中は確認を挟まず、サーバー判定の理由をすぐトーストで出す
    if (state.penaltyUntilMs && state.penaltyUntilMs > Date.now()) { enterRoom(room); return; }
    if (room.players >= room.capacity) { toast('満室です'); return; }
    ensureRulesConsent(() => openJoinConfirm(room));
  }
  function openJoinConfirm(room) {
    state.joinTarget = room;
    $('jc-title').textContent = room.title;
    // 2段組み（おぎ決定）：1段目＝人数＋初心者歓迎、2段目＝ジャンル等のチップ
    // 逆転回答は「あり」が標準（デフォルトON）なので、例外の「なし」のときだけラベルを出す
    const revOff = room.reversalEnabled === false;
    const chips =
      (room.genre ? `<span class="tag tag-genre">${IC.tag} ${room.genre}</span>` : '') +
      (revOff ? `<span class="tag tag-rev-off">逆転回答なし</span>` : '');
    $('jc-meta').innerHTML =
      `<span class="jc-row"><span>${IC.people} ${room.players}/${room.capacity}人</span>` +
      (room.beginner ? `<span>${IC.wakaba} 初心者歓迎</span>` : '') + `</span>` +
      (chips ? `<span class="jc-row">${chips}</span>` : '');
    openModal('modal-join-confirm');
  }

  // ロビーのカード／ランダム入室／友達帯からの入室導線
  function enterRoom(room) {
    ensureRulesConsent(() => doEnterRoom(room));
  }
  async function doEnterRoom(room) {
    try {
      if (room.isMember || room.isHost) {
        openRoomScreen(await DATA.getRoom(room.id));
      } else if (room.isPrivate) {
        toast('非公開ルームは招待から入室します');
      } else {
        openRoomScreen(await DATA.joinRoom(room.id));
      }
    } catch (e) { toastError(e); }
  }

  function openRoomScreen(detail) {
    state.roomId = detail.id;
    state.roomDetail = detail;
    state.roomTitle = detail.title;
    rememberUsers(detail.members ?? []);
    closeDm();
    closeGameScreen();
    $('room-screen').classList.remove('hidden');
    updateCreateBar();
    renderRoomScreen();
    DATA.heartbeat(detail.id).catch(() => {});
    stopRoomPoll();
    state.roomPoll = setInterval(pollRoom, 1200);
  }
  function closeRoomScreen() {
    stopRoomPoll();
    state.roomId = null;
    state.roomDetail = null;
    $('room-screen').classList.add('hidden');
    updateCreateBar();
  }
  function stopRoomPoll() {
    if (state.roomPoll) { clearInterval(state.roomPoll); state.roomPoll = null; }
  }
  async function pollRoom() {
    if (!state.roomId || state.gameId) return;
    // 生存信号（対戦中の離脱判定に使う。先に送ってから状態を取得する）
    DATA.heartbeat(state.roomId).catch(() => {});
    const wasLobby = state.roomDetail?.status === 'lobby';
    try {
      const detail = await DATA.getRoom(state.roomId);
      state.roomDetail = detail;
      rememberUsers(detail.members ?? []);
      renderRoomScreen();
      // 待機中に開始したら、そのまま対戦画面へ
      if (wasLobby && detail.status === 'playing' && detail.currentGame) {
        openGameScreen(detail.currentGame.gameId);
      }
    } catch { /* 一過性の失敗は次回ポーリングで回復 */ }
  }

  function renderRoomScreen() {
    const d = state.roomDetail;
    if (!d) return;
    $('room-screen-title').textContent = d.title;
    $('room-screen-count').textContent = `${d.players}/${d.capacity}人`;
    const tags = $('room-screen-tags');
    tags.innerHTML = '';
    const addTag = (cls, text) => {
      const s = document.createElement('span');
      s.className = `tag ${cls}`;
      s.textContent = text;
      tags.appendChild(s);
    };
    const addTagHtml = (cls, html) => {
      const s = document.createElement('span');
      s.className = `tag ${cls}`;
      s.innerHTML = html;
      tags.appendChild(s);
    };
    if (d.isPrivate) addTagHtml('tag-private', `${IC.lock} 非公開`);
    else addTag('tag-public', '公開');
    addTagHtml('tag-genre', d.genre ? `${IC.tag} ジャンル：${d.genre}` : `${IC.dice} ジャンル：おまかせ`);
    if (d.beginner) addTagHtml('tag-beginner', `${IC.wakaba} 初心者歓迎`);
    addTag('tag-public', d.reversalEnabled ? '逆転回答あり' : '逆転回答なし');
    if (d.status === 'playing') addTag('tag-private', '対戦中');

    const box = $('room-members');
    box.innerHTML = '';
    const iAmHost = d.hostId === state.me.id;
    for (const m of d.members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.dataset.userId = m.id;
      const main = document.createElement('span');
      main.className = 'member-main';
      const line = document.createElement('span');
      line.className = 'member-name-line';
      const badge = noBadge(m.no);
      if (badge) line.appendChild(badge);
      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = m.name + (m.id === state.me.id ? '（あなた）' : '');
      line.appendChild(name);
      main.append(line);
      row.append(avatarSpan(m), main);
      if (m.isHost) {
        const b = document.createElement('span');
        b.className = 'host-badge';
        b.textContent = 'マスター';
        row.appendChild(b);
      } else if (d.status === 'lobby') {
        // マスター以外のメンバーは準備状態を表示する
        const rb = document.createElement('span');
        rb.className = `ready-badge${m.ready ? ' ready' : ''}`;
        rb.textContent = m.ready ? '準備OK' : '未準備';
        row.appendChild(rb);
      }
      // マスターは待機室でメンバーをキックできる（自分と対戦中は不可）
      if (iAmHost && d.status === 'lobby' && !m.isHost && m.id !== state.me.id) {
        const kb = document.createElement('button');
        kb.type = 'button';
        kb.className = 'kick-btn';
        kb.textContent = 'キック';
        kb.dataset.kickId = m.id;
        kb.addEventListener('click', () => kickMember(m.id, m.name));
        row.appendChild(kb);
      }
      box.appendChild(row);
    }

    // 開始フロー（2026-11-24 おぎ最終決定）：開始条件＝満室＋
    // マスター以外の全員が「準備OK！」＋マスターが「ゲームスタート！」。
    // 全員が押さないと開始できない
    const meMember = d.members.find((m) => m.id === state.me.id);
    const readyBtn = $('btn-ready');
    const startBtn = $('btn-start-game');
    const enterBtn = $('btn-enter-game');
    readyBtn.classList.add('hidden');
    startBtn.classList.add('hidden');
    enterBtn.classList.add('hidden');
    const full = d.players >= d.capacity;
    const notReadyCount = d.members.filter((m) => !m.isHost && !m.ready).length;
    const allReady = full && notReadyCount === 0;
    let note = '';
    if (d.status === 'playing') {
      enterBtn.classList.remove('hidden');
      note = '対戦が始まっています';
    } else if (meMember && iAmHost) {
      startBtn.classList.remove('hidden');
      startBtn.disabled = !allReady;
      note = !full
        ? `あと${d.capacity - d.players}人集まると満室です（${d.players}/${d.capacity}人）`
        : !allReady
          ? `満室！あと${notReadyCount}人の準備OKを待っています`
          : '全員そろいました！「ゲームスタート！」を押してください';
    } else if (meMember) {
      readyBtn.classList.remove('hidden');
      readyBtn.textContent = meMember.ready ? '準備OK済み（タップで取消）' : '準備OK！';
      note = !full
        ? `あと${d.capacity - d.players}人集まると満室です（${d.players}/${d.capacity}人）`
        : !allReady
          ? `満室！あと${notReadyCount}人の準備OKを待っています`
          : '全員そろいました！マスターの開始を待っています';
    } else {
      note = 'このルームにはまだ参加していません';
    }
    $('room-status-note').textContent = note;

    // 待機室チャット（対戦中は隠す。ゲーム間の雑談は待機室に戻ってから）
    const inLobby = d.status === 'lobby';
    $('room-chat').classList.toggle('hidden', !inLobby);
    $('room-chat-input-row').classList.toggle('hidden', !inLobby);
    if (inLobby) renderRoomChat(d);

    // 「友達を招待」導線は待機中かつ自分がメンバーのときだけ出す
    $('btn-invite').classList.toggle('hidden', !(inLobby && meMember));
  }

  // 待機室チャットの描画（本編と同じLINE式：他者は左・自分は右、
  // 名前の左にプレイヤー番号バッジ）
  function renderRoomChat(d) {
    const inner = $('room-chat-msgs-inner');
    inner.innerHTML = '';
    const msgs = d.roomMessages ?? [];
    if (!msgs.length) {
      const p = document.createElement('p');
      p.className = 'room-chat-empty';
      p.textContent = 'まだ発言がありません。ゲーム前・ゲーム間の雑談にどうぞ';
      inner.appendChild(p);
      return;
    }
    const memberOf = (id) => d.members.find((m) => m.id === id);
    for (const m of msgs) {
      if (m.kind === 'system') {
        const log = document.createElement('div');
        log.className = 'game-system-log';
        log.textContent = m.body;
        inner.appendChild(log);
        continue;
      }
      const mine = m.from === state.me.id;
      const sender = memberOf(m.from);
      const row = document.createElement('div');
      row.className = `game-msg-row${mine ? ' mine' : ''}`;
      const nameEl = document.createElement('span');
      nameEl.className = 'game-msg-sender';
      const nb = sender ? noBadge(sender.no) : null;
      if (nb) nameEl.appendChild(nb);
      nameEl.appendChild(document.createTextNode(
        sender?.name ?? state.users.get(m.from)?.name ?? 'プレイヤー'));
      const bubble = document.createElement('div');
      bubble.className = `dm-msg${mine ? ' mine' : ''}`;
      bubble.textContent = m.body;
      row.append(nameEl, bubble);
      inner.appendChild(row);
    }
    $('room-chat-messages').scrollTop = $('room-chat-messages').scrollHeight;
  }

  async function kickMember(targetId, targetName) {
    if (!state.roomDetail) return;
    try {
      await DATA.kickMember(state.roomDetail.id, targetId);
      toast(`${targetName}さんをキックしました`);
      state.roomDetail = await DATA.getRoom(state.roomDetail.id);
      renderRoomScreen();
    } catch (e) { toastError(e); }
  }

  async function sendRoomMessage() {
    if (!state.roomDetail) return;
    const input = $('room-chat-input');
    if (!input.value.trim()) return;
    try {
      await DATA.postRoomMessage(state.roomDetail.id, input.value);
      input.value = '';
      state.roomDetail = await DATA.getRoom(state.roomDetail.id);
      renderRoomScreen();
    } catch (e) { toastError(e); }
  }

  // ---------- 友達を招待（DM招待カードの発行） ----------
  // 待機室からフレンドを選んで、そのフレンドとの DM に招待カードを
  // 送る。発行はサーバー RPC（kl_send_invite）経由で、メンバー確認・
  // フレンド確認・パスワード照合はサーバー側で行われる。
  // 非公開ルームはパスワードの入力が要る（DB はハッシュのみ保持の
  // ため）。自分が作った／招待で入った部屋は state.roomPasswords に
  // 平文が残っているので初期値として入れておく。
  async function openInviteModal() {
    const d = state.roomDetail;
    if (!d) return;
    $('invite-room-title').textContent = d.title;
    $('invite-password-row').classList.toggle('hidden', !d.isPrivate);
    if (d.isPrivate) {
      $('invite-password').value = state.roomPasswords.get(d.id) ?? '';
    }
    const list = $('invite-friend-list');
    list.innerHTML = '';
    let friends;
    try {
      friends = await DATA.listFriends();
    } catch (e) { toastError(e); return; }
    rememberUsers(friends);
    $('invite-empty').classList.toggle('hidden', friends.length > 0);
    for (const f of friends) {
      const btn = smallBtn('招待する', 'mini-btn primary', async () => {
        try {
          const pw = d.isPrivate ? $('invite-password').value.trim() : undefined;
          if (d.isPrivate && !pw) { toast('パスワードを入力してください'); return; }
          await DATA.sendInvite(f.id, d.id, pw);
          if (d.isPrivate) state.roomPasswords.set(d.id, pw);
          btn.disabled = true;
          btn.textContent = '送信済み';
          toast(`${f.name}さんに招待を送りました`);
          renderTalkList();
        } catch (e) { toastError(e); }
      });
      list.appendChild(userRow(f, [btn]));
    }
    openModal('modal-invite');
  }

  // ---------- 対戦画面 ----------
  // 無発言警告（2026-11-24 おぎ追加指摘）：話し合いフェーズで自分の
  // 発言が0件のまま残り時間がこの秒数を切ったら、本人の画面だけに
  // 警告バナーを出す。条件・文言の調整はこの2定数で。
  const AFK_WARNING_REMAIN_SEC = 60;
  // 【9】発言ゼロ＋未投票＝一発退室ルールの予告文言（おぎ指定の文言どおり）
  const AFK_WARNING_TEXT = '⚠️ まだ発言がありません。このまま発言も投票もないと、強制退室になります';
  const PHASE_LABEL = {
    intro: '🤝 挨拶タイム',
    discussion: '💬 話し合い',
    voting: '🗳️ 投票タイム',
    reversal: '🔄 逆転回答',
    result: '🏆 結果発表',
    done: '🏁 終了',
  };
  const REASON_TEXT = {
    no_votes: '誰にも票が入らず、ウルフの勝ち',
    tie: '同票が続いて、ウルフの勝ち',
    citizen_exiled: '市民が追放されて、ウルフの勝ち',
    wolf_exiled: 'ウルフを追放！市民の勝ち',
    reversal: '逆転回答で決着！',
    aborted: '対戦が中断されました',
  };

  function openGameScreen(gameId) {
    state.gameId = gameId;
    state.gameView = null;
    state.signaledVersion = -1;
    stopRoomPoll();
    $('game-screen').classList.remove('hidden');
    updateCreateBar();
    stopGamePoll();
    state.gamePoll = setInterval(pollGame, 600);
    pollGame();
  }
  function closeGameScreen() {
    stopGamePoll();
    state.gameId = null;
    state.gameView = null;
    $('game-screen').classList.add('hidden');
    updateCreateBar();
  }
  function stopGamePoll() {
    if (state.gamePoll) { clearInterval(state.gamePoll); state.gamePoll = null; }
  }

  async function pollGame() {
    if (!state.gameId) return;
    // 生存信号（離脱判定用。取得より先に送り、自分の途絶と誤判定しない）
    if (state.roomId) DATA.heartbeat(state.roomId).catch(() => {});
    try {
      const view = await DATA.getGameView(state.gameId);
      state.gameView = view;
      rememberUsers(view.players);
      renderGame();
      maybeSignalAdvance(view);
      // ゲーム単位制：ゲームが終わったら終了パネルを出す
      // （result の表示が終わり phase=done になってから）
      if (view.phase === 'done'
        && (view.setStatus === 'finished' || view.setStatus === 'terminated')) {
        showEndPanel(view);
        refreshPenalty();
      }
    } catch { /* 一過性の失敗は次回ポーリングで回復 */ }
  }

  // フェーズ終了の合図：締め切り到達 or 投票が全員そろったら
  // 1フェーズにつき1回だけ ww_advance を送る（サーバー側も冪等）
  async function maybeSignalAdvance(view) {
    if (view.phase === 'done') return;
    const allVoted = view.phase === 'voting' && view.votesCast >= view.playerCount;
    const expired = view.phaseDeadlineMs != null && Date.now() >= view.phaseDeadlineMs;
    if (!allVoted && !expired) return;
    if (state.signaledVersion === view.phaseVersion) return;
    state.signaledVersion = view.phaseVersion;
    try {
      await DATA.advanceGame(view.gameId, view.phaseVersion);
      pollGame();
    } catch { /* 合図が届かなくても見回り（sweep）が拾う */ }
  }

  function renderGame() {
    const v = state.gameView;
    if (!v) return;
    $('game-title').textContent = state.roomTitle ?? 'ことば人狼';
    const timer = $('game-timer');
    let remain = null;
    if (v.phaseDeadlineMs == null) {
      timer.textContent = '--:--';
      timer.classList.remove('urgent');
    } else {
      remain = Math.max(0, Math.ceil((v.phaseDeadlineMs - Date.now()) / 1000));
      timer.textContent = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, '0')}`;
      timer.classList.toggle('urgent', remain <= 10);
    }
    const closed = remain !== null && remain <= 0 && v.phase !== 'done';
    let label = PHASE_LABEL[v.phase] ?? v.phase;
    // 開始待機（挨拶タイム）：お題はまだ出さない。残り秒数を出す
    if (v.phase === 'intro') {
      label = remain !== null
        ? `🤝 挨拶タイム（あと${remain}秒でお題が出ます…）`
        : '🤝 挨拶タイム（まもなくお題が出ます…）';
    }
    if (v.phase === 'discussion' && v.extended) label += '（同票で延長中）';
    if (v.phase === 'voting') label += `（${v.votesCast}/${v.playerCount}人 投票済み）`;
    $('game-phase-label').textContent = label;

    // ジャンル：全員に公開（挨拶〜結果まで常時表示。ペアは同ジャンル
    // 同士なので正体はバレない）
    const hasGenre = !!v.category;
    $('game-genre-line').classList.toggle('hidden', !hasGenre);
    if (hasGenre) $('game-genre-name').textContent = v.category;

    // お題カード：結果発表までは「自分のお題だけ」を出す
    const showTopic = v.phase !== 'result' && v.phase !== 'done' && !!v.myTopic;
    $('game-topic-card').classList.toggle('hidden', !showTopic);
    if (showTopic) $('game-my-topic').textContent = v.myTopic;

    // 参加者アイコン帯：出すのは挨拶・話し合いのみ。投票（選択肢と
    // 重複）・逆転回答・結果発表（結果リストが全員分を出す）では
    // 冗長なので隠す（2026-11-24 おぎ判断）
    const showPlayers = v.phase === 'intro' || v.phase === 'discussion';
    $('game-players').classList.toggle('hidden', !showPlayers);

    // 参加者
    const prow = $('game-players');
    prow.innerHTML = '';
    for (const p of v.players) {
      const item = document.createElement('div');
      item.className = 'game-player';
      const line = document.createElement('span');
      line.className = 'gp-name-line';
      const nb = noBadge(p.no);
      if (nb) line.appendChild(nb);
      const name = document.createElement('span');
      name.className = 'gp-name';
      name.textContent = p.name;
      line.appendChild(name);
      item.append(avatarSpan(p, 'avatar-sm'), line);
      prow.appendChild(item);
    }

    // 発言（下端寄せ）
    const inner = $('game-msgs-inner');
    inner.innerHTML = '';
    const nameOf = (id) => v.players.find((p) => p.id === id)?.name ?? 'プレイヤー';
    for (const m of v.messages) {
      if (m.kind === 'system') {
        const log = document.createElement('div');
        log.className = 'game-system-log';
        log.textContent = m.body;
        inner.appendChild(log);
        continue;
      }
      const mine = m.from === state.me.id;
      const row = document.createElement('div');
      row.className = `game-msg-row${mine ? ' mine' : ''}`;
      const sender = document.createElement('span');
      sender.className = 'game-msg-sender';
      const senderPlayer = v.players.find((p) => p.id === m.from);
      const snb = senderPlayer ? noBadge(senderPlayer.no) : null;
      if (snb) sender.appendChild(snb);
      sender.appendChild(document.createTextNode(nameOf(m.from)));
      const bubble = document.createElement('div');
      bubble.className = `dm-msg${mine ? ' mine' : ''}`;
      bubble.textContent = m.body;
      row.append(sender, bubble);
      inner.appendChild(row);
    }
    $('game-messages').scrollTop = $('game-messages').scrollHeight;

    // 無発言警告：判定はサーバー時刻基準の残り秒数（phaseRemainSec）と
    // 自分の発言数（myMessageCount）で行う。ビューに無い場合は手元の
    // メッセージと表示用タイマーから補う
    const myCount = v.myMessageCount
      ?? v.messages.filter((m) => m.kind !== 'system' && m.from === state.me.id).length;
    const remainSec = v.phaseRemainSec ?? remain;
    const showAfk = v.phase === 'discussion' && myCount === 0
      && remainSec !== null && remainSec < AFK_WARNING_REMAIN_SEC;
    const afk = $('game-afk-warning');
    afk.textContent = AFK_WARNING_TEXT;
    afk.classList.toggle('hidden', !showAfk);

    // 入力欄：話せるフェーズだけ。締め切りを過ぎたらUIも締める
    // 挨拶タイム（intro）もチャットは使える（お題はまだ出ていない）
    const canPost = v.phase === 'intro' || v.phase === 'discussion';
    $('game-input-row').classList.toggle('hidden', !canPost);
    $('game-input').disabled = closed;
    $('game-send').disabled = closed;
    $('game-input').placeholder = closed
      ? '締め切りました'
      : v.phase === 'intro'
        ? '挨拶してみよう（お題はまだ出ていません）'
        : 'お題について話そう（200文字まで）';

    // 投票パネル
    $('game-vote-panel').classList.toggle('hidden', v.phase !== 'voting');
    if (v.phase === 'voting') {
      const list = $('game-vote-list');
      list.innerHTML = '';
      const voted = v.myVote !== undefined;
      for (const p of v.players) {
        if (p.id === state.me.id) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `vote-btn${v.myVote === p.id ? ' selected' : ''}`;
        b.dataset.targetId = p.id;
        b.disabled = voted || closed;
        const nm = document.createElement('span');
        nm.textContent = p.name;
        const vnb = noBadge(p.no);
        if (vnb) b.append(avatarSpan(p, 'avatar-sm'), vnb, nm);
        else b.append(avatarSpan(p, 'avatar-sm'), nm);
        b.addEventListener('click', () => castVote(p.id));
        list.appendChild(b);
      }
      $('game-vote-state').textContent = voted
        ? (v.myVote === null
          ? 'スルーしました。みんなの投票を待っています'
          : '投票しました。みんなの投票を待っています')
        : `${v.votesCast}/${v.playerCount}人 が投票済み`;
    }

    // 逆転回答パネル
    $('game-reversal-panel').classList.toggle('hidden', v.phase !== 'reversal');
    if (v.phase === 'reversal') {
      const choices = $('game-reversal-choices');
      choices.innerHTML = '';
      if (v.reversalChoices) {
        $('game-reversal-text').textContent =
          '🔄 追放されたウルフはあなた！市民のお題を当てれば逆転勝ち';
        for (const c of v.reversalChoices) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'reversal-choice';
          b.textContent = c;
          b.disabled = closed;
          b.addEventListener('click', () => submitReversal(c));
          choices.appendChild(b);
        }
      } else {
        const exiled = v.players.find((p) => p.id === v.exiledId);
        $('game-reversal-text').textContent =
          `🔄 ${exiled ? nameWithNo(exiled) : 'ウルフ'}さんが逆転回答中…`;
      }
    }

    // 結果パネル
    const showResult = v.phase === 'result' || v.phase === 'done';
    $('game-result-panel').classList.toggle('hidden', !showResult);
    if (showResult && v.winner) renderGameResult(v);
    $('game-end-panel').classList.toggle('hidden', state.endShownGameId !== v.gameId);
  }

  function renderGameResult(v) {
    const mine = (v.reveal ?? []).find((r) => r.id === state.me.id);
    const banner = $('game-result-banner');
    banner.className = `result-banner ${mine?.won ? 'win' : 'lose'}`;
    banner.textContent = v.winner === 'wolves'
      ? '🐺 ウルフ陣営の勝ち！'
      : '🎉 市民陣営の勝ち！';
    // 説明文は2行に分ける（2026-11-24 おぎ）：
    // 1行目＝決着理由（追放・逆転回答の結果を含む）、2行目＝お題開示
    const lines = [];
    let line1 = REASON_TEXT[v.winReason] ?? '';
    const exiled = v.players.find((p) => p.id === v.exiledId);
    if (v.exiledId && exiled) line1 += `／追放：${nameWithNo(exiled)}さん`;
    if (v.reversalOutcome?.timedOut) line1 += '／逆転回答は時間切れ';
    else if (v.reversalOutcome?.attempted) {
      line1 += `／逆転回答は${v.reversalOutcome.correct ? '成功！' : '失敗'}`;
    }
    if (line1) lines.push(line1);
    if (v.topicPair) {
      lines.push(`お題：市民「${v.topicPair.citizen}」・ウルフ「${v.topicPair.wolf}」`);
    }
    const detailEl = $('game-result-detail');
    detailEl.innerHTML = '';
    for (const line of lines) {
      const d = document.createElement('div');
      d.textContent = line;
      detailEl.appendChild(d);
    }
    const rl = $('game-reveal-list');
    rl.innerHTML = '';
    for (const r of v.reveal ?? []) {
      const p = v.players.find((x) => x.id === r.id);
      if (!p) continue;
      const row = document.createElement('div');
      row.className = 'reveal-row';
      const main = document.createElement('span');
      main.className = 'reveal-main';
      const nm = document.createElement('span');
      nm.className = 'reveal-name';
      nm.textContent = p.name + (r.id === state.me.id ? '（あなた）' : '');
      const tp = document.createElement('span');
      tp.className = 'reveal-topic';
      tp.textContent = r.topic ? `お題：${r.topic}` : '';
      main.append(nm, tp);
      const badge = document.createElement('span');
      badge.className = `role-badge ${r.isWolf ? 'wolf' : 'citizen'}`;
      badge.textContent = r.isWolf ? 'ウルフ' : '市民';
      const rnb = noBadge(p.no);
      if (rnb) row.append(avatarSpan(p, 'avatar-sm'), rnb, main, badge);
      else row.append(avatarSpan(p, 'avatar-sm'), main, badge);
      rl.appendChild(row);
    }
  }

  // ゲーム終了パネル（ゲーム単位制）：全員いったん待機室に戻る導線。
  // 強制退室された本人には「待機室に戻る」を出さない（もうメンバーではない）
  function showEndPanel(view) {
    if (state.endShownGameId === view.gameId) return;
    state.endShownGameId = view.gameId;
    const terminated = view.setStatus === 'terminated';
    const iWasRemoved = (view.terminatedUserIds ?? []).includes(state.me.id);
    $('game-end-note').textContent = !terminated
      ? 'おつかれさまでした！待機室に戻ると、また準備OKで次のゲームができます。'
      : iWasRemoved
        ? 'ルール違反のため強制退室となりました。'
        : 'ルール違反があったため、この対戦は終了しました。完了した勝敗は記録されています。';
    $('btn-end-towaiting').classList.toggle('hidden', iWasRemoved);
    $('game-end-panel').classList.remove('hidden');
  }

  async function sendGameMessage() {
    const v = state.gameView;
    if (!v) return;
    const input = $('game-input');
    if (!input.value.trim()) return;
    try {
      await DATA.postGameMessage(v.gameId, input.value);
      input.value = '';
      pollGame();
    } catch (e) { toastError(e); }
  }
  async function castVote(targetId) {
    const v = state.gameView;
    if (!v) return;
    try {
      await DATA.castVote(v.gameId, targetId);
      pollGame();
    } catch (e) { toastError(e); }
  }
  async function submitReversal(choice) {
    const v = state.gameView;
    if (!v) return;
    try {
      await DATA.submitReversal(v.gameId, choice);
      pollGame();
    } catch (e) { toastError(e); }
  }

  // ---------- ルーム作成 ----------
  function createVisibility() {
    return document.querySelector('input[name="create-visibility"]:checked').value;
  }
  function refreshCreateError() {
    const isPrivate = createVisibility() === 'private';
    $('create-password-row').classList.toggle('hidden', !isPrivate);
    const need = isPrivate && state.coins < PRIVATE_ROOM_COST;
    $('create-error').classList.toggle('hidden', !need);
    $('btn-create-charge').classList.toggle('hidden', !need);
  }
  async function confirmCreate() {
    const isPrivate = createVisibility() === 'private';
    let password = $('create-password').value.trim();
    if (isPrivate && state.coins < PRIVATE_ROOM_COST) {
      refreshCreateError();
      return;
    }
    if (isPrivate && password.length > 0 && password.length < 4) {
      toast('パスワードは4文字以上で設定してください');
      return;
    }
    // 空欄のまま作った場合は自動でパスワードを発行する（招待カードで共有）
    if (isPrivate && !password) {
      password = 'wolf' + Math.floor(1000 + Math.random() * 9000);
    }
    const title = $('create-title').value.trim() || 'タイトル未設定の部屋';
    const beginner = $('create-beginner').checked;
    const capacity = Number($('create-capacity').value) || 4;
    const genre = $('create-genre').value || null;
    // 一覧への反映は同期的に行う（従来の見た目の挙動を維持）
    const tempId = 'pending-' + Date.now();
    state.rooms.unshift({
      id: tempId, title, hostName: state.me.name, hostIcon: state.me.icon,
      hostIconKey: state.me.iconKey ?? null,
      hostBg: state.me.iconBg, isPrivate, beginner, players: 1, capacity,
      genre,
      status: 'lobby', isHost: true, isMember: true,
    });
    renderRooms();
    closeModal();
    try {
      const { room, coins } = await DATA.createRoom({
        title,
        isPrivate,
        password: isPrivate ? password : undefined,
        beginner,
        capacity,
        genre,
        reversalEnabled: $('create-reversal').checked,
      });
      state.coins = coins;
      renderCoins();
      toast(isPrivate
        ? `非公開ルームを作りました（-${PRIVATE_ROOM_COST}コイン）`
        : 'ルームを作りました');
      await refreshRooms();
      // 作った本人の端末にだけ平文が残る（招待発行時の照合入力用）
      if (isPrivate) state.roomPasswords.set(room.id, password);
      openRoomScreen(room);
    } catch (e) {
      state.rooms = state.rooms.filter((r) => r.id !== tempId);
      renderRooms();
      if (e.code === 'INSUFFICIENT_COINS') {
        openModal('modal-create');
        refreshCreateError();
      }
      toastError(e);
    }
  }

  // ---------- 初期化 ----------
  let inited = false;
  async function init() {
    // 二重初期化ガード（リスナーが二重登録されると、同意後の処理が
    // 2回目の closeModal で打ち消される等の事故になる）
    if (inited) return;
    inited = true;
    const boot = await DATA.bootstrap();
    state.me = { id: 'me', ...boot.me };
    // アダプタ内部の自ID（sim では 'me'、実 DB では auth uid）に合わせる
    state.me.id = boot.me.id ?? 'me';
    state.coins = boot.me.coins;
    state.popularity = boot.me.popularity;
    state.bonusClaimed = boot.me.bonusClaimed;
    state.rulesAgreed = !!boot.me.rulesAgreed;
    state.penaltyUntilMs = boot.me.penaltyUntilMs ?? null;
    state.rooms = boot.rooms ?? [];
    rememberUsers([state.me]);

    renderProfile();
    renderCoins();
    renderPopularity();
    renderBonus();
    renderPenalty();
    renderFriendsLock();
    renderRooms();
    renderTicker();
    refreshSocial();
    DATA.subscribeDm(onIncomingDm);
    // サブタブのトラック高さをアクティブ側に追随させる
    syncSubtabHeight();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => syncSubtabHeight());
      ro.observe($('subpanel-talk'));
      ro.observe($('subpanel-friend'));
    }
    // ジャンル選択肢（おまかせ＋全19種）は起動時に先読みして構築する
    // （作成モーダルを開く処理を同期に保つため）
    {
      const genres = await DATA.listGenres().catch(() => []);
      const genreSel = $('create-genre');
      while (genreSel.options.length > 1) genreSel.remove(1);
      for (const g of genres) {
        const o = document.createElement('option');
        o.value = g;
        o.textContent = g;
        genreSel.appendChild(o);
      }
    }

    $('btn-settings').addEventListener('click', () => openModal('modal-settings'));
    $('fm-profile').addEventListener('click', () => {
      const u = state.menuUser;
      if (u) openUserProfile(u);
    });
    $('fm-join').addEventListener('click', () => {
      const room = state.menuRoom;
      closeModal();
      if (!room) return;
      if (room.isPrivate) { toast('非公開ルームです'); return; }
      if (room.status === 'playing') { toast('対戦中です'); return; }
      enterRoom(room);
    });
    $('up-talk').addEventListener('click', () => {
      const u = state.profileUser;
      closeModal();
      if (u) openDm(u);
    });
    $('up-gift').addEventListener('click', () => {
      const u = state.profileUser;
      if (u) openGift(u);
    });
    $('btn-rules').addEventListener('click', () => openTutorial('view'));
    $('btn-tutorial-close').addEventListener('click', closeModal);
    $('btn-tutorial-cancel').addEventListener('click', () => {
      // キャンセル＝同意しない（未同意のまま）。入室はできず、入室系
      // アクションを試みるたびにチュートリアルが再表示される
      state.pendingEntry = null;
      closeModal();
    });
    $('btn-tutorial-agree').addEventListener('click', async () => {
      try {
        await DATA.agreeRules();
        state.rulesAgreed = true;
        renderFriendsLock();
        const action = state.pendingEntry;
        state.pendingEntry = null;
        closeModal();
        if (action) action();
      } catch (e) { toastError(e); }
    });
    $('btn-tutorial-prev').addEventListener('click', () => tutorialStep(-1));
    $('btn-tutorial-next').addEventListener('click', () => tutorialStep(1));
    { // スワイプでもスライドを送れるようにする
      let touchX = null;
      $('tutorial-viewport').addEventListener('touchstart', (e) => {
        touchX = e.changedTouches[0].clientX;
      }, { passive: true });
      $('tutorial-viewport').addEventListener('touchend', (e) => {
        if (touchX == null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) >= 40) tutorialStep(dx < 0 ? 1 : -1);
      }, { passive: true });
    }
    $('btn-blocklist').addEventListener('click', async () => {
      await renderBlocklist();
      openModal('modal-blocklist');
    });
    $('btn-account').addEventListener('click', () => toast('アカウント設定は認証接続フェーズで実装します'));
    $('btn-logout').addEventListener('click', () => toast('ログアウトは認証接続フェーズで実装します'));
    $('my-avatar').addEventListener('click', openIconModal);
    // 名前編集（タップで編集）。新規登録直後は「名前を決める」ポップアップ
    // として出し、決めるまで閉じられない（2026-11-25 おぎ）
    let nameSetupMode = false;
    function openNameModal(setup) {
      nameSetupMode = !!setup;
      $('name-title').textContent = setup ? '名前を決めよう' : '名前を編集';
      $('name-setup-note').classList.toggle('hidden', !setup);
      $('name-x').classList.toggle('hidden', !!setup);
      $('name-save').textContent = setup ? '決定する' : '保存する';
      $('name-input').value = setup ? '' : (state.me?.name ?? '');
      $('name-count').textContent = [...$('name-input').value].length;
      openModal('modal-name');
    }
    state.openNameSetup = () => openNameModal(true);
    $('my-name-btn').addEventListener('click', () => openNameModal(false));
    $('name-input').addEventListener('input', () => {
      $('name-count').textContent = [...$('name-input').value].length;
    });
    $('name-save').addEventListener('click', async () => {
      try {
        const r = await DATA.updateName($('name-input').value);
        state.me.name = r.displayName;
        state.me.nameDecidedAt = new Date().toISOString();
        rememberUsers([state.me]);
        renderProfile();
        const wasSetup = nameSetupMode;
        nameSetupMode = false;
        closeModal();
        toast(wasSetup ? '名前を決めました' : '名前を変更しました');
      } catch (e) { toastError(e); }
    });
    $('my-bio').addEventListener('click', () => {
      $('bio-input').value = state.me?.bio ?? '';
      $('bio-count').textContent = [...$('bio-input').value].length;
      openModal('modal-bio');
    });
    $('bio-input').addEventListener('input', () => {
      $('bio-count').textContent = [...$('bio-input').value].length;
    });
    $('bio-save').addEventListener('click', async () => {
      try {
        const r = await DATA.updateBio($('bio-input').value.trim());
        state.me.bio = r.bio;
        renderProfile();
        closeModal();
        toast('自己紹介を更新しました');
      } catch (e) { toastError(e); }
    });
    $('btn-invite').addEventListener('click', openInviteModal);
    $('pill-coins').addEventListener('click', () => openModal('modal-charge'));
    $('pill-popularity').addEventListener('click', () => toast('人気度はギフトをもらうと上がります'));
    $('bonus-banner').addEventListener('click', async () => {
      if (state.bonusClaimed) return;
      try {
        const r = await DATA.claimLoginBonus();
        if (r.claimed) {
          state.coins = r.coins;
          state.bonusClaimed = true;
          renderCoins();
          renderBonus();
          toast(`ログインボーナス +${r.amount}コインを受け取りました`);
        }
      } catch (e) { toastError(e); }
    });
    $('btn-friends-all').addEventListener('click', () => { switchTab('friends'); switchSubtab('friend'); });
    $('btn-random').addEventListener('click', () => {
      const open = state.rooms.filter(
        (r) => !r.isPrivate && r.status === 'lobby' && r.players < r.capacity);
      if (!open.length) { toast('今は入れる公開ルームがありません'); return; }
      const room = open[Math.floor(Math.random() * open.length)];
      requestJoin(room);
    });
    $('jc-join').addEventListener('click', () => {
      const room = state.joinTarget;
      closeModal();
      if (room) doEnterRoom(room);
    });
    $('btn-refresh').addEventListener('click', async () => {
      await refreshRooms();
      toast('ルーム一覧を更新しました');
    });
    $('btn-create-room').addEventListener('click', () => {
      // ルーム作成も入室行為なので、初回はルール同意が先
      ensureRulesConsent(() => {
        $('create-title').value = '';
        $('create-password').value = '';
        $('create-beginner').checked = true;
        $('create-reversal').checked = true;
        $('create-genre').value = '';
        document.querySelector('input[name="create-visibility"][value="public"]').checked = true;
        refreshCreateError();
        openModal('modal-create');
      });
    });

    // 待機室
    $('room-back').addEventListener('click', async () => {
      const id = state.roomId;
      closeRoomScreen();
      if (id) { try { await DATA.leaveRoom(id); } catch { /* 画面は閉じる */ } }
      refreshRooms();
    });
    $('btn-ready').addEventListener('click', async () => {
      if (!state.roomDetail) return;
      const mine = state.roomDetail.members.find((m) => m.id === state.me.id);
      try {
        await DATA.setReady(state.roomDetail.id, !(mine?.ready));
        // 反映は pollRoom に任せる（ここで detail を先に差し替えると、
        // pollRoom の lobby→playing 遷移検知が効かなくなるため）
        await pollRoom();
      } catch (e) { toastError(e); }
    });
    $('btn-start-game').addEventListener('click', async () => {
      if (!state.roomDetail) return;
      try {
        // 開始条件（満室＋全員の準備OK）はサーバー側でも判定される
        await DATA.startGame(state.roomDetail.id);
        state.roomDetail = await DATA.getRoom(state.roomDetail.id);
        renderRoomScreen();
        if (state.roomDetail.status === 'playing' && state.roomDetail.currentGame) {
          openGameScreen(state.roomDetail.currentGame.gameId);
        }
      } catch (e) { toastError(e); }
    });
    $('btn-enter-game').addEventListener('click', () => {
      if (state.roomDetail?.currentGame) openGameScreen(state.roomDetail.currentGame.gameId);
    });
    $('room-chat-send').addEventListener('click', sendRoomMessage);
    $('room-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) sendRoomMessage();
    });

    // 対戦画面（試合中に待機室へ戻る導線は置かない：ペナルティ回避に
    // なるため 2026-11-24 おぎ決定。戻れるのはゲーム終了パネルからだけ）
    $('game-send').addEventListener('click', sendGameMessage);
    $('game-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) sendGameMessage();
    });
    $('btn-end-towaiting').addEventListener('click', async () => {
      // 待機室に戻る：最新のルーム状態を取り直して待機室を開き直す
      const roomId = state.gameView?.roomId ?? state.roomId;
      closeGameScreen();
      state.endShownGameId = null;
      if (roomId) {
        try {
          openRoomScreen(await DATA.getRoom(roomId));
          return;
        } catch { /* メンバーでなくなっていた場合はロビーへ */ }
      }
      closeRoomScreen();
      refreshRooms();
    });
    $('btn-end-tolobby').addEventListener('click', () => {
      closeGameScreen();
      closeRoomScreen();
      state.endShownGameId = null;
      refreshRooms();
    });
    for (const radio of document.querySelectorAll('input[name="create-visibility"]')) {
      radio.addEventListener('change', refreshCreateError);
    }
    $('btn-create-confirm').addEventListener('click', confirmCreate);
    $('btn-create-cancel').addEventListener('click', closeModal);
    $('btn-create-charge').addEventListener('click', () => openModal('modal-charge'));
    $('tabbtn-lobby').addEventListener('click', () => switchTab('lobby'));
    $('tabbtn-friends').addEventListener('click', () => {
      // フレンドタブはチュートリアル同意まで開けない（おぎ仕様）
      if (!state.rulesAgreed) {
        toast('チュートリアルを完了すると使えます');
        return;
      }
      switchTab('friends');
      renderTalkList(); // システムDMなど、滞在中に届いた分を反映する
    });
    $('subtab-talk').addEventListener('click', () => { switchSubtab('talk'); renderTalkList(); });
    $('subtab-friend').addEventListener('click', () => switchSubtab('friend'));
    $('btn-friend-search').addEventListener('click', doSearch);
    $('friend-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });
    $('dm-back').addEventListener('click', closeDm);
    $('dm-send').addEventListener('click', sendDm);
    $('dm-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendDm();
    });
    $('dm-gift-btn').addEventListener('click', () => {
      if (state.dmPeer) openGift(state.dmPeer);
    });
    $('btn-group-new').addEventListener('click', openGroupCreate);
    $('btn-group-create').addEventListener('click', doCreateGroup);
    $('dm-members-btn').addEventListener('click', openGroupMembers);
    $('btn-group-add').addEventListener('click', doAddGroupMembers);
    $('btn-group-rename').addEventListener('click', doRenameGroup);
    $('btn-group-leave').addEventListener('click', doLeaveGroup);
    $('btn-gift-charge').addEventListener('click', () => openModal('modal-charge'));
    $('gc-x').addEventListener('click', closeGiftConfirm);
    $('gc-send').addEventListener('click', () => {
      const g = state.pendingGift;
      closeGiftConfirm();
      if (g) sendGift(g);
    });
    for (const c of document.querySelectorAll('[data-close]')) {
      c.addEventListener('click', backModal);
    }
    $('modal-backdrop').addEventListener('click', (e) => {
      if (e.target !== $('modal-backdrop')) return;
      // チュートリアル表示中は枠の外をタップしても閉じられない（おぎ仕様）
      if (!$('modal-tutorial').classList.contains('hidden')) return;
      // 名前決定ポップアップ（新規登録後）も外タップでは閉じられない
      if (!$('modal-name').classList.contains('hidden')
        && $('name-x').classList.contains('hidden')) return;
      backModal();
    });
    // 新規登録後、名前が未決定なら最初に決めてもらう（1回だけ）
    if (state.me && !state.me.nameDecidedAt) openNameModal(true);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
