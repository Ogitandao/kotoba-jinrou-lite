// ダミーデータ（基盤フェーズ用）。
// Supabase Lite プロジェクト接続フェーズで実データに差し替える。
// 画面の形と挙動を先に固めるためのローカル専用データ。
window.KL_DUMMY = {
  me: {
    name: 'おぎ',
    userId: 'ogi_2847',
    icon: '🐺',
    iconBg: '#eef4ff',
    online: true,
    bio: 'はじめまして！みんなで楽しくワードウルフしたいです。初心者なのでやさしく教えてください〜',
    coins: 1240,
    popularity: 98,
    bonusClaimed: false,
  },
  // 正式カタログは11種（2026-11-25 おぎ決定）。不採用の5種
  // （天使・三日月・星・ドーナツ・風船）は候補から外した
  // フレンドがもらったギフト（プロフィール表示用デモ）
  friendGifts: {
    'u-mika': [
      { giftKey: 'crown', count: 1 },
      { giftKey: 'cake', count: 3 },
      { giftKey: 'flower', count: 10 },
    ],
    'u-ken': [
      { giftKey: 'diamond', count: 3 },
      { giftKey: 'dragon', count: 2 },
      { giftKey: 'crown', count: 4 },
      { giftKey: 'devil', count: 2 },
      { giftKey: 'ring', count: 2 },
      { giftKey: 'teddy', count: 9 },
      { giftKey: 'cake', count: 21 },
      { giftKey: 'coffee', count: 12 },
      { giftKey: 'candy', count: 17 },
      { giftKey: 'flower', count: 33 },
      { giftKey: 'heart', count: 48 },
    ],
    'u-risu': [
      { giftKey: 'heart', count: 20 },
    ],
    'u-nyan': [
      { giftKey: 'candy', count: 7 },
    ],
  },
  // もらったギフト（ロビーのギフト帯表示用デモ。全11種で帯があふれる量）
  myGifts: [
    { giftKey: 'diamond', count: 1 },
    { giftKey: 'dragon', count: 1 },
    { giftKey: 'crown', count: 2 },
    { giftKey: 'devil', count: 3 },
    { giftKey: 'ring', count: 5 },
    { giftKey: 'teddy', count: 7 },
    { giftKey: 'cake', count: 12 },
    { giftKey: 'coffee', count: 20 },
    { giftKey: 'candy', count: 18 },
    { giftKey: 'flower', count: 30 },
    { giftKey: 'heart', count: 34 },
  ],
  onlineFriends: [
    { name: 'みか', icon: '🐰', iconBg: '#ffeef5', roomTitle: 'はじめてさん集合！' },
    { name: 'けん', icon: '🦉', iconBg: '#eef7ff', roomTitle: null },
    { name: 'りす', icon: '🐿️', iconBg: '#fff4e0', roomTitle: 'まったり3分で1戦！' },
    { name: 'にゃん', icon: '🐱', iconBg: '#f0ecff', roomTitle: null },
  ],
  rooms: [
    { id: 'r7', title: '真剣勝負！いま対戦中', hostName: 'そら', hostIcon: '🐥', hostBg: '#eafff3', isPrivate: false, beginner: true, players: 5, capacity: 6, genre: '季節・イベント', status: 'playing' },
    // 最長要素ぜんぶ入りサンプル（おぎ確認用）：部屋名10文字＋7/8人＋最長ジャンル＋初心者歓迎
    { id: 'r8', title: 'わいわいまったり部屋', hostName: 'もち', hostIcon: '🐹', hostBg: '#fff7e0', isPrivate: false, beginner: true, players: 7, capacity: 8, genre: '季節・イベント' },
    { id: 'r1', title: 'はじめてさん集合！', hostName: 'みか', hostIcon: '🐰', hostBg: '#ffeef5', isPrivate: false, beginner: true, players: 6, capacity: 7 },
    { id: 'r2', title: '経験者もOK部屋', hostName: 'けん', hostIcon: '🦉', hostBg: '#eef7ff', isPrivate: true, beginner: true, players: 7, capacity: 8 },
    { id: 'r3', title: 'まったり3分で1戦！', hostName: 'りす', hostIcon: '🐿️', hostBg: '#fff4e0', isPrivate: false, beginner: false, players: 3, capacity: 4, genre: '食べ物', reversalEnabled: false },
    { id: 'r4', title: 'お昼休みのサクッと', hostName: 'にゃん', hostIcon: '🐱', hostBg: '#f0ecff', isPrivate: false, beginner: true, players: 6, capacity: 8 },
    { id: 'r5', title: '友達とわいわい部屋', hostName: 'そら', hostIcon: '🐥', hostBg: '#eafff3', isPrivate: true, beginner: false, players: 4, capacity: 6, genre: '恋愛' },
    { id: 'r6', title: 'いっしょに覚えよう', hostName: 'もち', hostIcon: '🐹', hostBg: '#fff0f3', isPrivate: false, beginner: true, players: 2, capacity: 8 },
  ],
};
