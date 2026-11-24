// ローカル実証用のインメモリ「DB」。
//
// 実 Supabase では Postgres のテーブル＋DB の now() が担う部分を、
// ここでは Map/配列のテーブルと仮想時計で再現する。
// - 時刻の権威はこの時計（実環境では DB の now()）だけ。
//   クライアント役のテストコードが自分の都合で時刻を
//   進めることはできず、進めるのはテストハーネス（＝時間経過
//   そのもの）の役目として切り分ける。
// - サーバー処理（server.mjs）は同期実行＝実環境の
//   「行ロック＋トランザクション」の直列化を再現する。

export class SimDb {
  constructor() {
    /** 仮想時刻（秒）。開始は 0 */
    this.timeSec = 0;
    this.seq = 0;
    this.tables = {
      rooms: new Map(), // id -> room
      roomMembers: [], // { roomId, userId }
      sets: new Map(), // id -> set
      games: new Map(), // id -> game（秘匿列を含む＝ww_games＋ww_game_secrets の合体）
      playerTopics: [], // { gameId, playerId, topic }（ww_player_topics）
      messages: [], // { id, gameId, senderId, body, at }
      roomMessages: [], // { id, roomId, senderId, kind, body, at }（待機室チャット）
      votes: [], // { gameId, voteRound, voterId, targetId }（ww_votes）
      results: [], // { setId, gameId, gameIndex, userId, won, winner, reason }
      penalties: [], // { userId, track, kind, roomId, setId, gameId, step, minutes, penaltyUntilSec, forcedRemoval, atSec }（penalty_events）
      systemDms: [], // { id, userId, body, atSec }（dm_messages の kind='system'）
    };
  }

  /** DB の now() に相当する唯一の時刻源 */
  now() {
    return this.timeSec;
  }

  /** 時間経過そのもの（テストハーネスだけが呼ぶ） */
  advanceTime(sec) {
    if (!(sec >= 0)) throw new Error('時刻は巻き戻せません');
    this.timeSec += sec;
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
}
