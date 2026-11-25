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
  // 未実装ギフト（ギフト帯の表示確認用デモ。実カタログには入れない）
  extraGifts: [
    { key: 'diamond', name: 'ダイヤモンド', icon: '💎', price: 10000 },
    { key: 'dragon', name: 'ドラゴン', icon: '🐲', price: 5000 },
    { key: 'devil', name: '小悪魔', icon: '😈', price: 2000 },
    { key: 'angel', name: '天使', icon: '👼', price: 1500 },
    { key: 'moon', name: '三日月', icon: '🌙', price: 800 },
    { key: 'star', name: '星', icon: '⭐', price: 200 },
    { key: 'donut', name: 'ドーナツ', icon: '🍩', price: 150 },
    { key: 'balloon', name: '風船', icon: '🎈', price: 80 },
  ],
  // もらったギフト（ロビーのギフト帯表示用デモ。全16種で帯があふれる量）
  myGifts: [
    { giftKey: 'diamond', count: 1 },
    { giftKey: 'dragon', count: 1 },
    { giftKey: 'crown', count: 2 },
    { giftKey: 'devil', count: 3 },
    { giftKey: 'angel', count: 2 },
    { giftKey: 'ring', count: 5 },
    { giftKey: 'moon', count: 4 },
    { giftKey: 'teddy', count: 7 },
    { giftKey: 'cake', count: 12 },
    { giftKey: 'star', count: 9 },
    { giftKey: 'donut', count: 15 },
    { giftKey: 'coffee', count: 20 },
    { giftKey: 'candy', count: 18 },
    { giftKey: 'balloon', count: 25 },
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
    { id: 'r1', title: 'はじめてさん集合！', hostName: 'みか', hostIcon: '🐰', hostBg: '#ffeef5', isPrivate: false, beginner: true, players: 6, capacity: 7 },
    { id: 'r2', title: '経験者もOK部屋', hostName: 'けん', hostIcon: '🦉', hostBg: '#eef7ff', isPrivate: true, beginner: true, players: 7, capacity: 8 },
    { id: 'r3', title: 'まったり3分で1戦！', hostName: 'りす', hostIcon: '🐿️', hostBg: '#fff4e0', isPrivate: false, beginner: false, players: 3, capacity: 4, genre: '食べ物' },
    { id: 'r4', title: 'お昼休みのサクッと', hostName: 'にゃん', hostIcon: '🐱', hostBg: '#f0ecff', isPrivate: false, beginner: true, players: 6, capacity: 8 },
    { id: 'r5', title: '友達とわいわい部屋', hostName: 'そら', hostIcon: '🐥', hostBg: '#eafff3', isPrivate: true, beginner: false, players: 4, capacity: 6, genre: '恋愛' },
    { id: 'r6', title: 'いっしょに覚えよう', hostName: 'もち', hostIcon: '🐹', hostBg: '#fff0f3', isPrivate: false, beginner: true, players: 2, capacity: 8 },
  ],
};
