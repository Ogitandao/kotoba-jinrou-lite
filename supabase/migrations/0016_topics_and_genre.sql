-- =============================================================================
-- 0016_topics_and_genre.sql — お題429組の投入＋ジャンル表示・選択
-- =============================================================================
-- 2026-11-25 おぎ決定（ジャンル表示・選択）：
-- - ルーム作成時にジャンルを選べる（「おまかせ」＋お題カテゴリ全19種）。
--   rooms.genre に保存し、NULL＝おまかせ
-- - ジャンル指定ルーム：そのルームではそのジャンルのお題だけが出続ける
-- - おまかせルーム：1ジャンル固定ではなく、ゲームのたびにジャンルが
--   ランダムに変わる（毎ゲーム「ジャンル抽選→そのジャンルからペア抽選」）
-- - ロビーのルームカードにジャンルを表示する（ww_list_rooms に genre 追加）
-- - ゲーム中は全プレイヤーにジャンルを表示する（ww_player_view に
--   category を追加。ペアは同ジャンル同士なので秘匿情報ではない）
--
-- お題は、おぎがスプレッドシートで ❌ 審査した確定429組
-- （kotoba-jinrou-lite-data/topics-confirmed.csv）を投入する。
-- 既存シード22組と (citizen, wolf) が重複するものは二重投入しない
-- （0006 と同じ insert ... select ... where not exists 方式）。
-- distance_note は審査用メモのため DB には入れない。
-- =============================================================================

-- ---------- ルームのジャンル ----------
alter table public.rooms
  add column if not exists genre text;

comment on column public.rooms.genre is
  'お題ジャンル（ww_topics.category のいずれか）。NULL＝おまかせ（ゲームごとにジャンル抽選）。';

-- ---------- お題429組の投入 ----------
insert into public.ww_topics (category, citizen, wolf)
select v.category, v.citizen, v.wolf
  from (values
    ('食べ物', 'ラーメン', 'つけ麺'),
    ('食べ物', 'ハンバーガー', 'サンドイッチ'),
    ('食べ物', 'おにぎり', 'お茶漬け'),
    ('食べ物', 'ピザ', 'パスタ'),
    ('食べ物', '焼きそば', '焼うどん'),
    ('食べ物', '餃子', 'しゅうまい'),
    ('食べ物', 'たこ焼き', 'お好み焼き'),
    ('食べ物', 'オムライス', 'ハヤシライス'),
    ('食べ物', '天ぷら', 'からあげ'),
    ('食べ物', 'みそ汁', 'コーンスープ'),
    ('食べ物', 'チャーハン', 'ピラフ'),
    ('食べ物', '親子丼', 'カツ丼'),
    ('食べ物', 'アイスクリーム', 'かき氷'),
    ('食べ物', 'チョコレート', 'あめ'),
    ('食べ物', 'ポテトチップス', 'ポップコーン'),
    ('食べ物', 'ヨーグルト', 'ゼリー'),
    ('食べ物', 'バナナ', 'みかん'),
    ('食べ物', 'ぶどう', 'もも'),
    ('食べ物', 'いちご', 'さくらんぼ'),
    ('食べ物', 'トマト', 'きゅうり'),
    ('食べ物', 'キャベツ', 'レタス'),
    ('食べ物', 'にんじん', 'じゃがいも'),
    ('食べ物', '卵焼き', '目玉焼き'),
    ('食べ物', '納豆', '豆腐'),
    ('食べ物', 'チーズ', 'バター'),
    ('食べ物', 'ハンバーグ', 'ステーキ'),
    ('食べ物', '焼き鳥', '串カツ'),
    ('食べ物', 'ドーナツ', 'マフィン'),
    ('食べ物', 'ソフトクリーム', 'クレープ'),
    ('食べ物', 'おでん', '鍋'),
    ('飲み物', '紅茶', '緑茶'),
    ('飲み物', 'オレンジジュース', 'ぶどうジュース'),
    ('飲み物', '牛乳', '豆乳'),
    ('飲み物', 'コーラ', 'サイダー'),
    ('飲み物', '麦茶', 'ほうじ茶'),
    ('飲み物', 'ミルクティー', 'レモンティー'),
    ('飲み物', 'ホットココア', 'カフェラテ'),
    ('飲み物', 'スポーツドリンク', 'エナジードリンク'),
    ('飲み物', 'スムージー', 'ミルクシェイク'),
    ('飲み物', '甘酒', 'おしるこ'),
    ('飲み物', '水', '炭酸水'),
    ('飲み物', 'レモネード', 'アイスティー'),
    ('飲み物', 'タピオカドリンク', 'フルーツティー'),
    ('飲み物', '青汁', '野菜ジュース'),
    ('場所', '図書館', '本屋'),
    ('場所', '美術館', '博物館'),
    ('場所', '神社', 'お寺'),
    ('場所', '城', '宮殿'),
    ('場所', 'スーパー', 'コンビニ'),
    ('場所', 'デパート', 'ショッピングモール'),
    ('場所', '魚市場', '商店街'),
    ('場所', '病院', '薬局'),
    ('場所', '学校', '塾'),
    ('場所', '駅', '空港'),
    ('場所', '遊園地', 'ゲームセンター'),
    ('場所', 'キャンプ場', 'バーベキュー場'),
    ('場所', 'ビーチ', '川原'),
    ('場所', 'ホテル', '旅館'),
    ('場所', 'カフェ', 'パン屋'),
    ('場所', '居酒屋', 'バー'),
    ('場所', '定食屋', 'ファミリーレストラン'),
    ('場所', '美容院', '床屋'),
    ('場所', '銭湯', '岩盤浴'),
    ('場所', '駅ビル', '地下街'),
    ('場所', '道の駅', 'サービスエリア'),
    ('場所', '劇場', 'ライブハウス'),
    ('場所', 'プラネタリウム', '天文台'),
    ('場所', '牧場', '農園'),
    ('場所', '屋台', 'フードトラック'),
    ('場所', '交番', '郵便局'),
    ('動物', 'うさぎ', 'ハムスター'),
    ('動物', '馬', '牛'),
    ('動物', '羊', 'ヤギ'),
    ('動物', '豚', 'イノシシ'),
    ('動物', 'ライオン', 'トラ'),
    ('動物', 'ゾウ', 'キリン'),
    ('動物', 'パンダ', 'コアラ'),
    ('動物', 'サル', 'ゴリラ'),
    ('動物', 'ペンギン', 'アザラシ'),
    ('動物', 'フクロウ', 'タカ'),
    ('動物', 'カメ', 'トカゲ'),
    ('動物', 'ヘビ', 'ワニ'),
    ('動物', '金魚', 'メダカ'),
    ('動物', '蝶', 'トンボ'),
    ('動物', 'カブトムシ', 'クワガタ'),
    ('動物', 'セミ', 'コオロギ'),
    ('動物', 'イルカ', 'クジラ'),
    ('動物', 'サメ', 'エイ'),
    ('動物', 'タコ', 'イカ'),
    ('動物', 'カニ', 'エビ'),
    ('動物', 'ニワトリ', 'アヒル'),
    ('動物', 'スズメ', 'カラス'),
    ('動物', 'キツネ', 'タヌキ'),
    ('動物', 'シカ', 'リス'),
    ('スポーツ', 'テニス', 'バドミントン'),
    ('スポーツ', '卓球', 'ビリヤード'),
    ('スポーツ', 'バスケットボール', 'バレーボール'),
    ('スポーツ', 'ラグビー', 'アメリカンフットボール'),
    ('スポーツ', 'ゴルフ', 'ゲートボール'),
    ('スポーツ', '水泳', 'サーフィン'),
    ('スポーツ', 'ジョギング', 'ウォーキング'),
    ('スポーツ', 'ヨガ', 'ピラティス'),
    ('スポーツ', '柔道', '剣道'),
    ('スポーツ', '空手', 'テコンドー'),
    ('スポーツ', '相撲', 'プロレス'),
    ('スポーツ', 'マラソン', '駅伝'),
    ('スポーツ', 'スケートボード', 'BMX'),
    ('スポーツ', 'アーチェリー', '射撃'),
    ('スポーツ', 'フェンシング', '馬術'),
    ('スポーツ', 'カヌー', 'ラフティング'),
    ('スポーツ', 'スノーボード', 'そり'),
    ('スポーツ', 'ダーツ', 'ボウリング'),
    ('スポーツ', 'バレエ', '新体操'),
    ('スポーツ', 'スカイダイビング', 'バンジージャンプ'),
    ('乗り物', '自転車', 'バイク'),
    ('乗り物', '車', 'キャンピングカー'),
    ('乗り物', '飛行機', 'ヘリコプター'),
    ('乗り物', 'フェリー', '潜水艦'),
    ('乗り物', '新幹線', 'SL機関車'),
    ('乗り物', 'モノレール', 'ロープウェイ'),
    ('乗り物', 'エスカレーター', 'エレベーター'),
    ('乗り物', 'タクシー', 'レンタカー'),
    ('乗り物', '救急車', '消防車'),
    ('乗り物', '三輪車', '一輪車'),
    ('乗り物', '気球', 'プライベートジェット'),
    ('乗り物', '馬車', '人力車'),
    ('乗り物', 'ロケット', 'ミサイル'),
    ('乗り物', 'ベビーカー', '車椅子'),
    ('遊び・趣味', '釣り', '虫取り'),
    ('遊び・趣味', 'キャンプ', 'バーベキュー'),
    ('遊び・趣味', 'ガーデニング', '盆栽'),
    ('遊び・趣味', '料理', 'お菓子作り'),
    ('遊び・趣味', '工作', '日曜大工'),
    ('遊び・趣味', '写真撮影', 'お絵描き'),
    ('遊び・趣味', '将棋', '囲碁'),
    ('遊び・趣味', '麻雀', '花札'),
    ('遊び・趣味', 'トランプ', 'すごろく'),
    ('遊び・趣味', 'ジグソーパズル', '数独'),
    ('遊び・趣味', 'プラモデル', 'ラジコン'),
    ('遊び・趣味', 'コスプレ', '着ぐるみ'),
    ('遊び・趣味', '映画鑑賞', '音楽鑑賞'),
    ('遊び・趣味', 'コンサート', 'フェス'),
    ('遊び・趣味', '推し活', '聖地巡礼'),
    ('遊び・趣味', '国内旅行', '海外旅行'),
    ('遊び・趣味', '登山', 'ハイキング'),
    ('遊び・趣味', 'サイクリング', 'ドライブ'),
    ('遊び・趣味', '天体観測', 'バードウォッチング'),
    ('遊び・趣味', 'バイオリン', 'チェロ'),
    ('遊び・趣味', 'フルート', 'クラリネット'),
    ('遊び・趣味', '和太鼓', '三味線'),
    ('遊び・趣味', '書道', '絵手紙'),
    ('遊び・趣味', '茶道', '華道'),
    ('季節・イベント', 'お正月', 'クリスマス'),
    ('季節・イベント', 'バレンタインデー', 'ホワイトデー'),
    ('季節・イベント', 'ハロウィン', 'イースター'),
    ('季節・イベント', '七夕', 'お月見'),
    ('季節・イベント', 'ひな祭り', 'こどもの日'),
    ('季節・イベント', 'お花見', '紅葉狩り'),
    ('季節・イベント', '初詣', '初日の出'),
    ('季節・イベント', '花火大会', '夏祭り'),
    ('季節・イベント', '大晦日', '元日'),
    ('季節・イベント', 'ゴールデンウィーク', 'シルバーウィーク'),
    ('季節・イベント', 'お盆', 'お彼岸'),
    ('季節・イベント', '卒業式', '入学式'),
    ('季節・イベント', '結婚式', '同窓会'),
    ('季節・イベント', '誕生日', '記念日'),
    ('季節・イベント', '盆踊り', '阿波踊り'),
    ('季節・イベント', 'オリンピック', 'ワールドカップ'),
    ('季節・イベント', '母の日', '父の日'),
    ('季節・イベント', '成人式', '七五三'),
    ('自然・天気', '湖', '沼'),
    ('自然・天気', '森', '草原'),
    ('自然・天気', '砂漠', 'オアシス'),
    ('自然・天気', '滝', '泉'),
    ('自然・天気', '洞窟', '峡谷'),
    ('自然・天気', '虹', 'オーロラ'),
    ('自然・天気', '雷', '雹'),
    ('自然・天気', '霧', '雲'),
    ('自然・天気', '台風', '竜巻'),
    ('自然・天気', '満月', '三日月'),
    ('自然・天気', '流れ星', '彗星'),
    ('自然・天気', '桜', '梅'),
    ('自然・天気', '夕日', '朝日'),
    ('自然・天気', '日食', '月食'),
    ('学校', '国語', '数学'),
    ('学校', '理科', '社会'),
    ('学校', '英語', '体育'),
    ('学校', '図工', '家庭科'),
    ('学校', '給食', 'お弁当'),
    ('学校', '宿題', '自由研究'),
    ('学校', '運動会', '文化祭'),
    ('学校', '修学旅行', '遠足'),
    ('学校', '始業式', '終業式'),
    ('学校', '黒板', 'ホワイトボード'),
    ('学校', 'ランドセル', '上履き'),
    ('学校', '教科書', '問題集'),
    ('学校', '鉛筆', 'シャープペンシル'),
    ('学校', '制服', '体操服'),
    ('学校', '部活', '習い事'),
    ('学校', '図書室', '保健室'),
    ('仕事', '医者', '看護師'),
    ('仕事', '教師', '保育士'),
    ('仕事', '警察官', '消防士'),
    ('仕事', '料理人', 'パティシエ'),
    ('仕事', '農家', '漁師'),
    ('仕事', '大工', '建築家'),
    ('仕事', '美容師', 'ネイリスト'),
    ('仕事', 'パイロット', '客室乗務員'),
    ('仕事', '電車の運転士', '車掌'),
    ('仕事', '歌手', '声優'),
    ('仕事', '漫画家', '画家'),
    ('仕事', 'スーパーモデル', '服飾デザイナー'),
    ('仕事', '弁護士', '裁判官'),
    ('仕事', 'Youtuber', 'ライブ配信者'),
    ('仕事', 'アナウンサー', 'リポーター'),
    ('仕事', '店員', '店長'),
    ('家族・友人', 'お父さん', 'お母さん'),
    ('家族・友人', 'お兄ちゃん', 'お姉ちゃん'),
    ('家族・友人', '弟', '妹'),
    ('家族・友人', 'おじいちゃん', 'おばあちゃん'),
    ('家族・友人', '親友', 'ライバル'),
    ('家族・友人', '友達', '知り合い'),
    ('家族・友人', '先輩', '後輩'),
    ('家族・友人', '同僚', '上司'),
    ('家族・友人', 'ご近所さん', '親戚'),
    ('家族・友人', 'いとこ', '甥っ子'),
    ('家族・友人', '双子', '三つ子'),
    ('家族・友人', '一人っ子', '大家族'),
    ('家族・友人', '長男', '末っ子'),
    ('家族・友人', '実家暮らし', '一人暮らし'),
    ('家電・日用品', '冷蔵庫', '電子レンジ'),
    ('家電・日用品', '洗濯機', '乾燥機'),
    ('家電・日用品', '掃除機', '空気清浄機'),
    ('家電・日用品', 'テレビ', 'プロジェクター'),
    ('家電・日用品', 'エアコン', '扇風機'),
    ('家電・日用品', 'ストーブ', 'こたつ'),
    ('家電・日用品', 'ドライヤー', 'ヘアアイロン'),
    ('家電・日用品', '電気ケトル', 'コーヒーメーカー'),
    ('家電・日用品', '炊飯器', '圧力鍋'),
    ('家電・日用品', 'トースター', 'ホットサンドメーカー'),
    ('家電・日用品', 'シャンプー', 'リンス'),
    ('家電・日用品', '石鹸', 'ボディソープ'),
    ('家電・日用品', 'ハンカチ', 'ティッシュ'),
    ('家電・日用品', '傘', 'レインコート'),
    ('家電・日用品', '眼鏡', 'サングラス'),
    ('家電・日用品', '腕時計', '置き時計'),
    ('家電・日用品', '洗剤', '柔軟剤'),
    ('家電・日用品', '布団', '毛布'),
    ('恋愛', '初恋', '片思い'),
    ('恋愛', '脈あり', '脈なし'),
    ('恋愛', '両思い', '友達止まり'),
    ('恋愛', '告白', '失恋'),
    ('恋愛', '映画デート', '遊園地デート'),
    ('恋愛', '浴衣デート', '制服デート'),
    ('恋愛', '放課後デート', '休日デート'),
    ('恋愛', 'ランチデート', 'ディナーデート'),
    ('恋愛', '手つなぎ', 'ハグ'),
    ('恋愛', '初キス', '初デート'),
    ('恋愛', '本命チョコ', '義理チョコ'),
    ('恋愛', '一目惚れ', 'ストーカー'),
    ('恋愛', 'マッチングアプリ', '結婚相談所'),
    ('恋愛', 'マッチングアプリ', '出会い系サイト'),
    ('恋愛', '年上の恋人', '年下の恋人'),
    ('恋愛', '遠距離恋愛', '社内恋愛'),
    ('恋愛', '同棲', 'ルームシェア'),
    ('恋愛', '婚約指輪', '結婚指輪'),
    ('恋愛', '嫉妬', '束縛'),
    ('恋愛', '喧嘩', '仲直り'),
    ('恋愛', '壁ドン', '頭ポンポン'),
    ('恋愛', '恋人つなぎ', '腕を組む'),
    ('恋愛', '恋愛相談', '恋愛占い'),
    ('恋愛', '長電話', 'おやすみ前のLINE'),
    ('恋愛', '草食系', '肉食系'),
    ('恋愛', 'ツンデレ', '素直'),
    ('恋愛', '甘えん坊', 'しっかり者'),
    ('恋愛', '尽くす', '甘える'),
    ('恋愛', '追う恋', '追われる恋'),
    ('恋愛', '身長差', '年齢差'),
    ('恋愛', 'あだ名', '呼び捨て'),
    ('恋愛', '趣味の相性', '食の相性'),
    ('家・暮らし', 'キッチン', 'ダイニング'),
    ('家・暮らし', '浴室', '洗面所'),
    ('家・暮らし', '玄関', 'ベランダ'),
    ('家・暮らし', '寝室', '子供部屋'),
    ('家・暮らし', 'ソファ', 'ベッド'),
    ('家・暮らし', 'テーブル', 'カウンター'),
    ('家・暮らし', 'カーテン', 'ブラインド'),
    ('家・暮らし', 'カーペット', 'フローリング'),
    ('家・暮らし', '階段', '廊下'),
    ('家・暮らし', '屋根裏', '地下室'),
    ('家・暮らし', '一戸建て', 'マンション'),
    ('家・暮らし', 'アパート', 'シェアハウス'),
    ('家・暮らし', '引っ越し', '大掃除'),
    ('家・暮らし', '洗濯', 'アイロンがけ'),
    ('家・暮らし', '庭', '駐車場'),
    ('ファッション', 'Tシャツ', 'パーカー'),
    ('ファッション', 'ジーンズ', 'スカート'),
    ('ファッション', 'ワンピース', 'ブラウス'),
    ('ファッション', 'スニーカー', 'ブーツ'),
    ('ファッション', 'ビーチサンダル', '室内スリッパ'),
    ('ファッション', 'ニット帽', 'キャップ'),
    ('ファッション', 'マフラー', '手袋'),
    ('ファッション', 'コート', 'ジャケット'),
    ('ファッション', 'スーツ', 'タキシード'),
    ('ファッション', 'パジャマ', 'バスローブ'),
    ('ファッション', '水着', '浴衣'),
    ('ファッション', 'ネクタイ', 'ベルト'),
    ('ファッション', '指輪', 'ネックレス'),
    ('ファッション', '財布', 'コインケース'),
    ('ファッション', 'ピアス', 'イヤリング'),
    ('ファッション', 'リュック', 'トートバッグ'),
    ('体・健康', '筋トレ', 'ストレッチ'),
    ('体・健康', '早起き', '夜ふかし'),
    ('体・健康', 'ダイエット', '禁酒'),
    ('体・健康', '風邪', 'インフルエンザ'),
    ('体・健康', '花粉症', '食べ物アレルギー'),
    ('体・健康', '虫歯', '口内炎'),
    ('体・健康', '肩こり', '腰痛'),
    ('体・健康', '頭痛', '腹痛'),
    ('体・健康', 'シミ', 'ソバカス'),
    ('体・健康', 'マッサージ', '整体'),
    ('体・健康', '半身浴', '水風呂'),
    ('体・健康', '予防接種', '健康診断'),
    ('体・健康', '薬', 'サプリメント'),
    ('体・健康', '視力検査', '聴力検査'),
    ('体・健康', 'サウナ', '岩盤浴'),
    ('デジタル', 'デスクトップPC', 'ノートPC'),
    ('デジタル', 'メール', 'DM'),
    ('デジタル', '動画サイト', 'SNS'),
    ('デジタル', 'スマホゲーム', 'テレビゲーム'),
    ('デジタル', 'ブログ', 'ホームページ'),
    ('デジタル', '電子マネー', 'クレジットカード'),
    ('デジタル', 'パスワード', '指紋認証'),
    ('デジタル', 'Wi-Fi', 'テザリング'),
    ('デジタル', 'ワイヤレスイヤホン', 'モバイルバッテリー'),
    ('デジタル', 'イヤホン', 'ヘッドホン'),
    ('デジタル', '電子書籍', '本'),
    ('エンタメ', '映画', 'ドラマ'),
    ('エンタメ', 'アニメ', '特撮'),
    ('エンタメ', '漫画', '小説'),
    ('エンタメ', '雑誌', '新聞'),
    ('エンタメ', 'ラジオ', 'ポッドキャスト'),
    ('エンタメ', 'クイズ番組', 'ニュース番組'),
    ('エンタメ', '漫才', 'コント'),
    ('エンタメ', 'ミュージカル', 'オペラ'),
    ('エンタメ', '歌舞伎', '宝塚'),
    ('エンタメ', 'サーカス', 'マジックショー'),
    ('エンタメ', 'ホラー映画', 'アクション映画'),
    ('エンタメ', 'ミステリー映画', 'ファンタジー映画'),
    ('エンタメ', 'RPG', 'パズルゲーム'),
    ('エンタメ', '野球観戦', 'サッカー観戦'),
    ('エンタメ', '落語', '漫談'),
    ('エンタメ', '人形劇', '紙芝居'),
    ('エンタメ', '料理番組', '旅番組'),
    ('エンタメ', 'バラエティ番組', 'ドキュメンタリー'),
    ('食べ物', '味噌ラーメン', '醤油ラーメン'),
    ('食べ物', 'サムギョプサル', 'しゃぶしゃぶ'),
    ('食べ物', 'すき焼き', '水炊き'),
    ('食べ物', '明太子', 'たらこ'),
    ('食べ物', 'たくあん', 'キムチ'),
    ('食べ物', 'わさび', 'からし'),
    ('食べ物', '醤油', 'ソース'),
    ('食べ物', 'マヨネーズ', 'ケチャップ'),
    ('食べ物', '塩', '砂糖'),
    ('食べ物', 'バゲット', 'クロワッサン'),
    ('飲み物', '抹茶', '煎茶'),
    ('飲み物', 'ミックスジュース', 'トマトジュース'),
    ('飲み物', 'イチゴミルク', 'バナナミルク'),
    ('飲み物', 'ホットミルク', 'ホットレモン'),
    ('飲み物', 'ゼリー飲料', 'プロテイン'),
    ('飲み物', '抹茶ラテ', 'ほうじ茶ラテ'),
    ('場所', '展望台', '屋上'),
    ('場所', '植物園', '果樹園'),
    ('場所', 'ネットカフェ', 'カプセルホテル'),
    ('場所', 'ボウリング場', 'バッティングセンター'),
    ('場所', 'フリーマーケット', 'リサイクルショップ'),
    ('場所', 'ペットショップ', '動物病院'),
    ('場所', 'チャペル', '結婚式場'),
    ('場所', '消防署', '警察署'),
    ('動物', 'ハト', 'ツバメ'),
    ('動物', 'コウモリ', 'モグラ'),
    ('動物', 'ハリネズミ', 'モルモット'),
    ('動物', 'アルパカ', 'ラマ'),
    ('動物', 'チーター', 'ヒョウ'),
    ('動物', 'カバ', 'サイ'),
    ('動物', 'ペリカン', 'フラミンゴ'),
    ('動物', 'オオカミ', 'ハイエナ'),
    ('スポーツ', 'カーリング', 'アイスホッケー'),
    ('スポーツ', 'チアリーディング', 'マーチング'),
    ('スポーツ', '綱引き', '玉入れ'),
    ('スポーツ', 'リレー', '障害物競走'),
    ('スポーツ', 'なわとび', 'フラフープ'),
    ('スポーツ', '腕相撲', '指相撲'),
    ('乗り物', 'トラクター', 'フォークリフト'),
    ('乗り物', '観覧車', 'ジェットコースター'),
    ('乗り物', 'はしご車', 'クレーン車'),
    ('乗り物', 'ミキサー車', 'ダンプカー'),
    ('乗り物', '除雪車', 'ゴミ収集車'),
    ('遊び・趣味', '占い', '心理テスト'),
    ('遊び・趣味', '切手収集', 'コイン収集'),
    ('遊び・趣味', 'プログラミング', '動画編集'),
    ('遊び・趣味', '合唱', '吹奏楽'),
    ('遊び・趣味', 'オセロ', 'チェス'),
    ('遊び・趣味', 'ドミノ', 'ジェンガ'),
    ('遊び・趣味', 'あやとり', '折り紙'),
    ('遊び・趣味', 'けん玉', 'こま回し'),
    ('季節・イベント', '紅白歌合戦', '除夜の鐘'),
    ('季節・イベント', '初売り', '福袋'),
    ('季節・イベント', 'サンタクロース', 'トナカイ'),
    ('季節・イベント', '七草粥', 'おせち料理'),
    ('季節・イベント', 'ひなあられ', '柏餅'),
    ('季節・イベント', '流しそうめん', 'スイカ割り'),
    ('季節・イベント', '雪だるま', 'かまくら'),
    ('季節・イベント', '忘年会', '新年会'),
    ('自然・天気', '松', '竹'),
    ('自然・天気', '島', '半島'),
    ('自然・天気', 'つらら', '霜柱'),
    ('自然・天気', '朝焼け', '夕焼け'),
    ('自然・天気', '新月', '半月'),
    ('自然・天気', '夕立', '通り雨'),
    ('学校', '通知表', '賞状'),
    ('学校', '日直', '給食当番'),
    ('学校', '休み時間', '放課後'),
    ('学校', '社会科見学', '工場見学'),
    ('学校', '転校生', '留学生'),
    ('学校', '職員室', '校長室'),
    ('学校', 'プール', '体育館'),
    ('学校', '卒業アルバム', '文集'),
    ('デジタル', 'スマホ', 'タブレット')
  ) as v(category, citizen, wolf)
 where not exists (
   select 1 from public.ww_topics t
    where t.citizen = v.citizen and t.wolf = v.wolf
 );

-- ---------- ルーム作成（0010 の再定義：p_genre を追加） ----------
-- 引数が増えるため旧シグネチャは drop してから作り直す
-- （共存させると PostgREST の名前付き呼び出しが曖昧になる）。
drop function if exists public.ww_create_room(text, boolean, text, boolean, boolean, integer);

create or replace function public.ww_create_room(
p_title text,
p_is_private boolean default false,
p_password text default null,
p_beginner_welcome boolean default false,
p_reversal_enabled boolean default true,
p_capacity integer default 8,
p_genre text default null
)
returns public.rooms
language plpgsql security definer set search_path = public, extensions
as $$
declare
me uuid := auth.uid();
room public.rooms%rowtype;
spent record;
begin
if me is null then
raise exception 'UNAUTHENTICATED: ログインが必要です' using errcode = 'P0001';
end if;
perform public.kl__assert_not_penalized(me);
if p_is_private and (p_password is null or length(p_password) < 4) then
raise exception 'PASSWORD_REQUIRED: 非公開ルームには4文字以上のパスワードが必要です' using errcode = 'P0001';
end if;
-- ジャンルは ww_topics に実在するカテゴリだけ許可する（未知の値は
-- おまかせ扱いにせず弾く。クライアントは固定リストから選ぶ前提）
if p_genre is not null and not exists (
  select 1 from public.ww_topics t where t.active and t.category = p_genre
) then
raise exception 'INVALID_GENRE: ジャンルが存在しません' using errcode = 'P0001';
end if;

insert into public.rooms (host_id, title, is_private, password_hash,
beginner_welcome, capacity, reversal_enabled, genre)
values (me, coalesce(nullif(trim(p_title), ''), ''), p_is_private,
case when p_is_private then crypt(p_password, gen_salt('bf')) end,
p_beginner_welcome, p_capacity, p_reversal_enabled, p_genre)
returning * into room;

insert into public.room_members (room_id, user_id) values (room.id, me);

if p_is_private then
select * into spent from public.kl_spend_coins(me, 100);
insert into public.coin_ledger (user_id, delta_free, delta_paid, reason, ref_id)
values (me, -spent.spent_free, -spent.spent_paid, 'private_room', room.id);
end if;
return room;
end;
$$;

revoke all on function public.ww_create_room(text, boolean, text, boolean, boolean, integer, text) from public, anon;
grant execute on function public.ww_create_room(text, boolean, text, boolean, boolean, integer, text) to authenticated;

-- ---------- ルーム一覧（0008 の再定義：genre を追加） ----------
create or replace function public.ww_list_rooms()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', r.id,
      'title', r.title,
      'isPrivate', r.is_private,
      'beginner', r.beginner_welcome,
      'capacity', r.capacity,
      'status', r.status,
      'reversalEnabled', r.reversal_enabled,
      'genre', r.genre,
      'hostId', r.host_id,
      'hostName', hp.display_name,
      'hostIcon', hp.icon_emoji,
      'hostBg', hp.icon_bg,
      'memberCount', (select count(*) from public.room_members m
                       where m.room_id = r.id),
      'isMember', exists (select 1 from public.room_members m
                           where m.room_id = r.id and m.user_id = auth.uid()),
      'isHost', r.host_id = auth.uid(),
      'createdAt', r.created_at
    ) as item, r.created_at
    from public.rooms r
    join public.profiles hp on hp.id = r.host_id
    where r.status <> 'closed'
      and (not r.is_private
           or r.host_id = auth.uid()
           or exists (select 1 from public.room_members m
                       where m.room_id = r.id and m.user_id = auth.uid()))
  ) s
$$;

-- ---------- 新規ゲーム（0011 の再定義：ジャンル抽選） ----------
-- ルームの genre が指定されていればそのカテゴリからのみ抽選する。
-- おまかせ（NULL）の場合は「カテゴリを1つランダムに選ぶ→そのカテゴリ
-- からペアを抽選する」2段抽選にし、ゲームごとにジャンルが変わる。
create or replace function public.ww__new_game(p_set public.ww_sets, p_index integer)
returns public.ww_games
language plpgsql security definer set search_path = public
as $$
declare
  INTRO_SECONDS constant integer := 15; -- 挨拶タイムの長さ（変更はここ）
  topic public.ww_topics%rowtype;
  room_genre text;
  picked_category text;
  wolf_count integer;
  wolf_ids uuid[];
  game public.ww_games%rowtype;
  pid uuid;
begin
  select genre into room_genre from public.rooms where id = p_set.room_id;
  if room_genre is not null then
    picked_category := room_genre;
  else
    select category into picked_category
      from (select distinct category from public.ww_topics
             where active and category is not null) c
     order by random() limit 1;
  end if;
  select * into topic from public.ww_topics
   where active and category is not distinct from picked_category
   order by random() limit 1;
  -- 万一カテゴリで引けなかった場合の保険（全件から抽選）
  if topic.id is null then
    select * into topic from public.ww_topics where active order by random() limit 1;
  end if;
  wolf_count := case when array_length(p_set.player_ids, 1) >= 8 then 2 else 1 end;
  select array_agg(x) into wolf_ids
    from (select unnest(p_set.player_ids) as x order by random() limit wolf_count) s;

  insert into public.ww_games (set_id, room_id, game_index, phase,
                               phase_deadline_at, discussion_seconds)
  values (p_set.id, p_set.room_id, p_index, 'intro',
          now() + make_interval(secs => INTRO_SECONDS),
          case when array_length(p_set.player_ids, 1) <= 6 then 300 else 480 end)
  returning * into game;

  insert into public.ww_game_secrets (game_id, citizen_topic, wolf_topic, category, wolf_ids)
  values (game.id, topic.citizen, topic.wolf, topic.category, wolf_ids);

  foreach pid in array p_set.player_ids loop
    insert into public.ww_player_topics (game_id, player_id, topic)
    values (game.id, pid,
            case when pid = any(wolf_ids) then topic.wolf else topic.citizen end);
  end loop;
  return game;
end;
$$;

-- ---------- 個人ビュー（0012 の再定義：category を追加） ----------
-- ジャンルは全プレイヤー共通の公開情報（ペアは同ジャンル同士）。
-- 挨拶タイム（intro）中も含め、全フェーズで返す。
create or replace function public.ww_player_view(p_game uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  game public.ww_games%rowtype;
  sec public.ww_game_secrets%rowtype;
  my_topic text;
  finished boolean;
  view jsonb;
  v_player_ids uuid[];
  v_my_vote_cast boolean;
  v_my_vote_target uuid;
  v_set_status text;
  v_terminated_user_ids uuid[];
  v_category text;
begin
  select * into game from public.ww_games where id = p_game;
  if not found then
    raise exception 'GAME_NOT_FOUND: ゲームが存在しません' using errcode = 'P0001';
  end if;
  select player_ids, status, terminated_user_ids
    into v_player_ids, v_set_status, v_terminated_user_ids
    from public.ww_sets s where s.id = game.set_id;
  if not (me = any (v_player_ids)) then
    raise exception 'NOT_A_PLAYER: このゲームの参加者ではありません' using errcode = 'P0001';
  end if;
  select topic into my_topic from public.ww_player_topics
   where game_id = p_game and player_id = me;
  select category into v_category from public.ww_game_secrets where game_id = p_game;
  select exists (
    select 1 from public.ww_votes
     where game_id = p_game and vote_round = game.vote_round and voter_id = me
  ), (
    select target_id from public.ww_votes
     where game_id = p_game and vote_round = game.vote_round and voter_id = me
  )
  into v_my_vote_cast, v_my_vote_target;
  finished := game.phase in ('result', 'done');
  view := jsonb_build_object(
    'gameId', game.id,
    'gameIndex', game.game_index,
    'phase', game.phase,
    'phaseVersion', game.phase_version,
    'phaseDeadlineAt', game.phase_deadline_at,
    'phaseRemainSec', case
      when game.phase_deadline_at is null then null
      else greatest(0, ceil(extract(epoch from (game.phase_deadline_at - now())))::integer)
    end,
    'myMessageCount', (
      select count(*)::integer from public.ww_messages m
       where m.game_id = p_game and m.sender_id = me and m.kind = 'chat'
    ),
    'voteRound', game.vote_round,
    'extended', game.extended,
    'votesCast', game.votes_cast,
    'playerIds', to_jsonb(v_player_ids),
    'setStatus', v_set_status,
    'terminatedUserIds', to_jsonb(coalesce(v_terminated_user_ids, '{}'::uuid[])),
    -- ジャンル（カテゴリ）は全員に公開する
    'category', v_category,
    -- 挨拶タイム（intro）中はお題をまだ見せない
    'myTopic', case when game.phase = 'intro' then null else my_topic end,
    'myVoteCast', v_my_vote_cast,
    'myVoteTarget', v_my_vote_target,
    'exiledId', case when finished or game.phase = 'reversal' then game.exiled_id end,
    'winner', case when finished then game.winner end,
    'winReason', case when finished then game.win_reason end
  );
  if game.phase = 'reversal' and me = game.exiled_id then
    view := view || jsonb_build_object('reversalChoices', game.reversal_choices);
  end if;
  if finished then
    select * into sec from public.ww_game_secrets where game_id = p_game;
    view := view || jsonb_build_object(
      'topicPair', jsonb_build_object('citizen', sec.citizen_topic, 'wolf', sec.wolf_topic),
      'reversalOutcome', game.reversal_outcome,
      'reveal', (
        select jsonb_agg(jsonb_build_object(
          'id', pid,
          'isWolf', pid = any (sec.wolf_ids),
          'topic', (select pt.topic from public.ww_player_topics pt
                     where pt.game_id = p_game and pt.player_id = pid)
        ) order by array_position(v_player_ids, pid))
        from unnest(v_player_ids) as pid
      )
    );
  end if;
  return view;
end;
$$;
