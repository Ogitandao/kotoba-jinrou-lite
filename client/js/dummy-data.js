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
  onlineFriends: [
    { name: 'みか', icon: '🐰', iconBg: '#ffeef5', roomTitle: 'はじめてさん集合！' },
    { name: 'けん', icon: '🦉', iconBg: '#eef7ff', roomTitle: null },
    { name: 'りす', icon: '🐿️', iconBg: '#fff4e0', roomTitle: 'まったり3分で1戦！' },
    { name: 'にゃん', icon: '🐱', iconBg: '#f0ecff', roomTitle: null },
  ],
  rooms: [
    { id: 'r7', title: '真剣勝負！いま対戦中', hostName: 'そら', hostIcon: '🐥', hostBg: '#eafff3', isPrivate: false, beginner: false, players: 5, capacity: 6, genre: '動物', status: 'playing' },
    { id: 'r1', title: 'はじめてさん集合！雑談しながら遊ぼう', hostName: 'みか', hostIcon: '🐰', hostBg: '#ffeef5', isPrivate: false, beginner: true, players: 6, capacity: 7 },
    { id: 'r2', title: '経験者もOK！真剣勝負部屋', hostName: 'けん', hostIcon: '🦉', hostBg: '#eef7ff', isPrivate: true, beginner: true, players: 7, capacity: 8 },
    { id: 'r3', title: 'まったり3分で1戦！気軽に参加', hostName: 'りす', hostIcon: '🐿️', hostBg: '#fff4e0', isPrivate: false, beginner: false, players: 3, capacity: 4, genre: '食べ物' },
    { id: 'r4', title: 'お昼休みのサクッと1セット', hostName: 'にゃん', hostIcon: '🐱', hostBg: '#f0ecff', isPrivate: false, beginner: true, players: 6, capacity: 8 },
    { id: 'r5', title: '友達とわいわい専用部屋', hostName: 'そら', hostIcon: '🐥', hostBg: '#eafff3', isPrivate: true, beginner: false, players: 4, capacity: 6, genre: '恋愛' },
    { id: 'r6', title: '初心者いっしょに覚えよう', hostName: 'もち', hostIcon: '🐹', hostBg: '#fff0f3', isPrivate: false, beginner: true, players: 2, capacity: 8 },
  ],
};
