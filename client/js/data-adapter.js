// データ層アダプタ（ことば人狼 Lite）。
//
// 画面（app.js）はこのアダプタ越しにだけデータへ触る。裏側は2系統：
// - SimBackend：ローカル完結のデモ用インメモリ実装。判定ルールと
//   エラーコードは実環境の RPC（supabase/migrations/0005_rpc_social.sql）
//   および sim/social.mjs と揃えてある。実 DB 未適用・未ログイン時は
//   こちらで動く。
// - SupabaseBackend：KL_CONFIG に URL/キーが入り、ログインセッションが
//   ある場合に使う。読み取りは RLS 前提の select、書き込みは kl_* RPC。
//
// 切り替え方針：SupabaseBackend の bootstrap がセッションなし等で
// 失敗したら SimBackend に落ちる（デモモード）。画面側は常に同じ
// インターフェース（Promise を返すメソッド群）だけを見る。
(function () {
  'use strict';

  const GIFT_CATALOG = [
    { key: 'heart', name: 'ハート', icon: '❤️', price: 30 },
    { key: 'flower', name: 'お花', icon: '🌸', price: 50 },
    { key: 'candy', name: 'キャンディ', icon: '🍬', price: 100 },
    { key: 'coffee', name: 'コーヒー', icon: '☕', price: 100 },
    { key: 'cake', name: 'ケーキ', icon: '🎂', price: 300 },
    { key: 'teddy', name: 'テディベア', icon: '🧸', price: 500 },
    { key: 'ring', name: '指輪', icon: '💍', price: 1000 },
    { key: 'crown', name: '王冠', icon: '👑', price: 3000 },
  ];

  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  // アイコンカタログ（無料プリセット15種）。選択可否・所有の正本は
  // 実 DB の icons テーブル（0017）で、これは同内容のクライアント側
  // ミラー。画像は client/icons/icon-<key>.webp に同梱する。
  // 将来 win / coin ティアが DB に増えたら listIcons は DB 側が正本に
  // なる（Sim はこの無料分のみを返す）。
  const ICON_CATALOG = [
    { key: 'man1', name: '男性・黒髪', tier: 'free', priceCoins: null, winThreshold: null, sort: 1 },
    { key: 'man2', name: '男性・茶髪', tier: 'free', priceCoins: null, winThreshold: null, sort: 2 },
    { key: 'man3', name: '男性・眼鏡', tier: 'free', priceCoins: null, winThreshold: null, sort: 3 },
    { key: 'woman1', name: '女性・ロング', tier: 'free', priceCoins: null, winThreshold: null, sort: 4 },
    { key: 'woman2', name: '女性・ボブ', tier: 'free', priceCoins: null, winThreshold: null, sort: 5 },
    { key: 'woman3', name: '女性・ポニーテール', tier: 'free', priceCoins: null, winThreshold: null, sort: 6 },
    { key: 'wolf', name: 'おおかみ', tier: 'free', priceCoins: null, winThreshold: null, sort: 7 },
    { key: 'dog', name: 'いぬ', tier: 'free', priceCoins: null, winThreshold: null, sort: 8 },
    { key: 'cat', name: 'ねこ', tier: 'free', priceCoins: null, winThreshold: null, sort: 9 },
    { key: 'rabbit', name: 'うさぎ', tier: 'free', priceCoins: null, winThreshold: null, sort: 10 },
    { key: 'bear', name: 'くま', tier: 'free', priceCoins: null, winThreshold: null, sort: 11 },
    { key: 'panda', name: 'パンダ', tier: 'free', priceCoins: null, winThreshold: null, sort: 12 },
    { key: 'penguin', name: 'ペンギン', tier: 'free', priceCoins: null, winThreshold: null, sort: 13 },
    { key: 'owl', name: 'ふくろう', tier: 'free', priceCoins: null, winThreshold: null, sort: 14 },
    { key: 'tanuki', name: 'たぬき', tier: 'free', priceCoins: null, winThreshold: null, sort: 15 },
    { key: 'chick', name: 'ひよこ', tier: 'free', priceCoins: null, winThreshold: null, sort: 16 },
    { key: 'frog', name: 'かえる', tier: 'free', priceCoins: null, winThreshold: null, sort: 17 },
    { key: 'tiger', name: 'とら', tier: 'free', priceCoins: null, winThreshold: null, sort: 18 },
    { key: 'koala', name: 'こあら', tier: 'win', priceCoins: null, winThreshold: 5, sort: 19 },
    { key: 'seal', name: 'あざらし', tier: 'win', priceCoins: null, winThreshold: 10, sort: 20 },
    { key: 'fox', name: 'きつね', tier: 'win', priceCoins: null, winThreshold: 20, sort: 21 },
  ];
  const ICON_KEY_SET = new Set(ICON_CATALOG.map((c) => c.key));
  // プリセット画像の URL を返す（同梱ファイルがある key のみ）。
  // 画面側（app.js の avatarSpan）が同期描画で使うための公開ヘルパー。
  window.KL_ICON_SRC = (key) => (key && ICON_KEY_SET.has(key) ? `icons/icon-${key}.webp` : null);

  // お題ジャンル（カテゴリ）全19種。実 DB の ww_topics.category が正本で、
  // クライアントからはお題テーブルを読めないため固定リストで持つ
  // （サーバー側 ww_create_room が実在チェック＝INVALID_GENRE で担保）。
  // 並びはお題数の多い順。null は「おまかせ」を表す
  const WW_GENRE_LIST = [
    '食べ物', '場所', '遊び・趣味', '動物', '恋愛', 'スポーツ',
    '季節・イベント', '学校', '自然・天気', '飲み物', '乗り物',
    '家電・日用品', 'エンタメ', '仕事', 'ファッション', '家・暮らし',
    '体・健康', '家族・友人', 'デジタル',
  ];

  // =====================================================================
  // SimBackend（デモ用。KL_DUMMY の世界を土台にソーシャル分を足す）
  // =====================================================================
  function createSimBackend() {
    const D = window.KL_DUMMY;
    // もらったギフトの集計（カタログ引き＋価格順ソート）。自分用・他人用で共用
    const giftSummaryOf = (list) => {
      const lookup = [...GIFT_CATALOG, ...(D.extraGifts ?? [])];
      return list
        .map((g) => {
          const c = lookup.find((x) => x.key === g.giftKey);
          return c ? { giftKey: c.key, name: c.name, icon: c.icon, price: c.price, count: g.count } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.price - a.price || b.count - a.count);
    };
    // もらったギフトのランタイム台帳（初期値はダミーデータ、送信で増える）
    let friendGiftsLedger = null;
    const friendGiftsOf = (userId) => {
      friendGiftsLedger ??= JSON.parse(JSON.stringify(D.friendGifts ?? {}));
      return (friendGiftsLedger[userId] ??= []);
    };
    const users = new Map();
    const addUser = (u) => users.set(u.id, {
      popularity: 0, wordwolfWins: 0, online: false, ...u,
    });
    addUser({
      id: 'me', publicId: D.me.userId, name: D.me.name, icon: D.me.icon, iconKey: 'wolf',
      iconBg: D.me.iconBg, bio: D.me.bio, popularity: D.me.popularity, online: true,
      nameDecidedAt: '2026-01-01T00:00:00Z',
    });
    addUser({ id: 'u-mika', publicId: 'mika_1024', name: 'みか', icon: '🐰', iconKey: 'rabbit', iconBg: '#ffeef5', bio: 'ワードウルフ大好き！毎晩やってます', popularity: 320, online: true, roomTitle: 'はじめてさん集合！', wordwolfWins: 42 });
    addUser({ id: 'u-ken', publicId: 'ken_7788', name: 'けん', icon: '🦉', iconKey: 'owl', iconBg: '#eef7ff', bio: '毎晩ワードウルフで遊んでます！推理で追い詰めるのが快感。初心者さん歓迎、まったり部屋によく出没します', popularity: 560000, online: true, roomTitle: null, wordwolfWins: 1024 });
    addUser({ id: 'u-risu', publicId: 'risu_2049', name: 'りす', icon: '🐿️', iconKey: null, iconBg: '#fff4e0', bio: 'まったり勢です〜', popularity: 87, online: true, roomTitle: 'まったり3分で1戦！', wordwolfWins: 15 });
    addUser({ id: 'u-nyan', publicId: 'nyan_5566', name: 'にゃん', icon: '🐱', iconKey: 'cat', iconBg: '#f0ecff', bio: 'にゃーん', popularity: 45, online: true, roomTitle: null, wordwolfWins: 8 });
    addUser({ id: 'u-sora', publicId: 'sora_3310', name: 'そら', icon: '🐥', iconKey: 'chick', iconBg: '#eafff3', bio: '昨日はじめました！よろしくです', popularity: 3, online: false, wordwolfWins: 1 });
    addUser({ id: 'u-mochi', publicId: 'mochi_9012', name: 'もち', icon: '🐹', iconKey: null, iconBg: '#fff0f3', bio: 'もちもちしてます', popularity: 12, online: false, wordwolfWins: 3 });
    addUser({ id: 'u-ai', publicId: 'ai_6611', name: 'あい', icon: '🐨', iconKey: 'koala', iconBg: '#e6f7ff', bio: 'コアラのようにのんびり遊んでます', popularity: 28, online: false, wordwolfWins: 5 });
    // 自分の選択アイコンは Sim でも再読込で維持する（実 DB では
    // profiles.icon_key が正本。Sim は localStorage で肩代わり）
    try {
      const saved = localStorage.getItem('kl_icon_key');
      if (saved && ICON_KEY_SET.has(saved)) users.get('me').iconKey = saved;
    } catch { /* 保存できない環境ではメモリのみ */ }
    // システム通知の送信者（ペナルティ通知など。返信不可の読み取り専用）
    addUser({ id: 'system', publicId: 'system', name: 'システム', icon: '📢', iconBg: '#eef4ff', bio: '', popularity: 0, online: false });

    const state = {
      coins: D.me.coins,
      bonusClaimed: D.me.bonusClaimed,
      friends: new Set(['u-mika', 'u-ken', 'u-risu', 'u-nyan']),
      incoming: new Set(['u-sora']),
      outgoing: new Set(),
      blocked: new Set(),
      dm: [
        // ようこそDM（実 DB では handle_new_user が登録時に kind='welcome'
        // で1件送る。本文は 0018 の SQL と一致させること）
        { id: 'dm-0', from: 'system', to: 'me', kind: 'welcome', body: 'ことば人狼へようこそ！🎉\n登録ありがとうございます。登録ボーナスとして100コインをプレゼントしました。\nはじめてルームに入るときに、遊び方とルールのチュートリアルが表示されます。下の「チュートリアルはこちら」からいつでも見返せます。\nみんなで楽しく遊びましょう！', read: false },
        { id: 'dm-1', from: 'u-mika', to: 'me', kind: 'text', body: '昨日はありがとう！また遊ぼうね', read: true },
        { id: 'dm-2', from: 'u-mika', to: 'me', kind: 'text', body: '今日の夜、部屋立てるから来て〜', read: false },
        { id: 'dm-3', from: 'me', to: 'u-ken', kind: 'text', body: 'この前の推理すごかった！', read: true },
        { id: 'dm-4', from: 'u-ken', to: 'me', kind: 'text', body: 'ありがとう！また真剣勝負しよう', read: true },
        // デモ用シード：非公開ルームへの招待カード（入室導線の確認用）
        { id: 'dm-5', from: 'u-ken', to: 'me', kind: 'invite', invite: { roomId: 'r2', roomTitle: '経験者もOK部屋', password: 'wolf777' }, read: false },
      ],
      seq: 100,
      ticker: [
        // デモ用シード：運営告知（期限付き）の見え方確認用。本番では
        // kl__ticker_notice で投稿した告知が期限まで先頭に流れ続ける（0029）
        { id: 'notice-demo', text: '📢 運営より：新しいお題を50組追加しました！' },
      ],
    };
    const pub = (u) => ({
      id: u.id, publicId: u.publicId, name: u.name, icon: u.icon,
      iconKey: u.iconKey ?? null,
      iconBg: u.iconBg, bio: u.bio, popularity: u.popularity, online: u.online,
      roomTitle: u.roomTitle ?? null,
    });
    const ok = (v) => Promise.resolve(v);

    // =================================================================
    // ワードウルフ（SimBackend 用エンジン）
    // sim/server.mjs（＝実 DB の ww_* RPC）のブラウザ移植。ルール・
    // エラーコードは揃えてある。時刻は「実時刻＋テスト用オフセット」
    // の仮想時計（秒）で、締め切り判定はサーバー役のこのエンジンが
    // 行う（画面側の時計は表示専用）。
    // デモ用の割り切り：
    // - ダミールームにはダミーユーザーが先に「参加済み」でいる
    // - ボットは常時準備OK。ボットがホストの部屋は、全員準備OK＆
    //   4人以上で自動開始する（1人デモでも対戦が回るように）
    // - 自分が作った部屋にはボット3人が自動で参加する
    // - ボットは話し合いで定型文を1回発言し、投票はランダム、
    //   逆転回答は即時にランダム選択する
    // =================================================================
    // お題は実 DB（ww_topics）と同一の451組（確定429組＋初期22組）。
    // ジャンル抽選に使うカテゴリ一覧はここから導出する
    const WW_TOPICS = [
      ['飲み物', 'コーヒー', 'ウーロン茶'], ['食べ物', 'そば', 'うどん'], ['食べ物', 'りんご', 'なし'],
      ['食べ物', 'カレー', 'シチュー'], ['食べ物', 'スイカ', 'メロン'], ['場所', '海', 'プール'],
      ['スポーツ', 'スキー', 'スケート'], ['動物', '犬', '猫'], ['季節・イベント', '夏休み', '冬休み'],
      ['場所', '水族館', '動物園'], ['乗り物', '電車', 'バス'], ['遊び・趣味', 'ピアノ', 'ギター'],
      ['食べ物', '寿司', '焼肉'], ['場所', '温泉', 'サウナ'], ['場所', '映画館', 'カラオケ'],
      ['食べ物', 'パン', 'ごはん'], ['自然・天気', '雪', '雨'], ['スポーツ', 'サッカー', '野球'],
      ['遊び・趣味', '読書', 'ゲーム'], ['季節・イベント', '花火', 'イルミネーション'], ['食べ物', 'ケーキ', 'プリン'],
      ['自然・天気', '山', '川'], ['食べ物', 'ラーメン', 'つけ麺'], ['食べ物', 'ハンバーガー', 'サンドイッチ'],
      ['食べ物', 'おにぎり', 'お茶漬け'], ['食べ物', 'ピザ', 'パスタ'], ['食べ物', '焼きそば', '焼うどん'],
      ['食べ物', '餃子', 'しゅうまい'], ['食べ物', 'たこ焼き', 'お好み焼き'], ['食べ物', 'オムライス', 'ハヤシライス'],
      ['食べ物', '天ぷら', 'からあげ'], ['食べ物', 'みそ汁', 'コーンスープ'], ['食べ物', 'チャーハン', 'ピラフ'],
      ['食べ物', '親子丼', 'カツ丼'], ['食べ物', 'アイスクリーム', 'かき氷'], ['食べ物', 'チョコレート', 'あめ'],
      ['食べ物', 'ポテトチップス', 'ポップコーン'], ['食べ物', 'ヨーグルト', 'ゼリー'], ['食べ物', 'バナナ', 'みかん'],
      ['食べ物', 'ぶどう', 'もも'], ['食べ物', 'いちご', 'さくらんぼ'], ['食べ物', 'トマト', 'きゅうり'],
      ['食べ物', 'キャベツ', 'レタス'], ['食べ物', 'にんじん', 'じゃがいも'], ['食べ物', '卵焼き', '目玉焼き'],
      ['食べ物', '納豆', '豆腐'], ['食べ物', 'チーズ', 'バター'], ['食べ物', 'ハンバーグ', 'ステーキ'],
      ['食べ物', '焼き鳥', '串カツ'], ['食べ物', 'ドーナツ', 'マフィン'], ['食べ物', 'ソフトクリーム', 'クレープ'],
      ['食べ物', 'おでん', '鍋'], ['飲み物', '紅茶', '緑茶'], ['飲み物', 'オレンジジュース', 'ぶどうジュース'],
      ['飲み物', '牛乳', '豆乳'], ['飲み物', 'コーラ', 'サイダー'], ['飲み物', '麦茶', 'ほうじ茶'],
      ['飲み物', 'ミルクティー', 'レモンティー'], ['飲み物', 'ホットココア', 'カフェラテ'], ['飲み物', 'スポーツドリンク', 'エナジードリンク'],
      ['飲み物', 'スムージー', 'ミルクシェイク'], ['飲み物', '甘酒', 'おしるこ'], ['飲み物', '水', '炭酸水'],
      ['飲み物', 'レモネード', 'アイスティー'], ['飲み物', 'タピオカドリンク', 'フルーツティー'], ['飲み物', '青汁', '野菜ジュース'],
      ['場所', '図書館', '本屋'], ['場所', '美術館', '博物館'], ['場所', '神社', 'お寺'],
      ['場所', '城', '宮殿'], ['場所', 'スーパー', 'コンビニ'], ['場所', 'デパート', 'ショッピングモール'],
      ['場所', '魚市場', '商店街'], ['場所', '病院', '薬局'], ['場所', '学校', '塾'],
      ['場所', '駅', '空港'], ['場所', '遊園地', 'ゲームセンター'], ['場所', 'キャンプ場', 'バーベキュー場'],
      ['場所', 'ビーチ', '川原'], ['場所', 'ホテル', '旅館'], ['場所', 'カフェ', 'パン屋'],
      ['場所', '居酒屋', 'バー'], ['場所', '定食屋', 'ファミリーレストラン'], ['場所', '美容院', '床屋'],
      ['場所', '銭湯', '岩盤浴'], ['場所', '駅ビル', '地下街'], ['場所', '道の駅', 'サービスエリア'],
      ['場所', '劇場', 'ライブハウス'], ['場所', 'プラネタリウム', '天文台'], ['場所', '牧場', '農園'],
      ['場所', '屋台', 'フードトラック'], ['場所', '交番', '郵便局'], ['動物', 'うさぎ', 'ハムスター'],
      ['動物', '馬', '牛'], ['動物', '羊', 'ヤギ'], ['動物', '豚', 'イノシシ'],
      ['動物', 'ライオン', 'トラ'], ['動物', 'ゾウ', 'キリン'], ['動物', 'パンダ', 'コアラ'],
      ['動物', 'サル', 'ゴリラ'], ['動物', 'ペンギン', 'アザラシ'], ['動物', 'フクロウ', 'タカ'],
      ['動物', 'カメ', 'トカゲ'], ['動物', 'ヘビ', 'ワニ'], ['動物', '金魚', 'メダカ'],
      ['動物', '蝶', 'トンボ'], ['動物', 'カブトムシ', 'クワガタ'], ['動物', 'セミ', 'コオロギ'],
      ['動物', 'イルカ', 'クジラ'], ['動物', 'サメ', 'エイ'], ['動物', 'タコ', 'イカ'],
      ['動物', 'カニ', 'エビ'], ['動物', 'ニワトリ', 'アヒル'], ['動物', 'スズメ', 'カラス'],
      ['動物', 'キツネ', 'タヌキ'], ['動物', 'シカ', 'リス'], ['スポーツ', 'テニス', 'バドミントン'],
      ['スポーツ', '卓球', 'ビリヤード'], ['スポーツ', 'バスケットボール', 'バレーボール'], ['スポーツ', 'ラグビー', 'アメリカンフットボール'],
      ['スポーツ', 'ゴルフ', 'ゲートボール'], ['スポーツ', '水泳', 'サーフィン'], ['スポーツ', 'ジョギング', 'ウォーキング'],
      ['スポーツ', 'ヨガ', 'ピラティス'], ['スポーツ', '柔道', '剣道'], ['スポーツ', '空手', 'テコンドー'],
      ['スポーツ', '相撲', 'プロレス'], ['スポーツ', 'マラソン', '駅伝'], ['スポーツ', 'スケートボード', 'BMX'],
      ['スポーツ', 'アーチェリー', '射撃'], ['スポーツ', 'フェンシング', '馬術'], ['スポーツ', 'カヌー', 'ラフティング'],
      ['スポーツ', 'スノーボード', 'そり'], ['スポーツ', 'ダーツ', 'ボウリング'], ['スポーツ', 'バレエ', '新体操'],
      ['スポーツ', 'スカイダイビング', 'バンジージャンプ'], ['乗り物', '自転車', 'バイク'], ['乗り物', '車', 'キャンピングカー'],
      ['乗り物', '飛行機', 'ヘリコプター'], ['乗り物', 'フェリー', '潜水艦'], ['乗り物', '新幹線', 'SL機関車'],
      ['乗り物', 'モノレール', 'ロープウェイ'], ['乗り物', 'エスカレーター', 'エレベーター'], ['乗り物', 'タクシー', 'レンタカー'],
      ['乗り物', '救急車', '消防車'], ['乗り物', '三輪車', '一輪車'], ['乗り物', '気球', 'プライベートジェット'],
      ['乗り物', '馬車', '人力車'], ['乗り物', 'ロケット', 'ミサイル'], ['乗り物', 'ベビーカー', '車椅子'],
      ['遊び・趣味', '釣り', '虫取り'], ['遊び・趣味', 'キャンプ', 'バーベキュー'], ['遊び・趣味', 'ガーデニング', '盆栽'],
      ['遊び・趣味', '料理', 'お菓子作り'], ['遊び・趣味', '工作', '日曜大工'], ['遊び・趣味', '写真撮影', 'お絵描き'],
      ['遊び・趣味', '将棋', '囲碁'], ['遊び・趣味', '麻雀', '花札'], ['遊び・趣味', 'トランプ', 'すごろく'],
      ['遊び・趣味', 'ジグソーパズル', '数独'], ['遊び・趣味', 'プラモデル', 'ラジコン'], ['遊び・趣味', 'コスプレ', '着ぐるみ'],
      ['遊び・趣味', '映画鑑賞', '音楽鑑賞'], ['遊び・趣味', 'コンサート', 'フェス'], ['遊び・趣味', '推し活', '聖地巡礼'],
      ['遊び・趣味', '国内旅行', '海外旅行'], ['遊び・趣味', '登山', 'ハイキング'], ['遊び・趣味', 'サイクリング', 'ドライブ'],
      ['遊び・趣味', '天体観測', 'バードウォッチング'], ['遊び・趣味', 'バイオリン', 'チェロ'], ['遊び・趣味', 'フルート', 'クラリネット'],
      ['遊び・趣味', '和太鼓', '三味線'], ['遊び・趣味', '書道', '絵手紙'], ['遊び・趣味', '茶道', '華道'],
      ['季節・イベント', 'お正月', 'クリスマス'], ['季節・イベント', 'バレンタインデー', 'ホワイトデー'], ['季節・イベント', 'ハロウィン', 'イースター'],
      ['季節・イベント', '七夕', 'お月見'], ['季節・イベント', 'ひな祭り', 'こどもの日'], ['季節・イベント', 'お花見', '紅葉狩り'],
      ['季節・イベント', '初詣', '初日の出'], ['季節・イベント', '花火大会', '夏祭り'], ['季節・イベント', '大晦日', '元日'],
      ['季節・イベント', 'ゴールデンウィーク', 'シルバーウィーク'], ['季節・イベント', 'お盆', 'お彼岸'], ['季節・イベント', '卒業式', '入学式'],
      ['季節・イベント', '結婚式', '同窓会'], ['季節・イベント', '誕生日', '記念日'], ['季節・イベント', '盆踊り', '阿波踊り'],
      ['季節・イベント', 'オリンピック', 'ワールドカップ'], ['季節・イベント', '母の日', '父の日'], ['季節・イベント', '成人式', '七五三'],
      ['自然・天気', '湖', '沼'], ['自然・天気', '森', '草原'], ['自然・天気', '砂漠', 'オアシス'],
      ['自然・天気', '滝', '泉'], ['自然・天気', '洞窟', '峡谷'], ['自然・天気', '虹', 'オーロラ'],
      ['自然・天気', '雷', '雹'], ['自然・天気', '霧', '雲'], ['自然・天気', '台風', '竜巻'],
      ['自然・天気', '満月', '三日月'], ['自然・天気', '流れ星', '彗星'], ['自然・天気', '桜', '梅'],
      ['自然・天気', '夕日', '朝日'], ['自然・天気', '日食', '月食'], ['学校', '国語', '数学'],
      ['学校', '理科', '社会'], ['学校', '英語', '体育'], ['学校', '図工', '家庭科'],
      ['学校', '給食', 'お弁当'], ['学校', '宿題', '自由研究'], ['学校', '運動会', '文化祭'],
      ['学校', '修学旅行', '遠足'], ['学校', '始業式', '終業式'], ['学校', '黒板', 'ホワイトボード'],
      ['学校', 'ランドセル', '上履き'], ['学校', '教科書', '問題集'], ['学校', '鉛筆', 'シャープペンシル'],
      ['学校', '制服', '体操服'], ['学校', '部活', '習い事'], ['学校', '図書室', '保健室'],
      ['仕事', '医者', '看護師'], ['仕事', '教師', '保育士'], ['仕事', '警察官', '消防士'],
      ['仕事', '料理人', 'パティシエ'], ['仕事', '農家', '漁師'], ['仕事', '大工', '建築家'],
      ['仕事', '美容師', 'ネイリスト'], ['仕事', 'パイロット', '客室乗務員'], ['仕事', '電車の運転士', '車掌'],
      ['仕事', '歌手', '声優'], ['仕事', '漫画家', '画家'], ['仕事', 'スーパーモデル', '服飾デザイナー'],
      ['仕事', '弁護士', '裁判官'], ['仕事', 'Youtuber', 'ライブ配信者'], ['仕事', 'アナウンサー', 'リポーター'],
      ['仕事', '店員', '店長'], ['家族・友人', 'お父さん', 'お母さん'], ['家族・友人', 'お兄ちゃん', 'お姉ちゃん'],
      ['家族・友人', '弟', '妹'], ['家族・友人', 'おじいちゃん', 'おばあちゃん'], ['家族・友人', '親友', 'ライバル'],
      ['家族・友人', '友達', '知り合い'], ['家族・友人', '先輩', '後輩'], ['家族・友人', '同僚', '上司'],
      ['家族・友人', 'ご近所さん', '親戚'], ['家族・友人', 'いとこ', '甥っ子'], ['家族・友人', '双子', '三つ子'],
      ['家族・友人', '一人っ子', '大家族'], ['家族・友人', '長男', '末っ子'], ['家族・友人', '実家暮らし', '一人暮らし'],
      ['家電・日用品', '冷蔵庫', '電子レンジ'], ['家電・日用品', '洗濯機', '乾燥機'], ['家電・日用品', '掃除機', '空気清浄機'],
      ['家電・日用品', 'テレビ', 'プロジェクター'], ['家電・日用品', 'エアコン', '扇風機'], ['家電・日用品', 'ストーブ', 'こたつ'],
      ['家電・日用品', 'ドライヤー', 'ヘアアイロン'], ['家電・日用品', '電気ケトル', 'コーヒーメーカー'], ['家電・日用品', '炊飯器', '圧力鍋'],
      ['家電・日用品', 'トースター', 'ホットサンドメーカー'], ['家電・日用品', 'シャンプー', 'リンス'], ['家電・日用品', '石鹸', 'ボディソープ'],
      ['家電・日用品', 'ハンカチ', 'ティッシュ'], ['家電・日用品', '傘', 'レインコート'], ['家電・日用品', '眼鏡', 'サングラス'],
      ['家電・日用品', '腕時計', '置き時計'], ['家電・日用品', '洗剤', '柔軟剤'], ['家電・日用品', '布団', '毛布'],
      ['恋愛', '初恋', '片思い'], ['恋愛', '脈あり', '脈なし'], ['恋愛', '両思い', '友達止まり'],
      ['恋愛', '告白', '失恋'], ['恋愛', '映画デート', '遊園地デート'], ['恋愛', '浴衣デート', '制服デート'],
      ['恋愛', '放課後デート', '休日デート'], ['恋愛', 'ランチデート', 'ディナーデート'], ['恋愛', '手つなぎ', 'ハグ'],
      ['恋愛', '初キス', '初デート'], ['恋愛', '本命チョコ', '義理チョコ'], ['恋愛', '一目惚れ', 'ストーカー'],
      ['恋愛', 'マッチングアプリ', '結婚相談所'], ['恋愛', 'マッチングアプリ', '出会い系サイト'], ['恋愛', '年上の恋人', '年下の恋人'],
      ['恋愛', '遠距離恋愛', '社内恋愛'], ['恋愛', '同棲', 'ルームシェア'], ['恋愛', '婚約指輪', '結婚指輪'],
      ['恋愛', '嫉妬', '束縛'], ['恋愛', '喧嘩', '仲直り'], ['恋愛', '壁ドン', '頭ポンポン'],
      ['恋愛', '恋人つなぎ', '腕を組む'], ['恋愛', '恋愛相談', '恋愛占い'], ['恋愛', '長電話', 'おやすみ前のLINE'],
      ['恋愛', '草食系', '肉食系'], ['恋愛', 'ツンデレ', '素直'], ['恋愛', '甘えん坊', 'しっかり者'],
      ['恋愛', '尽くす', '甘える'], ['恋愛', '追う恋', '追われる恋'], ['恋愛', '身長差', '年齢差'],
      ['恋愛', 'あだ名', '呼び捨て'], ['恋愛', '趣味の相性', '食の相性'], ['家・暮らし', 'キッチン', 'ダイニング'],
      ['家・暮らし', '浴室', '洗面所'], ['家・暮らし', '玄関', 'ベランダ'], ['家・暮らし', '寝室', '子供部屋'],
      ['家・暮らし', 'ソファ', 'ベッド'], ['家・暮らし', 'テーブル', 'カウンター'], ['家・暮らし', 'カーテン', 'ブラインド'],
      ['家・暮らし', 'カーペット', 'フローリング'], ['家・暮らし', '階段', '廊下'], ['家・暮らし', '屋根裏', '地下室'],
      ['家・暮らし', '一戸建て', 'マンション'], ['家・暮らし', 'アパート', 'シェアハウス'], ['家・暮らし', '引っ越し', '大掃除'],
      ['家・暮らし', '洗濯', 'アイロンがけ'], ['家・暮らし', '庭', '駐車場'], ['ファッション', 'Tシャツ', 'パーカー'],
      ['ファッション', 'ジーンズ', 'スカート'], ['ファッション', 'ワンピース', 'ブラウス'], ['ファッション', 'スニーカー', 'ブーツ'],
      ['ファッション', 'ビーチサンダル', '室内スリッパ'], ['ファッション', 'ニット帽', 'キャップ'], ['ファッション', 'マフラー', '手袋'],
      ['ファッション', 'コート', 'ジャケット'], ['ファッション', 'スーツ', 'タキシード'], ['ファッション', 'パジャマ', 'バスローブ'],
      ['ファッション', '水着', '浴衣'], ['ファッション', 'ネクタイ', 'ベルト'], ['ファッション', '指輪', 'ネックレス'],
      ['ファッション', '財布', 'コインケース'], ['ファッション', 'ピアス', 'イヤリング'], ['ファッション', 'リュック', 'トートバッグ'],
      ['体・健康', '筋トレ', 'ストレッチ'], ['体・健康', '早起き', '夜ふかし'], ['体・健康', 'ダイエット', '禁酒'],
      ['体・健康', '風邪', 'インフルエンザ'], ['体・健康', '花粉症', '食べ物アレルギー'], ['体・健康', '虫歯', '口内炎'],
      ['体・健康', '肩こり', '腰痛'], ['体・健康', '頭痛', '腹痛'], ['体・健康', 'シミ', 'ソバカス'],
      ['体・健康', 'マッサージ', '整体'], ['体・健康', '半身浴', '水風呂'], ['体・健康', '予防接種', '健康診断'],
      ['体・健康', '薬', 'サプリメント'], ['体・健康', '視力検査', '聴力検査'], ['体・健康', 'サウナ', '岩盤浴'],
      ['デジタル', 'デスクトップPC', 'ノートPC'], ['デジタル', 'メール', 'DM'], ['デジタル', '動画サイト', 'SNS'],
      ['デジタル', 'スマホゲーム', 'テレビゲーム'], ['デジタル', 'ブログ', 'ホームページ'], ['デジタル', '電子マネー', 'クレジットカード'],
      ['デジタル', 'パスワード', '指紋認証'], ['デジタル', 'Wi-Fi', 'テザリング'], ['デジタル', 'ワイヤレスイヤホン', 'モバイルバッテリー'],
      ['デジタル', 'イヤホン', 'ヘッドホン'], ['デジタル', '電子書籍', '本'], ['エンタメ', '映画', 'ドラマ'],
      ['エンタメ', 'アニメ', '特撮'], ['エンタメ', '漫画', '小説'], ['エンタメ', '雑誌', '新聞'],
      ['エンタメ', 'ラジオ', 'ポッドキャスト'], ['エンタメ', 'クイズ番組', 'ニュース番組'], ['エンタメ', '漫才', 'コント'],
      ['エンタメ', 'ミュージカル', 'オペラ'], ['エンタメ', '歌舞伎', '宝塚'], ['エンタメ', 'サーカス', 'マジックショー'],
      ['エンタメ', 'ホラー映画', 'アクション映画'], ['エンタメ', 'ミステリー映画', 'ファンタジー映画'], ['エンタメ', 'RPG', 'パズルゲーム'],
      ['エンタメ', '野球観戦', 'サッカー観戦'], ['エンタメ', '落語', '漫談'], ['エンタメ', '人形劇', '紙芝居'],
      ['エンタメ', '料理番組', '旅番組'], ['エンタメ', 'バラエティ番組', 'ドキュメンタリー'], ['食べ物', '味噌ラーメン', '醤油ラーメン'],
      ['食べ物', 'サムギョプサル', 'しゃぶしゃぶ'], ['食べ物', 'すき焼き', '水炊き'], ['食べ物', '明太子', 'たらこ'],
      ['食べ物', 'たくあん', 'キムチ'], ['食べ物', 'わさび', 'からし'], ['食べ物', '醤油', 'ソース'],
      ['食べ物', 'マヨネーズ', 'ケチャップ'], ['食べ物', '塩', '砂糖'], ['食べ物', 'バゲット', 'クロワッサン'],
      ['飲み物', '抹茶', '煎茶'], ['飲み物', 'ミックスジュース', 'トマトジュース'], ['飲み物', 'イチゴミルク', 'バナナミルク'],
      ['飲み物', 'ホットミルク', 'ホットレモン'], ['飲み物', 'ゼリー飲料', 'プロテイン'], ['飲み物', '抹茶ラテ', 'ほうじ茶ラテ'],
      ['場所', '展望台', '屋上'], ['場所', '植物園', '果樹園'], ['場所', 'ネットカフェ', 'カプセルホテル'],
      ['場所', 'ボウリング場', 'バッティングセンター'], ['場所', 'フリーマーケット', 'リサイクルショップ'], ['場所', 'ペットショップ', '動物病院'],
      ['場所', 'チャペル', '結婚式場'], ['場所', '消防署', '警察署'], ['動物', 'ハト', 'ツバメ'],
      ['動物', 'コウモリ', 'モグラ'], ['動物', 'ハリネズミ', 'モルモット'], ['動物', 'アルパカ', 'ラマ'],
      ['動物', 'チーター', 'ヒョウ'], ['動物', 'カバ', 'サイ'], ['動物', 'ペリカン', 'フラミンゴ'],
      ['動物', 'オオカミ', 'ハイエナ'], ['スポーツ', 'カーリング', 'アイスホッケー'], ['スポーツ', 'チアリーディング', 'マーチング'],
      ['スポーツ', '綱引き', '玉入れ'], ['スポーツ', 'リレー', '障害物競走'], ['スポーツ', 'なわとび', 'フラフープ'],
      ['スポーツ', '腕相撲', '指相撲'], ['乗り物', 'トラクター', 'フォークリフト'], ['乗り物', '観覧車', 'ジェットコースター'],
      ['乗り物', 'はしご車', 'クレーン車'], ['乗り物', 'ミキサー車', 'ダンプカー'], ['乗り物', '除雪車', 'ゴミ収集車'],
      ['遊び・趣味', '占い', '心理テスト'], ['遊び・趣味', '切手収集', 'コイン収集'], ['遊び・趣味', 'プログラミング', '動画編集'],
      ['遊び・趣味', '合唱', '吹奏楽'], ['遊び・趣味', 'オセロ', 'チェス'], ['遊び・趣味', 'ドミノ', 'ジェンガ'],
      ['遊び・趣味', 'あやとり', '折り紙'], ['遊び・趣味', 'けん玉', 'こま回し'], ['季節・イベント', '紅白歌合戦', '除夜の鐘'],
      ['季節・イベント', '初売り', '福袋'], ['季節・イベント', 'サンタクロース', 'トナカイ'], ['季節・イベント', '七草粥', 'おせち料理'],
      ['季節・イベント', 'ひなあられ', '柏餅'], ['季節・イベント', '流しそうめん', 'スイカ割り'], ['季節・イベント', '雪だるま', 'かまくら'],
      ['季節・イベント', '忘年会', '新年会'], ['自然・天気', '松', '竹'], ['自然・天気', '島', '半島'],
      ['自然・天気', 'つらら', '霜柱'], ['自然・天気', '朝焼け', '夕焼け'], ['自然・天気', '新月', '半月'],
      ['自然・天気', '夕立', '通り雨'], ['学校', '通知表', '賞状'], ['学校', '日直', '給食当番'],
      ['学校', '休み時間', '放課後'], ['学校', '社会科見学', '工場見学'], ['学校', '転校生', '留学生'],
      ['学校', '職員室', '校長室'], ['学校', 'プール', '体育館'], ['学校', '卒業アルバム', '文集'],
      ['デジタル', 'スマホ', 'タブレット']
    ].map(([category, citizen, wolf]) => ({ category, citizen, wolf }));
    const WW_CFG = {
      // introSeconds＝開始待機（挨拶タイム）の長さ。お題はこの間まだ
      // 出さず、終わって話し合いに入ってから表示する（2026-11-24 おぎ）
      introSeconds: 15, votingSeconds: 15, extensionSeconds: 60,
      reversalSeconds: 30, afterglowSeconds: 15,
      minPlayers: 4, maxPlayers: 8, maxMessageLength: 200,
    };
    const WW_WOLF_COUNT = { 4: 1, 5: 1, 6: 1, 7: 1, 8: 2 };
    const BOT_LINES = [
      'うーん、みんなの話を聞いてると少し分かってきたかも',
      'それ、日常でよくあるやつだよね',
      'わたしはけっこう好きなほうだな〜',
      '頻度でいうと、週に何回くらい？',
      '似たようなものと迷うんだよね、これ',
      '子どものころから身近だった気がする',
      '好みは分かれそうだけど、わたしは肯定派',
      '値段でいうと手頃なイメージがある',
    ];
    const wwState = {
      offsetSec: 0,
      seq: 0,
      rooms: new Map(), // id -> room
      sets: new Map(), // id -> set（1ゲームだけのコンテナ）
      games: new Map(), // id -> game（secret を含む。画面には出さない）
      messages: [], // { id, gameId, senderId, body, at }
      roomMessages: [], // { id, roomId, senderId, kind, body, at }（待機室チャット）
      votes: [], // { gameId, voteRound, voterId, targetId }
      results: [], // { setId, gameId, gameIndex, userId, won, winner, reason }
    };
    const wwNow = () => Date.now() / 1000 + wwState.offsetSec;

    // =================================================================
    // ペナルティ（sim/penalty.mjs ＝ 実 DB の 0010 と同じルールの移植）
    // 定数：離脱系 60/180/360/720/1440分、30日ごとに1段軽減（0には
    // 戻らない）。適用するとシステムDM（kind='system'）で通知する。
    // =================================================================
    const PENALTY_CFG = {
      graceSec: 120, decayDays: 30,
      afk: [60, 180, 360, 720, 1440],
      harassment: [10080, 43200, -1], // 定数のみ（適用経路は処分フェーズ）
    };
    // roomPoints：ルーム滞在中の違反ポイント累積（`${roomId}|${userId}`）。
    // 実 DB の room_members.violation_points に相当し、退室・キック・
    // 強制退室でエントリを消す＝滞在リセットになる
    const penState = { events: [], untilByUser: new Map(), roomPoints: new Map() };
    let rulesAgreed = false;
    try { rulesAgreed = localStorage.getItem('kl_rules_agreed') === '1'; } catch { /* 保存できない環境ではメモリのみ */ }
    const penFormatMinutes = (min) => {
      if (min === -1) return '無期限';
      if (min >= 60 && min % 60 === 0) return `${min / 60}時間`;
      return `${min}分`;
    };
    function penNextStep(userId, track) {
      const applied = penState.events.filter(
        (e) => e.userId === userId && e.track === track && e.minutes !== 0);
      if (!applied.length) return 1;
      const last = applied[applied.length - 1];
      const periods = Math.floor(Math.max(0, wwNow() - last.atSec) / (PENALTY_CFG.decayDays * 86400));
      const level = Math.max(1, last.step - periods);
      return Math.min(level + 1, PENALTY_CFG[track].length);
    }
    function penApply(userId, { kind, setId = null, forcedRemoval = false, reasonText }) {
      const track = 'afk';
      const step = penNextStep(userId, track);
      const minutes = PENALTY_CFG[track][step - 1];
      const nowS = wwNow();
      const prev = penState.untilByUser.get(userId) ?? nowS;
      const until = Math.max(prev, nowS) + minutes * 60;
      penState.untilByUser.set(userId, until);
      penState.events.push({ userId, track, kind, setId, step, minutes, untilSec: until, forcedRemoval, atSec: nowS });
      const remainMin = Math.max(1, Math.round((until - nowS) / 60));
      const body = [
        '【ペナルティのお知らせ】',
        reasonText,
        `ペナルティとして あと約${remainMin}分間 ルームへの参加・作成ができません（今回の制限：${penFormatMinutes(minutes)}）。`,
        'ペナルティの回数が増えると制限時間は長くなります（30日間違反がなければ段階的に軽くなります）。対戦中は最後まで参加しましょう。',
      ].join('\n');
      state.dm.push({ id: 'dm-' + (++state.seq), from: 'system', to: userId, kind: 'system', body, read: false });
      return { step, minutes, untilSec: until };
    }
    function penActiveUntil(userId) {
      const u = penState.untilByUser.get(userId);
      return u != null && u > wwNow() ? u : null;
    }
    function penGuard(userId) {
      const u = penActiveUntil(userId);
      if (u) {
        const remainMin = Math.max(1, Math.ceil((u - wwNow()) / 60));
        throw fail('PENALTY_ACTIVE', `ペナルティ期間中のため、あと約${remainMin}分間はルームに参加・作成できません`);
      }
    }
    // 同意ゲート（実 DB の kl__assert_rules_agreed と同じ）：未同意の
    // ユーザーはルーム作成・参加を RULES_NOT_AGREED で拒否する
    function consentGuard() {
      if (!rulesAgreed) {
        throw fail('RULES_NOT_AGREED', 'ルームに入るにはチュートリアルへの同意が必要です');
      }
    }
    function penInfo(userId) {
      const u = penActiveUntil(userId);
      return u ? u * 1000 : null;
    }
    const wwId = (p) => `${p}-sim-${++wwState.seq}`;
    const shuffled = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    const BOT_POOL = ['u-mika', 'u-ken', 'u-risu', 'u-nyan', 'u-sora', 'u-mochi', 'u-ai'];

    function wwSeedRooms() {
      if (wwState.rooms.size) return;
      D.rooms.forEach((r, i) => {
        const host = [...users.values()].find((u) => u.name === r.hostName);
        const hostId = host?.id ?? 'u-mika';
        const others = BOT_POOL.filter((id) => id !== hostId);
        const memberIds = [hostId, ...others.slice(0, Math.max(0, r.players - 1))];
        wwState.rooms.set(r.id, {
          id: r.id, title: r.title, isPrivate: r.isPrivate,
          password: r.isPrivate ? 'wolf777' : null,
          beginner: r.beginner, capacity: r.capacity, genre: r.genre ?? null,
          status: r.status ?? 'lobby',
          reversalEnabled: r.reversalEnabled !== false, hostId,
          // 一覧の並び順（新しい順）を持たせる。種ルームはダミー順を維持
          seq: 100 - i,
          members: memberIds.map((userId) => ({ userId, ready: userId !== 'me', lastHeartbeatAt: null })),
          currentSetId: null, allReadyAtSec: null,
        });
      });
    }
    wwSeedRooms();

    function wwRoomSummary(room) {
      const host = users.get(room.hostId);
      return {
        id: room.id, title: room.title, isPrivate: room.isPrivate,
        beginner: room.beginner, capacity: room.capacity, genre: room.genre ?? null,
        status: room.status,
        reversalEnabled: room.reversalEnabled, hostId: room.hostId,
        hostName: host?.name ?? '', hostIcon: host?.icon ?? '🐺',
        hostIconKey: host?.iconKey ?? null,
        hostBg: host?.iconBg ?? '#eef4ff',
        players: room.members.length,
        isMember: room.members.some((m) => m.userId === 'me'),
        isHost: room.hostId === 'me',
      };
    }
    // rooms.all_ready_at 相当：満室＋マスター以外の全員が準備OKの間だけ
    // 時刻を保持する（通報判定用の証跡。処分処理は未実装）
    function wwRefreshAllReady(room) {
      const ok = room.status === 'lobby'
        && room.members.length === room.capacity
        && room.members.every((m) => m.userId === room.hostId || m.ready);
      if (ok) {
        if (room.allReadyAtSec == null) room.allReadyAtSec = wwNow();
      } else {
        room.allReadyAtSec = null;
      }
    }
    function wwRoomDetail(room) {
      wwRefreshAllReady(room);
      const detail = {
        ...wwRoomSummary(room),
        // no＝プレイヤー番号（参加順で1〜N。ルーム内固定表示用）
        members: room.members.map((m, i) => ({
          ...pub(users.get(m.userId)), ready: m.ready, isHost: m.userId === room.hostId,
          no: i + 1,
        })),
        allReadyAtMs: room.allReadyAtSec == null ? null : room.allReadyAtSec * 1000,
        // 待機室チャット（直近100件）
        roomMessages: wwState.roomMessages
          .filter((m) => m.roomId === room.id)
          .slice(-100)
          .map((m) => ({
            id: m.id, from: m.senderId, kind: m.kind ?? 'chat', body: m.body, atMs: m.at * 1000,
          })),
        currentGame: null,
      };
      if (room.status === 'playing' && room.currentSetId) {
        const game = wwCurrentGame(room.currentSetId);
        if (game) detail.currentGame = { setId: game.setId, gameId: game.id, phase: game.phase };
      }
      return detail;
    }
    function wwCurrentGame(setId) {
      const games = [...wwState.games.values()].filter((g) => g.setId === setId);
      games.sort((a, b) => b.gameIndex - a.gameIndex);
      return games[0] ?? null;
    }
    function wwGetRoom(roomId) {
      const room = wwState.rooms.get(roomId);
      if (!room) throw fail('ROOM_NOT_FOUND', 'ルームが存在しません');
      return room;
    }
    function wwGetGame(gameId) {
      const game = wwState.games.get(gameId);
      if (!game) throw fail('GAME_NOT_FOUND', 'ゲームが存在しません');
      return game;
    }

    // お題の抽選（実 DB の ww__new_game と同じ規則）：
    // ジャンル指定ルームはそのカテゴリだけ、おまかせは「カテゴリ抽選→
    // そのカテゴリからペア抽選」でゲームごとにジャンルが変わる
    function wwPickPair(room) {
      let pool = WW_TOPICS;
      if (room?.genre) {
        pool = WW_TOPICS.filter((t) => t.category === room.genre);
      } else {
        const cats = [...new Set(WW_TOPICS.map((t) => t.category).filter(Boolean))];
        if (cats.length) {
          const picked = cats[Math.floor(Math.random() * cats.length)];
          pool = WW_TOPICS.filter((t) => t.category === picked);
        }
      }
      if (!pool.length) pool = WW_TOPICS;
      return pool[Math.floor(Math.random() * pool.length)];
    }

    function wwNewGame(set, gameIndex) {
      const pair = wwPickPair(wwState.rooms.get(set.roomId));
      const wolfIds = shuffled(set.playerIds).slice(0, WW_WOLF_COUNT[set.playerIds.length] ?? 1);
      const game = {
        id: wwId('game'), setId: set.id, roomId: set.roomId, gameIndex,
        phase: 'intro', phaseVersion: 0,
        phaseDeadlineAt: wwNow() + WW_CFG.introSeconds,
        playerIds: [...set.playerIds],
        discussionSeconds: set.playerIds.length <= 6 ? 300 : 480,
        voteRound: 1, extended: false, votesCast: 0,
        exiledId: null, winner: null, winReason: null,
        reversalChoices: null, reversalOutcome: null,
        topics: new Map(set.playerIds.map((id) => [id, wolfIds.includes(id) ? pair.wolf : pair.citizen])),
        secret: { citizenTopic: pair.citizen, wolfTopic: pair.wolf, category: pair.category, wolfIds },
      };
      wwState.games.set(game.id, game);
      return game;
    }
    function wwSetPhase(game, phase, deadlineAt) {
      game.phase = phase;
      game.phaseDeadlineAt = deadlineAt;
      game.phaseVersion += 1;
      wwBotEnter(game, phase);
    }
    // ボットの自動行動（フェーズ入場時）。デモを1人でも回すため。
    function wwBotEnter(game, phase) {
      const bots = game.playerIds.filter((id) => id !== 'me');
      if (phase === 'discussion') {
        bots.forEach((botId, i) => {
          const line = BOT_LINES[(game.gameIndex * 3 + game.voteRound + i) % BOT_LINES.length];
          wwState.messages.push({
            id: wwId('msg'), gameId: game.id, senderId: botId, body: line, at: wwNow(),
          });
        });
      } else if (phase === 'voting') {
        for (const botId of bots) {
          if (wwMyVote(game, botId) !== undefined) continue;
          const targets = game.playerIds.filter((id) => id !== botId);
          // ボットは必ず投票する（スルーはペナルティ対象のため、デモの
          // 安定動作として棄権させない。スルー経路は sim/SQL で検証済み）
          const target = targets[Math.floor(Math.random() * targets.length)];
          wwState.votes.push({ gameId: game.id, voteRound: game.voteRound, voterId: botId, targetId: target });
          game.votesCast += 1;
        }
      } else if (phase === 'reversal' && game.exiledId && game.exiledId !== 'me') {
        const choice = game.reversalChoices[Math.floor(Math.random() * game.reversalChoices.length)];
        const correct = choice === game.secret.citizenTopic;
        game.reversalOutcome = { attempted: true, correct, timedOut: false };
        wwFinishGame(game, correct ? 'wolves' : 'citizens', 'reversal');
      }
    }
    function wwMyVote(game, playerId) {
      const row = wwState.votes.find(
        (v) => v.gameId === game.id && v.voteRound === game.voteRound && v.voterId === playerId,
      );
      return row ? row.targetId : undefined;
    }
    // ポイントだけの違反記録（制限なし。段階計算は minutes !== 0 の行だけを見る）
    function penRecordPoint(userId, { kind, points, roomId = null, setId = null }) {
      const ev = {
        userId, track: 'afk', kind, roomId, setId, step: 0, minutes: 0, points,
        untilSec: penActiveUntil(userId) ?? wwNow(), forcedRemoval: false, atSec: wwNow(),
      };
      penState.events.push(ev);
      if (roomId) {
        const key = `${roomId}|${userId}`;
        penState.roomPoints.set(key, (penState.roomPoints.get(key) ?? 0) + points);
      }
      return ev;
    }
    function penPointsInRoom(userId, roomId) {
      return penState.roomPoints.get(`${roomId}|${userId}`) ?? 0;
    }
    function penClearRoomPoints(userId, roomId) {
      penState.roomPoints.delete(`${roomId}|${userId}`);
    }
    /**
     * 違反ポイント制（2026-11-24 おぎ確定）：
     * 発言0＋未投票（投票行為なし）=1.0／発言0＋投票あり=0.5／
     * 発言あり＋未投票・棄権=0.5。ポイントはルーム滞在中に累積し、
     * 合計1.0に達した時点で強制退室＋ペナルティ階段+1
     * （実際の退室と対戦終了は result 終了時に確定）。
     * 1.0未満では制限もDMも発生しない。退室するとリセット。
     * 棄権（null の投票行）は「投票なし」に数えない。
     */
    function wwRecordVoteSkips(game) {
      if (game.skipsRecorded) return;
      game.skipsRecorded = true;
      const set = wwState.sets.get(game.setId);
      for (const pid of game.playerIds) {
        const mine = wwMyVote(game, pid);
        const hasValidVote = mine !== undefined && mine !== null;
        const hasVoteRow = mine !== undefined;
        const msgCount = wwState.messages.filter(
          (m) => m.gameId === game.id && m.senderId === pid && (m.kind ?? 'chat') === 'chat',
        ).length;
        let points = 0;
        let kind = null;
        if (hasValidVote) {
          if (msgCount > 0) continue;
          points = 0.5; kind = 'silent_play';
        } else if (msgCount === 0 && !hasVoteRow) {
          points = 1.0; kind = 'silent_no_vote';
        } else {
          points = 0.5; kind = 'vote_skip';
        }
        penRecordPoint(pid, { kind, points, roomId: game.roomId, setId: game.setId });
        if (penPointsInRoom(pid, game.roomId) < 1.0) continue;
        penApply(pid, {
          kind, setId: game.setId, forcedRemoval: true,
          reasonText: kind === 'silent_no_vote'
            ? '対戦中に発言も投票もなかったため、強制退室となりました。'
            : '対戦中の違反ポイントが上限（1.0）に達したため、強制退室となりました。',
        });
        if (set && !set.terminateAfterGame.includes(pid)) {
          set.terminateAfterGame.push(pid);
        }
      }
    }
    // 対戦の強制終了：退室＋システムログ（完了ゲームの結果は保持）。
    // 残ったメンバーの準備OKはリセットし、退室者の滞在ポイントも消える
    function wwTerminateSet(set, userIds, logGame) {
      set.status = 'terminated';
      set.terminatedUserIds = [...userIds];
      set.terminateAfterGame = [];
      const room = wwState.rooms.get(set.roomId);
      if (room) {
        room.status = 'lobby';
        room.currentSetId = null;
        room.allReadyAtSec = null;
        room.members = room.members.filter((m) => !userIds.includes(m.userId));
        for (const m of room.members) m.ready = false;
        // マスター本人が対象なら最古参の残存メンバーへ移譲する
        if (userIds.includes(room.hostId) && room.members.length > 0) {
          room.hostId = room.members[0].userId;
        }
      }
      for (const uid of userIds) {
        penClearRoomPoints(uid, set.roomId);
        const name = users.get(uid)?.name ?? 'プレイヤー';
        wwState.messages.push({
          id: wwId('msg'), gameId: logGame.id, senderId: null, kind: 'system',
          body: `${name}さんがゲームルールに違反したため、強制退室となりました`, at: wwNow(),
        });
      }
      wwState.messages.push({
        id: wwId('msg'), gameId: logGame.id, senderId: null, kind: 'system',
        body: '対戦は終了しました。完了したゲームの勝敗は記録されています。', at: wwNow(),
      });
    }
    // 離脱検知：ハートビート途絶→猶予2分→離脱確定→セット即時強制終了。
    // ボットは常時接続として扱い、ハートビートを自動更新する。
    function wwDetectAbandons() {
      for (const set of [...wwState.sets.values()]) {
        if (set.status !== 'running') continue;
        const game = wwCurrentGame(set.id);
        if (!game || game.phase === 'done') continue;
        const room = wwState.rooms.get(set.roomId);
        if (!room) continue;
        for (const m of room.members) {
          if (m.userId !== 'me') m.lastHeartbeatAt = wwNow();
        }
        if (!room.members.some((m) => m.lastHeartbeatAt != null)) continue;
        const stale = set.playerIds.filter((pid) => {
          const m = room.members.find((x) => x.userId === pid);
          const hb = m?.lastHeartbeatAt ?? set.createdAtSec;
          return wwNow() - hb > PENALTY_CFG.graceSec;
        });
        if (!stale.length) continue;
        for (const uid of stale) {
          penApply(uid, {
            kind: 'abandon', setId: set.id, forcedRemoval: true,
            reasonText: '対戦中に接続が切れたまま復帰がなかったため、離脱と判定されました。',
          });
        }
        if (game.phase !== 'result') { game.winner = null; game.winReason = 'aborted'; }
        game.phase = 'done';
        game.phaseVersion += 1;
        game.phaseDeadlineAt = null;
        wwTerminateSet(set, stale, game);
      }
    }
    function wwFinishGame(game, winner, reason) {
      game.winner = winner;
      game.winReason = reason;
      for (const pid of game.playerIds) {
        const isWolf = game.secret.wolfIds.includes(pid);
        const won = winner === 'wolves' ? isWolf : !isWolf;
        wwState.results.push({
          setId: game.setId, gameId: game.id, gameIndex: game.gameIndex,
          userId: pid, won, winner, reason,
        });
      }
      wwSetPhase(game, 'result', wwNow() + WW_CFG.afterglowSeconds);
    }
    function wwResolveVote(game) {
      const tally = new Map();
      for (const v of wwState.votes) {
        if (v.gameId !== game.id || v.voteRound !== game.voteRound) continue;
        if (v.targetId == null) continue;
        tally.set(v.targetId, (tally.get(v.targetId) ?? 0) + 1);
      }
      if (tally.size === 0) {
        game.exiledId = null;
        wwRecordVoteSkips(game);
        wwFinishGame(game, 'wolves', 'no_votes');
        return;
      }
      const max = Math.max(...tally.values());
      const top = [...tally.entries()].filter(([, c]) => c === max).map(([id]) => id);
      if (top.length > 1) {
        if (!game.extended) {
          game.extended = true;
          game.voteRound = 2;
          game.votesCast = 0;
          wwSetPhase(game, 'discussion', wwNow() + WW_CFG.extensionSeconds);
        } else {
          game.exiledId = null;
          wwRecordVoteSkips(game);
          wwFinishGame(game, 'wolves', 'tie');
        }
        return;
      }
      game.exiledId = top[0];
      wwRecordVoteSkips(game);
      const room = wwState.rooms.get(game.roomId);
      if (game.secret.wolfIds.includes(game.exiledId)) {
        if (room.reversalEnabled) {
          game.reversalChoices = wwBuildReversalChoices(game);
          wwSetPhase(game, 'reversal', wwNow() + WW_CFG.reversalSeconds);
        } else {
          wwFinishGame(game, 'citizens', 'wolf_exiled');
        }
      } else {
        wwFinishGame(game, 'wolves', 'citizen_exiled');
      }
    }
    function wwBuildReversalChoices(game) {
      const { citizenTopic, wolfTopic, category } = game.secret;
      const seen = new Set([citizenTopic, wolfTopic]);
      const same = [];
      const other = [];
      for (const pair of WW_TOPICS) {
        if (pair.citizen === citizenTopic && pair.wolf === wolfTopic) continue;
        const bucket = pair.category === category ? same : other;
        for (const t of [pair.citizen, pair.wolf]) {
          if (seen.has(t)) continue;
          seen.add(t);
          bucket.push(t);
        }
      }
      const dummies = shuffled(same).slice(0, 5);
      if (dummies.length < 5) dummies.push(...shuffled(other).slice(0, 5 - dummies.length));
      return shuffled([citizenTopic, ...dummies]);
    }
    function wwAdvanceExpired(game) {
      switch (game.phase) {
        case 'intro':
          wwSetPhase(game, 'discussion', wwNow() + game.discussionSeconds);
          break;
        case 'discussion':
          game.votesCast = 0;
          wwSetPhase(game, 'voting', wwNow() + WW_CFG.votingSeconds);
          break;
        case 'voting':
          wwResolveVote(game);
          break;
        case 'reversal':
          game.reversalOutcome = { attempted: false, correct: false, timedOut: true };
          wwFinishGame(game, 'citizens', 'reversal');
          break;
        case 'result': {
          // ゲーム単位制：次ゲームは作らず、全員いったん待機室に戻る
          const set = wwState.sets.get(game.setId);
          game.phase = 'done';
          game.phaseVersion += 1;
          game.phaseDeadlineAt = null;
          if (set.terminateAfterGame.length > 0) {
            wwTerminateSet(set, set.terminateAfterGame, game);
          } else {
            set.status = 'finished';
            const room = wwState.rooms.get(set.roomId);
            room.status = 'lobby';
            room.currentSetId = null;
            room.allReadyAtSec = null;
            for (const m of room.members) m.ready = false;
          }
          break;
        }
        default:
          break;
      }
    }
    // 読み取り系メソッドの入口で行う見回り（ww_sweep＋ボットホスト
    // 自動開始の相当）。アクション系では呼ばない（締め切り判定を
    // そのまま見るため）。
    function wwHousekeep() {
      wwDetectAbandons();
      for (const game of [...wwState.games.values()]) {
        if (game.phase !== 'done' && game.phaseDeadlineAt != null && wwNow() >= game.phaseDeadlineAt) {
          wwAdvanceExpired(game);
        }
      }
      for (const room of wwState.rooms.values()) {
        if (room.status !== 'lobby') continue;
        // デモ用：ボットは待機室では常時準備OK（実環境では実ユーザーが押す）
        for (const m of room.members) {
          if (m.userId !== 'me') m.ready = true;
        }
        wwRefreshAllReady(room);
        // デモ用：ボットがマスターの部屋は、満室＋全員準備OKがそろえば
        // マスターが「ゲームスタート！」を押したものとして開始する
        if (room.hostId !== 'me'
          && room.members.some((m) => m.userId === 'me')
          && room.members.length === room.capacity
          && room.members.every((m) => m.userId === room.hostId || m.ready)) {
          try { wwStartGameNow(room); } catch { /* 条件を満たさない場合は待機継続 */ }
        }
      }
    }
    // ゲーム開始の本体（実 DB の ww__start_game_now 相当）。
    // 開始条件＝満室＋マスター以外の全員が準備OK
    function wwStartGameNow(room) {
      if (room.status !== 'lobby') throw fail('ROOM_BUSY', 'すでに進行中です');
      const memberIds = room.members.map((m) => m.userId);
      if (memberIds.length !== room.capacity) {
        throw fail('ROOM_NOT_FULL', `満室にならないと開始できません（現在 ${memberIds.length} / ${room.capacity}人）`);
      }
      if (room.members.some((m) => m.userId !== room.hostId && !m.ready)) {
        throw fail('NOT_ALL_READY', '全員が準備OKを押さないと開始できません');
      }
      const set = {
        id: wwId('set'), roomId: room.id, status: 'running',
        gamesPerSet: 1, playerIds: memberIds,
        createdAtSec: wwNow(), terminateAfterGame: [], terminatedUserIds: null,
      };
      wwState.sets.set(set.id, set);
      room.status = 'playing';
      room.currentSetId = set.id;
      room.allReadyAtSec = null;
      const game = wwNewGame(set, 1);
      return { setId: set.id, gameId: game.id };
    }
    function wwRequireWindow(game, phases) {
      if (!phases.includes(game.phase)) {
        throw fail('INVALID_PHASE', `現在のフェーズでは実行できません`);
      }
      if (wwNow() >= game.phaseDeadlineAt) {
        throw fail('DEADLINE_PASSED', '締め切りを過ぎています');
      }
    }
    function wwGameView(game, playerId) {
      const finished = game.phase === 'result' || game.phase === 'done';
      const set = wwState.sets.get(game.setId);
      const view = {
        gameId: game.id, setId: game.setId, roomId: game.roomId,
        gameIndex: game.gameIndex, gamesPerSet: set.gamesPerSet,
        setStatus: set.status,
        terminatedUserIds: set.terminatedUserIds ?? null,
        phase: game.phase, phaseVersion: game.phaseVersion,
        phaseDeadlineMs: game.phaseDeadlineAt == null ? null : game.phaseDeadlineAt * 1000,
        // サーバー時刻基準の残り秒数と自分の発言数（無発言警告の判定用）
        phaseRemainSec: game.phaseDeadlineAt == null
          ? null : Math.max(0, Math.ceil(game.phaseDeadlineAt - wwNow())),
        myMessageCount: wwState.messages.filter(
          (m) => m.gameId === game.id && m.senderId === playerId && (m.kind ?? 'chat') === 'chat',
        ).length,
        // no＝プレイヤー番号（セット開始時の参加順で固定。セット中不変）
        players: game.playerIds.map((id, i) => ({ ...pub(users.get(id)), no: i + 1 })),
        // ジャンル（カテゴリ）は全員に公開（挨拶タイム中も出す）
        category: game.secret.category,
        // 挨拶タイム（intro）中はお題をまだ渡さない（出現は話し合いから）
        myTopic: game.phase === 'intro' ? null : game.topics.get(playerId),
        myVote: wwMyVote(game, playerId),
        votesCast: game.votesCast, playerCount: game.playerIds.length,
        voteRound: game.voteRound, extended: game.extended,
        exiledId: finished || game.phase === 'reversal' ? game.exiledId : null,
        winner: finished ? game.winner : null,
        winReason: finished ? game.winReason : null,
        reversalChoices: null, topicPair: null, reversalOutcome: null, reveal: null,
        messages: wwState.messages
          .filter((m) => m.gameId === game.id)
          .map((m) => ({ id: m.id, from: m.senderId, kind: m.kind ?? 'chat', body: m.body, atMs: m.at * 1000 })),
      };
      if (game.phase === 'reversal' && playerId === game.exiledId) {
        view.reversalChoices = [...(game.reversalChoices ?? [])];
      }
      if (finished) {
        view.topicPair = { citizen: game.secret.citizenTopic, wolf: game.secret.wolfTopic };
        view.reversalOutcome = game.reversalOutcome;
        view.reveal = game.playerIds.map((id) => ({
          id, isWolf: game.secret.wolfIds.includes(id), topic: game.topics.get(id),
          won: wwState.results.some(
            (r) => r.gameId === game.id && r.userId === id && r.won,
          ),
        }));
      }
      return view;
    }

    return {
      mode: 'sim',
      bootstrap() {
        return ok({
          me: {
            ...pub(users.get('me')), coins: state.coins, bonusClaimed: state.bonusClaimed,
            penaltyUntilMs: penInfo('me'), rulesAgreed,
          },
          rooms: D.rooms.slice(),
        });
      },
      getMe() {
        return ok({
          ...pub(users.get('me')), coins: state.coins, bonusClaimed: state.bonusClaimed,
          penaltyUntilMs: penInfo('me'), rulesAgreed,
        });
      },
      getRulesAgreed() {
        return ok(rulesAgreed);
      },
      agreeRules() {
        rulesAgreed = true;
        try { localStorage.setItem('kl_rules_agreed', '1'); } catch { /* メモリのみ */ }
        return ok(true);
      },
      heartbeat(roomId) {
        const room = wwState.rooms.get(roomId);
        const mine = room?.members.find((m) => m.userId === 'me');
        if (mine) mine.lastHeartbeatAt = wwNow();
        return ok(null);
      },
      claimLoginBonus() {
        if (state.bonusClaimed) return ok({ claimed: false, amount: 0, coins: state.coins });
        state.bonusClaimed = true;
        state.coins += 10;
        return ok({ claimed: true, amount: 10, coins: state.coins });
      },
      listOnlineFriends() {
        return ok([...state.friends].map((id) => pub(users.get(id))).filter((u) => u.online));
      },
      listFriends() {
        return ok([...state.friends].map((id) => pub(users.get(id))));
      },
      listIncomingRequests() {
        return ok([...state.incoming].map((id) => pub(users.get(id))));
      },
      listOutgoingRequests() {
        return ok([...state.outgoing].map((id) => pub(users.get(id))));
      },
      searchUser(publicId) {
        const needle = String(publicId ?? '').trim().toLowerCase();
        for (const u of users.values()) {
          if (u.publicId.toLowerCase() !== needle) continue;
          if (u.id === 'me' || u.id === 'system' || state.blocked.has(u.id)) return ok(null);
          let relation = 'none';
          if (state.friends.has(u.id)) relation = 'friend';
          else if (state.outgoing.has(u.id)) relation = 'requested_out';
          else if (state.incoming.has(u.id)) relation = 'requested_in';
          return ok({ ...pub(u), relation });
        }
        return ok(null);
      },
      sendFriendRequest(userId) {
        if (state.friends.has(userId)) return Promise.reject(fail('ALREADY_FRIENDS', 'すでにフレンドです'));
        if (state.outgoing.has(userId)) return Promise.reject(fail('ALREADY_REQUESTED', 'すでに申請中です'));
        if (state.incoming.has(userId)) {
          state.incoming.delete(userId);
          state.friends.add(userId);
          return ok('accepted');
        }
        state.outgoing.add(userId);
        return ok('requested');
      },
      respondFriendRequest(userId, accept) {
        if (!state.incoming.has(userId)) return Promise.reject(fail('REQUEST_NOT_FOUND', '申請が存在しません'));
        state.incoming.delete(userId);
        if (accept) state.friends.add(userId);
        return ok(accept ? 'accepted' : 'rejected');
      },
      removeFriend(userId) {
        state.friends.delete(userId);
        return ok(null);
      },
      blockUser(userId) {
        state.friends.delete(userId);
        state.incoming.delete(userId);
        state.outgoing.delete(userId);
        state.blocked.add(userId);
        return ok(null);
      },
      unblockUser(userId) {
        state.blocked.delete(userId);
        return ok(null);
      },
      listBlocked() {
        return ok([...state.blocked].map((id) => pub(users.get(id))));
      },
      listConversations() {
        const byPartner = new Map();
        for (const m of state.dm) {
          const partner = m.from === 'me' ? m.to : m.to === 'me' ? m.from : null;
          if (!partner) continue;
          const cur = byPartner.get(partner) ?? { partnerId: partner, last: null, unread: 0 };
          cur.last = m;
          if (m.to === 'me' && !m.read) cur.unread += 1;
          byPartner.set(partner, cur);
        }
        return ok([...byPartner.values()].map((c) => ({ ...c, partner: pub(users.get(c.partnerId)) })));
      },
      listMessages(userId) {
        return ok(state.dm.filter(
          (m) => (m.from === 'me' && m.to === userId) || (m.from === userId && m.to === 'me'),
        ));
      },
      sendMessage(userId, bodyRaw) {
        if (userId === 'system') return Promise.reject(fail('SYSTEM_READ_ONLY', 'システムからのお知らせには返信できません'));
        if (state.blocked.has(userId)) return Promise.reject(fail('BLOCKED', 'このユーザーには送れません'));
        if (!state.friends.has(userId)) return Promise.reject(fail('NOT_FRIENDS', 'DM はフレンド同士でのみ送れます'));
        const body = String(bodyRaw ?? '').trim();
        if (!body) return Promise.reject(fail('EMPTY_MESSAGE', '本文が空です'));
        if (body.length > 500) return Promise.reject(fail('MESSAGE_TOO_LONG', '500文字以内で入力してください'));
        if (/https?:\/\/|www\./i.test(body)) return Promise.reject(fail('URL_NOT_ALLOWED', 'DM ではリンクを送れません'));
        const msg = { id: 'dm-' + (++state.seq), from: 'me', to: userId, kind: 'text', body, read: true };
        state.dm.push(msg);
        return ok(msg);
      },
      markRead(userId) {
        let n = 0;
        for (const m of state.dm) {
          if (m.from === userId && m.to === 'me' && !m.read) { m.read = true; n += 1; }
        }
        return ok(n);
      },
      giftCatalog() {
        return ok(GIFT_CATALOG.slice());
      },
      myGiftSummary() {
        return ok(giftSummaryOf(D.myGifts ?? []));
      },
      userProfile(userId) {
        const u = users.get(userId);
        if (!u) return Promise.reject(fail('USER_NOT_FOUND', 'ユーザーが存在しません'));
        return ok({
          bio: u.bio ?? '',
          popularity: u.popularity ?? 0,
          wordwolfWins: u.wordwolfWins ?? 0,
          gifts: giftSummaryOf(friendGiftsOf(userId)),
        });
      },
      tickerFeed() {
        return ok((state.ticker ?? []).slice(0, 8));
      },
      sendGift(userId, giftKey) {
        const gift = GIFT_CATALOG.find((g) => g.key === giftKey);
        if (!gift) return Promise.reject(fail('GIFT_NOT_FOUND', 'ギフトが存在しません'));
        if (state.blocked.has(userId)) return Promise.reject(fail('BLOCKED', 'このユーザーには送れません'));
        if (state.coins < gift.price) return Promise.reject(fail('INSUFFICIENT_COINS', 'コインが足りません'));
        state.coins -= gift.price;
        const target = users.get(userId);
        target.popularity += gift.price;
        // 相手の「もらったギフト」にも即時反映する
        const fg = friendGiftsOf(userId);
        const fgRow = fg.find((r) => r.giftKey === gift.key);
        if (fgRow) fgRow.count += 1;
        else fg.push({ giftKey: gift.key, count: 1 });
        const msg = {
          id: 'dm-' + (++state.seq), from: 'me', to: userId, kind: 'gift',
          gift: { giftKey: gift.key, name: gift.name, icon: gift.icon, price: gift.price },
          read: true,
        };
        state.dm.push(msg);
        // 最高額ギフトは全体ティッカー行き（実DBの kl_send_gift フックと同仕様）
        const maxPrice = Math.max(...GIFT_CATALOG.map((g) => g.price));
        if (gift.price >= maxPrice) {
          state.ticker = state.ticker ?? [];
          state.ticker.unshift({
            id: ++state.tickerSeq || (state.tickerSeq = 1),
            text: `🎁 ${users.get('me').name}さんが${target.name}さんに『${gift.name}』をプレゼントしました！`,
          });
        }
        return ok({ coins: state.coins, receiverPopularity: target.popularity, message: msg });
      },
      // ---------- アイコン（0017 の kl_set_icon と同じ判定） ----------
      listIcons() {
        const mine = users.get('me');
        const wins = mine.wordwolfWins ?? 0;
        return ok(ICON_CATALOG.map((c) => ({
          ...c,
          owned: c.tier === 'free' || (c.tier === 'win' && wins >= (c.winThreshold ?? 0)),
          selected: mine.iconKey === c.key,
        })));
      },
      updateBio(bio) {
        const v = String(bio ?? '').trim();
        if ([...v].length > 50) {
          return Promise.reject(fail('BIO_TOO_LONG', '自己紹介は50文字までです'));
        }
        users.get('me').bio = v;
        return ok({ bio: v });
      },
      updateName(name) {
        const v = String(name ?? '').trim();
        if (!v) return Promise.reject(fail('NAME_EMPTY', '名前を入力してください'));
        if ([...v].length > 9) {
          return Promise.reject(fail('NAME_TOO_LONG', '名前は9文字までです'));
        }
        if (!/[ぁ-んァ-ヶ一-龥a-zA-Z0-9]/.test(v)) {
          return Promise.reject(fail('NAME_SYMBOL_ONLY', '名前には文字や数字を1文字以上入れてください'));
        }
        const me = users.get('me');
        me.name = v;
        me.nameDecidedAt = new Date().toISOString();
        return ok({ displayName: v });
      },
      setIcon(key) {
        const cat = ICON_CATALOG.find((c) => c.key === key);
        if (!cat) return Promise.reject(fail('ICON_NOT_FOUND', 'そのアイコンは存在しません'));
        if (cat.tier === 'win') {
          const wins = users.get('me').wordwolfWins ?? 0;
          if (wins < (cat.winThreshold ?? 0)) {
            return Promise.reject(fail('ICON_NOT_OWNED', 'そのアイコンはまだ持っていません'));
          }
        } else if (cat.tier !== 'free') {
          return Promise.reject(fail('ICON_NOT_OWNED', 'そのアイコンはまだ持っていません'));
        }
        users.get('me').iconKey = key;
        try { localStorage.setItem('kl_icon_key', key); } catch { /* メモリのみ */ }
        return ok({ iconKey: key });
      },
      // ---------- DM招待カードの発行（0017 の kl_send_invite と同じ判定） ----------
      sendInvite(userId, roomId, password) {
        if (userId === 'me') return Promise.reject(fail('SELF_ACTION', '自分には送れません'));
        if (!users.has(userId) || userId === 'system') {
          return Promise.reject(fail('USER_NOT_FOUND', 'ユーザーが存在しません'));
        }
        if (state.blocked.has(userId)) return Promise.reject(fail('BLOCKED', 'このユーザーには送れません'));
        if (!state.friends.has(userId)) {
          return Promise.reject(fail('NOT_FRIENDS', '招待はフレンドにのみ送れます'));
        }
        const room = wwState.rooms.get(roomId);
        if (!room) return Promise.reject(fail('ROOM_NOT_FOUND', 'ルームが存在しません'));
        if (room.status !== 'lobby') {
          return Promise.reject(fail('ROOM_BUSY', 'このルームには今は招待できません'));
        }
        if (!room.members.some((m) => m.userId === 'me')) {
          return Promise.reject(fail('NOT_A_MEMBER', '招待できるのはルームのメンバーだけです'));
        }
        if (room.isPrivate && room.password !== (password ?? null)) {
          return Promise.reject(fail('WRONG_PASSWORD', 'パスワードが違います'));
        }
        const msg = {
          id: 'dm-' + (++state.seq), from: 'me', to: userId, kind: 'invite',
          invite: {
            roomId: room.id, roomTitle: room.title,
            password: room.isPrivate ? room.password : null,
          },
          read: true,
        };
        state.dm.push(msg);
        return ok(msg);
      },
      // ローカル専用：非公開ルーム作成料などの消費（残高の単一管理のため）
      spendCoins(amount) {
        if (state.coins < amount) return Promise.reject(fail('INSUFFICIENT_COINS', 'コインが足りません'));
        state.coins -= amount;
        return ok(state.coins);
      },
      addCoins(amount) {
        state.coins += amount;
        return ok(state.coins);
      },

      // ---------- ワードウルフ／ルーム ----------
      listGenres() {
        return ok([...WW_GENRE_LIST]);
      },
      listRooms() {
        wwHousekeep();
        return ok([...wwState.rooms.values()]
          .sort((a, b) => b.seq - a.seq).map(wwRoomSummary));
      },
      createRoom(opts) {
        try { penGuard('me'); consentGuard(); } catch (e) { return Promise.reject(e); }
        const isPrivate = !!opts.isPrivate;
        if (isPrivate && state.coins < 100) {
          return Promise.reject(fail('INSUFFICIENT_COINS', 'コインが足りません'));
        }
        if (isPrivate && (!opts.password || opts.password.length < 4)) {
          return Promise.reject(fail('PASSWORD_REQUIRED', '非公開ルームには4文字以上のパスワードが必要です'));
        }
        if (opts.title && [...opts.title.trim()].length > 10) {
          return Promise.reject(fail('TITLE_TOO_LONG', 'ルーム名は10文字までです'));
        }
        if (isPrivate) state.coins -= 100;
        const capacity = Math.min(8, Math.max(4, opts.capacity ?? 4));
        // ジャンルは固定リストにあるものだけ許可（実 DB の検証と同じ）
        const genre = opts.genre && WW_GENRE_LIST.includes(opts.genre) ? opts.genre : null;
        const room = {
          id: wwId('room'),
          title: opts.title || 'タイトル未設定の部屋',
          isPrivate, password: isPrivate ? opts.password : null,
          beginner: !!opts.beginner, capacity, genre, status: 'lobby',
          reversalEnabled: opts.reversalEnabled !== false,
          hostId: 'me',
          seq: 1000 + ++wwState.seq,
          members: [{ userId: 'me', ready: false, lastHeartbeatAt: null }],
          currentSetId: null, allReadyAtSec: null,
        };
        // デモ用：ボットが満室まで自動参加する（実環境では実ユーザーが入る）
        for (const botId of BOT_POOL) {
          if (room.members.length >= capacity) break;
          room.members.push({ userId: botId, ready: true, lastHeartbeatAt: null });
        }
        wwState.rooms.set(room.id, room);
        return ok({ room: wwRoomDetail(room), coins: state.coins });
      },
      getRoom(roomId) {
        wwHousekeep();
        try {
          return ok(wwRoomDetail(wwGetRoom(roomId)));
        } catch (e) { return Promise.reject(e); }
      },
      joinRoom(roomId, password) {
        wwHousekeep();
        try { penGuard('me'); consentGuard(); } catch (e) { return Promise.reject(e); }
        const room = wwState.rooms.get(roomId);
        if (!room) return Promise.reject(fail('ROOM_NOT_FOUND', 'ルームが存在しません'));
        if (room.status !== 'lobby') return Promise.reject(fail('ROOM_BUSY', 'このルームには今は入れません'));
        if (room.isPrivate && room.hostId !== 'me'
          && !room.members.some((m) => m.userId === 'me')
          && room.password !== (password ?? null)) {
          return Promise.reject(fail('WRONG_PASSWORD', 'パスワードが違います'));
        }
        if (!room.members.some((m) => m.userId === 'me')) {
          if (room.members.length >= room.capacity) {
            return Promise.reject(fail('ROOM_FULL', 'ルームが満員です'));
          }
          room.members.push({ userId: 'me', ready: false, lastHeartbeatAt: null });
        }
        return ok(wwRoomDetail(room));
      },
      leaveRoom(roomId) {
        const room = wwState.rooms.get(roomId);
        if (room) {
          room.members = room.members.filter((m) => m.userId !== 'me');
          penClearRoomPoints('me', roomId);
          // マスターが退室したら最古参のメンバーへ移譲（実 DB と同じ）
          if (room.hostId === 'me') {
            if (room.members.length > 0) {
              room.hostId = room.members[0].userId;
            } else {
              // 誰も残らなければルームを畳む（デモ用。実 DB では closed）
              wwState.rooms.delete(roomId);
            }
          }
          if (wwState.rooms.has(roomId)) wwRefreshAllReady(room);
        }
        return ok(null);
      },
      setReady(roomId, ready) {
        const room = wwState.rooms.get(roomId);
        const mine = room?.members.find((m) => m.userId === 'me');
        if (!mine) return Promise.reject(fail('NOT_A_MEMBER', 'このルームに参加していません'));
        mine.ready = !!ready;
        wwRefreshAllReady(room);
        return ok(null);
      },
      // キック（マスターのみ・待機室のみ）
      kickMember(roomId, targetId) {
        const room = wwState.rooms.get(roomId);
        if (!room) return Promise.reject(fail('ROOM_NOT_FOUND', 'ルームが存在しません'));
        if (room.hostId !== 'me') {
          return Promise.reject(fail('NOT_HOST', 'キックできるのはルームマスターだけです'));
        }
        if (room.status !== 'lobby') {
          return Promise.reject(fail('ROOM_BUSY', 'キックは待機室でのみできます'));
        }
        if (targetId === room.hostId) {
          return Promise.reject(fail('INVALID_TARGET', 'マスターはキックできません'));
        }
        if (!room.members.some((m) => m.userId === targetId)) {
          return Promise.reject(fail('NOT_A_MEMBER', '対象はこのルームのメンバーではありません'));
        }
        room.members = room.members.filter((m) => m.userId !== targetId);
        penClearRoomPoints(targetId, roomId);
        wwRefreshAllReady(room);
        return ok(null);
      },
      // 待機室チャットへの投稿
      postRoomMessage(roomId, bodyRaw) {
        const room = wwState.rooms.get(roomId);
        if (!room) return Promise.reject(fail('ROOM_NOT_FOUND', 'ルームが存在しません'));
        if (!room.members.some((m) => m.userId === 'me')) {
          return Promise.reject(fail('NOT_A_MEMBER', 'このルームに参加していません'));
        }
        const body = String(bodyRaw ?? '');
        if (!body.trim()) return Promise.reject(fail('EMPTY_MESSAGE', '本文が空です'));
        if (body.length > WW_CFG.maxMessageLength) {
          return Promise.reject(fail('MESSAGE_TOO_LONG', '文字数上限を超えています'));
        }
        const msg = {
          id: wwId('rmsg'), roomId, senderId: 'me', kind: 'chat', body, at: wwNow(),
        };
        wwState.roomMessages.push(msg);
        return ok({ id: msg.id, from: 'me', kind: 'chat', body, atMs: msg.at * 1000 });
      },
      startGame(roomId) {
        const room = wwState.rooms.get(roomId);
        if (!room) return Promise.reject(fail('ROOM_NOT_FOUND', 'ルームが存在しません'));
        if (room.hostId !== 'me') {
          return Promise.reject(fail('NOT_HOST', '開始できるのはルームマスターだけです'));
        }
        try {
          return ok(wwStartGameNow(room));
        } catch (e) { return Promise.reject(e); }
      },
      getGameView(gameId) {
        wwHousekeep();
        const game = wwState.games.get(gameId);
        if (!game) return Promise.reject(fail('GAME_NOT_FOUND', 'ゲームが存在しません'));
        if (!game.playerIds.includes('me')) {
          return Promise.reject(fail('NOT_A_PLAYER', 'このゲームの参加者ではありません'));
        }
        return ok(wwGameView(game, 'me'));
      },
      postGameMessage(gameId, bodyRaw) {
        const game = wwState.games.get(gameId);
        if (!game) return Promise.reject(fail('GAME_NOT_FOUND', 'ゲームが存在しません'));
        if (!game.playerIds.includes('me')) {
          return Promise.reject(fail('NOT_A_PLAYER', 'このゲームの参加者ではありません'));
        }
        try {
          wwRequireWindow(game, ['intro', 'discussion']);
          const body = String(bodyRaw ?? '');
          if (!body.trim()) throw fail('EMPTY_MESSAGE', '本文が空です');
          if (body.length > WW_CFG.maxMessageLength) throw fail('MESSAGE_TOO_LONG', '文字数上限を超えています');
          const msg = { id: wwId('msg'), gameId, senderId: 'me', body, at: wwNow() };
          wwState.messages.push(msg);
          return ok({ id: msg.id, from: 'me', body, atMs: msg.at * 1000 });
        } catch (e) { return Promise.reject(e); }
      },
      castVote(gameId, targetId) {
        const game = wwState.games.get(gameId);
        if (!game) return Promise.reject(fail('GAME_NOT_FOUND', 'ゲームが存在しません'));
        if (!game.playerIds.includes('me')) {
          return Promise.reject(fail('NOT_A_PLAYER', 'このゲームの参加者ではありません'));
        }
        try {
          wwRequireWindow(game, ['voting']);
          if (wwMyVote(game, 'me') !== undefined) throw fail('ALREADY_SUBMITTED', 'すでに投票済みです');
          if (targetId != null) {
            if (!game.playerIds.includes(targetId)) throw fail('UNKNOWN_PLAYER', '投票先が存在しません');
            if (targetId === 'me') throw fail('INVALID_TARGET', '自分には投票できません');
          }
          wwState.votes.push({ gameId, voteRound: game.voteRound, voterId: 'me', targetId: targetId ?? null });
          game.votesCast += 1;
          return ok({ votesCast: game.votesCast });
        } catch (e) { return Promise.reject(e); }
      },
      submitReversal(gameId, choice) {
        const game = wwState.games.get(gameId);
        if (!game) return Promise.reject(fail('GAME_NOT_FOUND', 'ゲームが存在しません'));
        try {
          wwRequireWindow(game, ['reversal']);
          if (game.exiledId !== 'me') throw fail('NOT_EXILED_WOLF', '逆転回答ができるのは追放されたウルフだけです');
          if (!game.reversalChoices?.includes(choice)) throw fail('INVALID_CHOICE', '候補の中から選んでください');
          const correct = choice === game.secret.citizenTopic;
          game.reversalOutcome = { attempted: true, correct, timedOut: false };
          wwFinishGame(game, correct ? 'wolves' : 'citizens', 'reversal');
          return ok({ correct });
        } catch (e) { return Promise.reject(e); }
      },
      advanceGame(gameId, expectedVersion) {
        const game = wwState.games.get(gameId);
        if (!game) return Promise.reject(fail('GAME_NOT_FOUND', 'ゲームが存在しません'));
        if (game.phase === 'done' || game.phaseVersion !== expectedVersion) {
          return ok({ advanced: false, reason: 'already_advanced', phase: game.phase, phaseVersion: game.phaseVersion });
        }
        if (game.phase === 'voting'
          && game.playerIds.every((id) => wwMyVote(game, id) !== undefined)) {
          wwResolveVote(game);
          return ok({ advanced: true, early: true, phase: game.phase, phaseVersion: game.phaseVersion });
        }
        if (wwNow() < game.phaseDeadlineAt) {
          return ok({ advanced: false, reason: 'not_yet', phase: game.phase, phaseVersion: game.phaseVersion });
        }
        wwAdvanceExpired(game);
        return ok({ advanced: true, early: false, phase: game.phase, phaseVersion: game.phaseVersion });
      },
      getSetResults(setId) {
        return ok(wwState.results
          .filter((r) => r.setId === setId)
          .map((r) => ({
            gameIndex: r.gameIndex, userId: r.userId, won: r.won,
            winner: r.winner, reason: r.reason,
          })));
      },
      __simAdvanceTime(sec) {
        wwState.offsetSec += sec;
        return ok(wwNow());
      },
      // テスト専用：自分にペナルティを適用する（実適用経路と同じ処理）
      __simApplyMyPenalty() {
        const r = penApply('me', {
          kind: 'abandon', forcedRemoval: true,
          reasonText: '対戦中に接続が切れたまま復帰がなかったため、離脱と判定されました。',
        });
        return ok({ ...r, penaltyUntilMs: penInfo('me') });
      },
    };
  }

  // =====================================================================
  // SupabaseBackend（実 DB。読み取り = RLS select、書き込み = kl_* RPC）
  // =====================================================================
  function createSupabaseBackend() {
    const cfg = window.KL_CONFIG ?? {};
    let client = null;
    let meId = null;
    function getClient() {
      if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase?.createClient) {
        throw fail('NOT_CONFIGURED', 'Supabase が未設定です');
      }
      if (!client) client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
      return client;
    }
    const rpc = async (fn, args) => {
      const { data, error } = await getClient().rpc(fn, args);
      if (error) {
        const m = /([A-Z_]+):/.exec(error.message ?? '');
        throw fail(m ? m[1] : 'RPC_ERROR', error.message);
      }
      return data;
    };
    const profileRow = (p, extra = {}) => ({
      id: p.id, publicId: p.public_id, name: p.display_name, icon: p.icon_emoji,
      iconKey: p.icon_key ?? null,
      iconBg: p.icon_bg, bio: p.bio, popularity: p.popularity,
      nameDecidedAt: p.name_decided_at ?? null,
      online: p.last_seen_at ? (Date.now() - new Date(p.last_seen_at).getTime() < 5 * 60 * 1000) : false,
      roomTitle: null, ...extra,
    });
    async function myProfile() {
      const { data, error } = await getClient()
        .from('profiles').select('*').eq('id', meId).single();
      if (error) throw fail('PROFILE_ERROR', error.message);
      return data;
    }
    async function myWallet() {
      const { data, error } = await getClient()
        .from('coin_wallets').select('*').eq('user_id', meId).single();
      if (error) throw fail('WALLET_ERROR', error.message);
      return data;
    }
    async function profilesByIds(ids) {
      if (!ids.length) return [];
      const { data, error } = await getClient().from('profiles').select('*').in('id', ids);
      if (error) throw fail('PROFILE_ERROR', error.message);
      return data.map((p) => profileRow(p));
    }

    return {
      mode: 'supabase',
      async bootstrap() {
        const sb = getClient();
        const { data: sessionData } = await sb.auth.getSession();
        if (!sessionData?.session) throw fail('NOT_SIGNED_IN', 'ログインセッションがありません');
        meId = sessionData.session.user.id;
        await sb.rpc('kl_touch_presence');
        const [p, w] = await Promise.all([myProfile(), myWallet()]);
        const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        return {
          me: {
            ...profileRow(p),
            coins: w.free_balance + w.paid_balance,
            bonusClaimed: w.last_login_bonus_date === todayJst,
            penaltyUntilMs: p.penalty_until ? Date.parse(p.penalty_until) : null,
            rulesAgreed: p.rules_agreed_at != null,
          },
          rooms: null, // ルーム一覧は ww 側の取得に切り替える（次フェーズ）
        };
      },
      async getMe() {
        const [p, w] = await Promise.all([myProfile(), myWallet()]);
        return {
          ...profileRow(p), coins: w.free_balance + w.paid_balance,
          penaltyUntilMs: p.penalty_until ? Date.parse(p.penalty_until) : null,
          rulesAgreed: p.rules_agreed_at != null,
        };
      },
      async getRulesAgreed() {
        const p = await myProfile();
        return p.rules_agreed_at != null;
      },
      agreeRules() { return rpc('kl_agree_rules'); },
      heartbeat(roomId) { return rpc('ww_heartbeat', { p_room: roomId }); },
      async claimLoginBonus() {
        const r = await rpc('kl_claim_login_bonus');
        return { claimed: r.claimed, amount: r.amount, coins: r.freeBalance + r.paidBalance };
      },
      async listFriends() {
        const { data, error } = await getClient()
          .from('friendships').select('user_a, user_b');
        if (error) throw fail('FRIENDS_ERROR', error.message);
        const ids = data.map((f) => (f.user_a === meId ? f.user_b : f.user_a));
        return profilesByIds(ids);
      },
      async listOnlineFriends() {
        const friends = await this.listFriends();
        return friends.filter((f) => f.online);
      },
      async listIncomingRequests() {
        const { data, error } = await getClient()
          .from('friend_requests').select('from_id').eq('to_id', meId);
        if (error) throw fail('REQUESTS_ERROR', error.message);
        return profilesByIds(data.map((r) => r.from_id));
      },
      async listOutgoingRequests() {
        const { data, error } = await getClient()
          .from('friend_requests').select('to_id').eq('from_id', meId);
        if (error) throw fail('REQUESTS_ERROR', error.message);
        return profilesByIds(data.map((r) => r.to_id));
      },
      async searchUser(publicId) {
        const rows = await rpc('kl_search_user', { p_public_id: publicId });
        if (!rows?.length) return null;
        const r = rows[0];
        return {
          id: r.id, publicId: r.public_id, name: r.display_name, icon: r.icon_emoji,
          iconKey: r.icon_key ?? null,
          iconBg: r.icon_bg, bio: r.bio, popularity: r.popularity,
          online: false, roomTitle: null, relation: r.relation,
        };
      },
      sendFriendRequest(userId) { return rpc('kl_send_friend_request', { p_to: userId }); },
      respondFriendRequest(userId, accept) {
        return rpc('kl_respond_friend_request', { p_from: userId, p_accept: accept });
      },
      removeFriend(userId) { return rpc('kl_remove_friend', { p_other: userId }); },
      blockUser(userId) { return rpc('kl_block_user', { p_other: userId }); },
      unblockUser(userId) { return rpc('kl_unblock_user', { p_other: userId }); },
      async listBlocked() {
        const { data, error } = await getClient()
          .from('blocks').select('blocked_id').eq('blocker_id', meId);
        if (error) throw fail('BLOCKS_ERROR', error.message);
        return profilesByIds(data.map((b) => b.blocked_id));
      },
      async listMessages(userId) {
        let query = getClient().from('dm_messages').select('*');
        if (userId === 'system') {
          // システムDMは sender_id が NULL のため通常の相手条件では拾えない
          // （ようこそDM kind='welcome' も同じシステム会話に含める）
          query = query.eq('recipient_id', meId).in('kind', ['system', 'welcome']);
        } else {
          query = query.or(`and(sender_id.eq.${meId},recipient_id.eq.${userId}),and(sender_id.eq.${userId},recipient_id.eq.${meId})`);
        }
        const { data, error } = await query.order('created_at', { ascending: true });
        if (error) throw fail('DM_ERROR', error.message);
        return data.map((m) => ({
          id: m.id,
          from: (m.kind === 'system' || m.kind === 'welcome') ? 'system' : m.sender_id,
          to: m.recipient_id, kind: m.kind, body: m.body,
          invite: m.invite_payload, gift: m.gift_payload
            ? { giftKey: m.gift_payload.giftKey, name: m.gift_payload.name, icon: m.gift_payload.icon, price: m.gift_payload.price }
            : null,
          read: m.read_at !== null,
        }));
      },
      async listConversations() {
        const { data, error } = await getClient()
          .from('dm_messages').select('*')
          .or(`sender_id.eq.${meId},recipient_id.eq.${meId}`)
          .order('created_at', { ascending: false });
        if (error) throw fail('DM_ERROR', error.message);
        const byPartner = new Map();
        for (const m of data) {
          const partner = (m.kind === 'system' || m.kind === 'welcome') ? 'system'
            : m.sender_id === meId ? m.recipient_id : m.sender_id;
          const cur = byPartner.get(partner) ?? { partnerId: partner, last: null, unread: 0 };
          if (!cur.last) {
            cur.last = {
              id: m.id, from: (m.kind === 'system' || m.kind === 'welcome') ? 'system' : m.sender_id,
              to: m.recipient_id, kind: m.kind,
              body: m.body, gift: m.gift_payload, invite: m.invite_payload,
            };
          }
          if (m.recipient_id === meId && m.read_at === null) cur.unread += 1;
          byPartner.set(partner, cur);
        }
        const realIds = [...byPartner.keys()].filter((id) => id !== 'system');
        const partners = await profilesByIds(realIds);
        const byId = new Map(partners.map((p) => [p.id, p]));
        if (byPartner.has('system')) {
          byId.set('system', {
            id: 'system', publicId: 'system', name: 'システム', icon: '📢', iconKey: null,
            iconBg: '#eef4ff', bio: '', popularity: 0, online: false, roomTitle: null,
          });
        }
        return [...byPartner.values()].map((c) => ({ ...c, partner: byId.get(c.partnerId) }));
      },
      async sendMessage(userId, body) {
        if (userId === 'system') throw fail('SYSTEM_READ_ONLY', 'システムからのお知らせには返信できません');
        const m = await rpc('kl_send_dm', { p_to: userId, p_body: body });
        return { id: m.id, from: m.sender_id, to: m.recipient_id, kind: 'text', body: m.body, read: true };
      },
      markRead(userId) {
        if (userId === 'system') return rpc('kl_mark_system_dm_read');
        return rpc('kl_mark_dm_read', { p_other: userId });
      },
      async myGiftSummary() {
        const rows = await rpc('kl_my_gift_summary');
        return (rows ?? []).map((r) => ({
          giftKey: r.giftKey, name: r.name, icon: r.icon,
          price: r.price, count: Number(r.count),
        }));
      },
      async userProfile(userId) {
        const p = await rpc('kl_user_profile', { p_user: userId });
        return {
          bio: p.bio ?? '',
          popularity: p.popularity ?? 0,
          wordwolfWins: p.wordwolfWins ?? 0,
          gifts: (p.gifts ?? []).map((r) => ({
            giftKey: r.giftKey, name: r.name, icon: r.icon,
            price: r.price, count: Number(r.count),
          })),
        };
      },
      async giftCatalog() {
        const { data, error } = await getClient()
          .from('gift_catalog').select('*').eq('active', true).order('sort');
        if (error) throw fail('CATALOG_ERROR', error.message);
        return data.map((g) => ({ key: g.key, name: g.name, icon: g.icon, price: g.price }));
      },
      async sendGift(userId, giftKey) {
        const r = await rpc('kl_send_gift', { p_to: userId, p_gift_key: giftKey });
        return { coins: r.freeBalance + r.paidBalance, receiverPopularity: r.receiverPopularity, message: null };
      },
      async tickerFeed() {
        const r = await rpc('kl_ticker_feed');
        return (r ?? []).map((e) => ({ id: e.id, text: e.text }));
      },
      // ---------- アイコン（カタログは icons テーブルが正本） ----------
      async listIcons() {
        const sb = getClient();
        const { data: catalog, error } = await sb
          .from('icons').select('*').eq('active', true).order('sort');
        if (error) throw fail('CATALOG_ERROR', error.message);
        const { data: ownedRows } = await sb
          .from('user_icons').select('icon_key').eq('user_id', meId);
        const owned = new Set((ownedRows ?? []).map((r) => r.icon_key));
        const p = await myProfile();
        return (catalog ?? []).map((c) => ({
          key: c.key, name: c.name, tier: c.tier,
          priceCoins: c.price_coins, winThreshold: c.win_threshold, sort: c.sort,
          owned: c.tier === 'free' || owned.has(c.key)
            || (c.tier === 'win' && (p.wordwolf_wins ?? 0) >= (c.win_threshold ?? 0)),
          selected: p.icon_key === c.key,
        }));
      },
      async updateBio(bio) {
        const r = await rpc('kl_update_profile', { p_bio: String(bio ?? '').trim() });
        return { bio: r.bio };
      },
      async updateName(name) {
        const r = await rpc('kl_update_profile', { p_display_name: String(name ?? '').trim() });
        return { displayName: r.displayName };
      },
      async setIcon(key) {
        const r = await rpc('kl_set_icon', { p_icon_key: key });
        return { iconKey: r.iconKey };
      },
      // ---------- DM招待カードの発行（kl_send_invite） ----------
      async sendInvite(userId, roomId, password) {
        const m = await rpc('kl_send_invite', {
          p_to: userId, p_room: roomId, p_password: password ?? null,
        });
        return {
          id: m.id, from: m.sender_id, to: m.recipient_id, kind: 'invite',
          invite: m.invite_payload, read: true,
        };
      },
      spendCoins() { return Promise.reject(fail('NOT_SUPPORTED', '実 DB では RPC 経由で消費します')); },
      addCoins() { return Promise.reject(fail('NOT_SUPPORTED', '実 DB では RPC 経由で付与します')); },

      // ---------- ワードウルフ／ルーム（ww_* RPC＋RLS select） ----------
      async listGenres() {
        return [...WW_GENRE_LIST];
      },
      async listRooms() {
        const rows = await rpc('ww_list_rooms');
        return (rows ?? []).map((r) => ({
          id: r.id, title: r.title, isPrivate: r.isPrivate, beginner: r.beginner,
          capacity: r.capacity, genre: r.genre ?? null,
          status: r.status, reversalEnabled: r.reversalEnabled,
          hostId: r.hostId, hostName: r.hostName, hostIcon: r.hostIcon,
          hostIconKey: r.hostIconKey ?? null, hostBg: r.hostBg,
          players: r.memberCount, isMember: r.isMember, isHost: r.isHost,
        }));
      },
      async createRoom(opts) {
        const row = await rpc('ww_create_room', {
          p_title: opts.title ?? '',
          p_is_private: !!opts.isPrivate,
          p_password: opts.password ?? null,
          p_beginner_welcome: !!opts.beginner,
          p_reversal_enabled: opts.reversalEnabled !== false,
          p_capacity: Math.min(8, Math.max(4, opts.capacity ?? 4)),
          p_genre: opts.genre && WW_GENRE_LIST.includes(opts.genre) ? opts.genre : null,
        });
        const room = await this.getRoom(row.id);
        const w = await myWallet();
        return { room, coins: w.free_balance + w.paid_balance };
      },
      async getRoom(roomId) {
        const sb = getClient();
        const { data: room, error } = await sb
          .from('rooms').select('*').eq('id', roomId).single();
        if (error || !room) throw fail('ROOM_NOT_FOUND', 'ルームが存在しません');
        const { data: memberRows } = await sb
          .from('room_members').select('user_id, ready, joined_at')
          .eq('room_id', roomId).order('joined_at');
        const members = memberRows ?? [];
        const profiles = await profilesByIds(
          [...new Set([room.host_id, ...members.map((m) => m.user_id)])],
        );
        const byId = new Map(profiles.map((p) => [p.id, p]));
        const fallback = (id) => byId.get(id) ?? {
          id, publicId: '', name: 'プレイヤー', icon: '🐺', iconKey: null, iconBg: '#eef4ff',
          bio: '', popularity: 0, online: false, roomTitle: null,
        };
        const host = fallback(room.host_id);
        const detail = {
          id: room.id, title: room.title, isPrivate: room.is_private,
          beginner: room.beginner_welcome, capacity: room.capacity,
          genre: room.genre ?? null,
          status: room.status, reversalEnabled: room.reversal_enabled,
          hostId: room.host_id, hostName: host.name, hostIcon: host.icon,
          hostBg: host.iconBg, players: members.length,
          isMember: members.some((m) => m.user_id === meId) || room.host_id === meId,
          isHost: room.host_id === meId,
          // no＝プレイヤー番号（joined_at 順＝参加順で1〜N）
          members: members.map((m, i) => ({
            ...fallback(m.user_id), ready: !!m.ready, isHost: m.user_id === room.host_id,
            no: i + 1,
          })),
          // 満室＋全員準備OKが揃った時刻（通報判定用の証跡）
          allReadyAtMs: room.all_ready_at ? Date.parse(room.all_ready_at) : null,
          roomMessages: [],
          currentGame: null,
        };
        // 待機室チャット（直近100件。RLS でメンバーだけが読める）
        try {
          const { data: roomMsgRows } = await sb
            .from('ww_room_messages')
            .select('id, sender_id, kind, body, created_at')
            .eq('room_id', roomId)
            .order('created_at', { ascending: true })
            .limit(100);
          detail.roomMessages = (roomMsgRows ?? []).map((m) => ({
            id: m.id, from: m.sender_id, kind: m.kind, body: m.body,
            atMs: Date.parse(m.created_at),
          }));
        } catch { /* テーブル未適用などの場合は空のまま */ }
        if (room.status === 'playing') {
          const { data: sets } = await sb
            .from('ww_sets').select('id').eq('room_id', roomId)
            .eq('status', 'running').order('created_at', { ascending: false }).limit(1);
          if (sets?.length) {
            const { data: games } = await sb
              .from('ww_games').select('id, phase').eq('set_id', sets[0].id)
              .order('game_index', { ascending: false }).limit(1);
            if (games?.length) {
              detail.currentGame = { setId: sets[0].id, gameId: games[0].id, phase: games[0].phase };
            }
          }
        }
        return detail;
      },
      async joinRoom(roomId, password) {
        await rpc('ww_join_room', { p_room: roomId, p_password: password ?? null });
        return this.getRoom(roomId);
      },
      async leaveRoom(roomId) {
        await rpc('ww_leave_room', { p_room: roomId });
        return null;
      },
      setReady(roomId, ready) {
        return rpc('ww_set_ready', { p_room: roomId, p_ready: !!ready });
      },
      kickMember(roomId, targetId) {
        return rpc('ww_kick_member', { p_room: roomId, p_target: targetId });
      },
      async postRoomMessage(roomId, body) {
        const m = await rpc('ww_post_room_message', { p_room: roomId, p_body: body });
        return { id: m.id, from: m.sender_id, kind: m.kind, body: m.body, atMs: Date.parse(m.created_at) };
      },
      startGame(roomId) { return rpc('ww_start_game', { p_room: roomId }); },
      async getGameView(gameId) {
        const sb = getClient();
        const v = await rpc('ww_player_view', { p_game: gameId });
        const { data: gameRow, error } = await sb
          .from('ww_games').select('set_id, room_id').eq('id', gameId).single();
        if (error || !gameRow) throw fail('GAME_NOT_FOUND', 'ゲームが存在しません');
        const { data: setRow } = await sb
          .from('ww_sets').select('games_per_set, status').eq('id', gameRow.set_id).single();
        // players は player_ids（＝セット開始時の参加順）の並びで返す。
        // no＝プレイヤー番号（この順で1〜N、セット中不変）
        const profs = await profilesByIds(v.playerIds ?? []);
        const profById = new Map(profs.map((p) => [p.id, p]));
        const players = (v.playerIds ?? []).map((id, i) => ({
          ...(profById.get(id) ?? {
            id, publicId: '', name: 'プレイヤー', icon: '🐺', iconKey: null, iconBg: '#eef4ff',
            bio: '', popularity: 0, online: false, roomTitle: null,
          }),
          no: i + 1,
        }));
        const { data: msgRows } = await sb
          .from('ww_messages').select('*').eq('game_id', gameId).order('created_at');
        return {
          gameId, setId: gameRow.set_id, roomId: gameRow.room_id,
          gameIndex: v.gameIndex,
          gamesPerSet: setRow?.games_per_set ?? 1,
          setStatus: v.setStatus ?? setRow?.status ?? 'running',
          terminatedUserIds: v.terminatedUserIds ?? null,
          phase: v.phase, phaseVersion: v.phaseVersion,
          phaseDeadlineMs: v.phaseDeadlineAt ? Date.parse(v.phaseDeadlineAt) : null,
          phaseRemainSec: v.phaseRemainSec ?? null,
          myMessageCount: v.myMessageCount ?? null,
          players,
          category: v.category ?? null,
          myTopic: v.myTopic,
          myVote: !v.myVoteCast ? undefined : (v.myVoteTarget ?? null),
          votesCast: v.votesCast,
          playerCount: (v.playerIds ?? []).length,
          voteRound: v.voteRound, extended: v.extended,
          exiledId: v.exiledId ?? null,
          winner: v.winner ?? null, winReason: v.winReason ?? null,
          reversalChoices: v.reversalChoices ?? null,
          topicPair: v.topicPair ?? null,
          reversalOutcome: v.reversalOutcome ?? null,
          reveal: v.reveal
            ? v.reveal.map((r) => ({
              id: r.id, isWolf: r.isWolf, topic: r.topic,
              won: (v.winner === 'wolves') === r.isWolf,
            }))
            : null,
          messages: (msgRows ?? []).map((m) => ({
            id: m.id, from: m.kind === 'system' ? null : m.sender_id,
            kind: m.kind ?? 'chat', body: m.body, atMs: Date.parse(m.created_at),
          })),
        };
      },
      async postGameMessage(gameId, body) {
        const m = await rpc('ww_post_message', { p_game: gameId, p_body: body });
        return { id: m.id, from: m.sender_id, body: m.body, atMs: Date.parse(m.created_at) };
      },
      castVote(gameId, targetId) {
        return rpc('ww_cast_vote', { p_game: gameId, p_target: targetId ?? null });
      },
      submitReversal(gameId, choice) {
        return rpc('ww_submit_reversal', { p_game: gameId, p_choice: choice });
      },
      advanceGame(gameId, expectedVersion) {
        return rpc('ww_advance', { p_game: gameId, p_expected_version: expectedVersion });
      },
      async getSetResults(setId) {
        const { data, error } = await getClient()
          .from('ww_results').select('*').eq('set_id', setId).order('game_index');
        if (error) throw fail('RESULTS_ERROR', error.message);
        return data.map((r) => ({
          gameIndex: r.game_index, userId: r.user_id, won: r.won,
          winner: r.winner, reason: r.reason,
        }));
      },
      __simAdvanceTime() { return Promise.resolve(null); },
    };
  }

  // =====================================================================
  // 公開インターフェース（モード選択＋フォールバック）
  // =====================================================================
  const sim = createSimBackend();
  let active = sim;
  let booted = false;

  window.KL_DATA = {
    get mode() { return active.mode; },
    async bootstrap() {
      if (booted) return active.bootstrap();
      booted = true;
      const cfg = window.KL_CONFIG ?? {};
      if (cfg.supabaseUrl && cfg.supabaseKey) {
        try {
          const sb = createSupabaseBackend();
          const result = await sb.bootstrap();
          active = sb;
          // ルーム一覧は実データ（ww_list_rooms）。失敗時はデモ一覧に落とす
          result.rooms = await sb.listRooms().catch(async () => {
            const simBoot = await sim.bootstrap();
            return simBoot.rooms;
          });
          return result;
        } catch (e) {
          active = sim; // 未ログイン等はデモモードで動かす
        }
      }
      const result = await active.bootstrap();
      result.rooms = await active.listRooms().catch(() => result.rooms);
      return result;
    },
    getMe: () => active.getMe(),
    claimLoginBonus: () => active.claimLoginBonus(),
    listOnlineFriends: () => active.listOnlineFriends(),
    listFriends: () => active.listFriends(),
    listIncomingRequests: () => active.listIncomingRequests(),
    listOutgoingRequests: () => active.listOutgoingRequests(),
    searchUser: (id) => active.searchUser(id),
    sendFriendRequest: (id) => active.sendFriendRequest(id),
    respondFriendRequest: (id, accept) => active.respondFriendRequest(id, accept),
    removeFriend: (id) => active.removeFriend(id),
    blockUser: (id) => active.blockUser(id),
    unblockUser: (id) => active.unblockUser(id),
    listBlocked: () => active.listBlocked(),
    listConversations: () => active.listConversations(),
    listMessages: (id) => active.listMessages(id),
    sendMessage: (id, body) => active.sendMessage(id, body),
    markRead: (id) => active.markRead(id),
    giftCatalog: () => active.giftCatalog(),
    myGiftSummary: () => active.myGiftSummary(),
    userProfile: (userId) => active.userProfile(userId),
    sendGift: (id, key) => active.sendGift(id, key),
    tickerFeed: () => active.tickerFeed(),
    listIcons: () => active.listIcons(),
    setIcon: (key) => active.setIcon(key),
    updateBio: (bio) => active.updateBio(bio),
    updateName: (name) => active.updateName(name),
    sendInvite: (id, roomId, pw) => active.sendInvite(id, roomId, pw),
    spendCoins: (n) => active.spendCoins(n),
    addCoins: (n) => active.addCoins(n),
    // ワードウルフ／ルーム
    listGenres: () => active.listGenres(),
    listRooms: () => active.listRooms(),
    createRoom: (opts) => active.createRoom(opts),
    getRoom: (id) => active.getRoom(id),
    joinRoom: (id, pw) => active.joinRoom(id, pw),
    leaveRoom: (id) => active.leaveRoom(id),
    setReady: (id, ready) => active.setReady(id, ready),
    kickMember: (id, target) => active.kickMember(id, target),
    postRoomMessage: (id, body) => active.postRoomMessage(id, body),
    startGame: (id) => active.startGame(id),
    getGameView: (id) => active.getGameView(id),
    postGameMessage: (id, body) => active.postGameMessage(id, body),
    castVote: (id, target) => active.castVote(id, target),
    submitReversal: (id, choice) => active.submitReversal(id, choice),
    advanceGame: (id, ver) => active.advanceGame(id, ver),
    getSetResults: (id) => active.getSetResults(id),
    heartbeat: (roomId) => (active.heartbeat ? active.heartbeat(roomId) : Promise.resolve(null)),
    getRulesAgreed: () => active.getRulesAgreed(),
    agreeRules: () => active.agreeRules(),
    // テスト専用：SimBackend の仮想時計を進める（実 DB では無効）
    __simAdvanceTime: (sec) => active.__simAdvanceTime(sec),
    // テスト専用：自分へペナルティを適用する（SimBackend のみ）
    __simApplyMyPenalty: () => (active.__simApplyMyPenalty
      ? active.__simApplyMyPenalty()
      : Promise.reject(new Error('NOT_SUPPORTED'))),
  };
})();
