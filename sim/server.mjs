// ワードウルフ DB 方式の「サーバー側ロジック」ローカル実証版。
//
// docs/wordwolf-db-design.md の RPC 群（ww_start_game / ww_post_message /
// ww_cast_vote / ww_submit_reversal / ww_advance / ww_sweep）を、
// Postgres の代わりに sim/db.mjs のインメモリテーブルで実装したもの。
// ルールの正本は本家エンジン（werewolf-battle-revival/src/wordwolf/
// engine.mjs、2026-11-23 おぎ確定仕様）で、判定ロジックはそれに
// 合わせてある。Lite 側の独立実装であり、本家のコードは import
// していない（お題と乱数ユーティリティだけ独立コピー）。
//
// 実環境との対応：
// - this.db.now()        = DB の now()
// - 同期実行              = 行ロック＋トランザクションの直列化
// - game.phaseVersion     = ww_games.phase_version（冪等判定）
// - エラーコード          = RPC のエラーコードと揃える

import { readFileSync } from 'node:fs';
import { shuffled, pickRandom } from './rng.mjs';
import { PENALTY, nextStepFor, formatMinutes } from './penalty.mjs';

export const WW_PHASE = Object.freeze({
  INTRO: 'intro',
  DISCUSSION: 'discussion',
  VOTING: 'voting',
  REVERSAL: 'reversal',
  RESULT: 'result',
  DONE: 'done',
});

/** フェーズ制限時間などの設定値（本家セッションの既定値と同一） */
export const WW_CONFIG = Object.freeze({
  introSeconds: 15,
  votingSeconds: 15,
  extensionSeconds: 60,
  reversalSeconds: 30,
  afterglowSeconds: 15,
  minPlayers: 4,
  maxPlayers: 8,
  maxMessageLength: 200,
});

/** ウルフ数（人数 → ウルフ数）。本家エンジンの設定表と同一 */
export const WW_WOLF_COUNT = Object.freeze({
  4: 1, 5: 1, 6: 1, 7: 1, 8: 2,
});

/** 話し合い時間（秒）。4〜6人=300 / 7〜8人=360（2026-11-26 おぎ決定で短縮） */
export function discussionSecondsFor(playerCount) {
  return playerCount <= 6 ? 300 : 360;
}

export const REVERSAL_CHOICE_COUNT = 6;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

export function loadTopics() {
  return JSON.parse(readFileSync(new URL('./topics.json', import.meta.url), 'utf8'));
}

export class WordWolfDbServer {
  /**
   * @param {import('./db.mjs').SimDb} db
   * @param {{ rng: () => number, topics?: object[], config?: object }} opts
   */
  constructor(db, { rng, topics, config } = {}) {
    if (typeof rng !== 'function') fail('INVALID_RNG', 'rng 関数を注入してください');
    this.db = db;
    this.rng = rng;
    this.topics = topics ?? loadTopics();
    this.config = { ...WW_CONFIG, ...(config ?? {}) };
    /** ユーザーごとの制限終了時刻（秒。Infinity は無期限）＝ profiles.penalty_until */
    this.penaltyUntilByUser = new Map();
    /** ルーム滞在中の違反ポイント累積（`${roomId}|${userId}` -> 合計）。
        実 DB の room_members.violation_points に相当し、退室・キック・
        強制退室でそのエントリを消す＝滞在リセットになる */
    this.roomPoints = new Map();
  }

  // ---------- ルーム ----------

  createRoom({ hostId, memberIds, reversalEnabled = true, capacity = 8, genre = null }) {
    this.assertJoinable(hostId);
    // ジャンルはお題プールに実在するカテゴリだけ許可（SQL の
    // INVALID_GENRE チェック相当）。null＝おまかせ
    if (genre != null && !this.topics.some((t) => t.category === genre)) {
      fail('INVALID_GENRE', 'ジャンルが存在しません');
    }
    const room = {
      id: this.db.nextId('room'),
      hostId,
      reversalEnabled: reversalEnabled !== false,
      capacity,
      genre: genre ?? null,
      status: 'lobby',
      allReadyAt: null,
    };
    this.db.tables.rooms.set(room.id, room);
    for (const userId of memberIds) {
      this.db.tables.roomMembers.push({
        roomId: room.id, userId, ready: false, joinedAt: this.db.now(), lastHeartbeatAt: null,
      });
    }
    this._refreshAllReady(room);
    return room;
  }

  /** RPC ww_join_room 相当（ペナルティ制限チェック付き） */
  joinRoom(roomId, userId) {
    this.assertJoinable(userId);
    const room = this.db.tables.rooms.get(roomId);
    if (!room) fail('ROOM_NOT_FOUND', 'ルームが存在しません');
    if (room.status !== 'lobby') fail('ROOM_BUSY', 'このルームには今は入れません');
    if (!this.db.tables.roomMembers.some((m) => m.roomId === roomId && m.userId === userId)) {
      const n = this.db.tables.roomMembers.filter((m) => m.roomId === roomId).length;
      if (n >= room.capacity) fail('ROOM_FULL', 'ルームが満員です');
      this.db.tables.roomMembers.push({
        roomId, userId, ready: false, joinedAt: this.db.now(), lastHeartbeatAt: null,
      });
    }
    this._refreshAllReady(room);
    return room;
  }

  /** RPC ww_leave_room 相当。マスターが退室したら最古参へ移譲する */
  leaveRoom(roomId, userId) {
    const room = this.db.tables.rooms.get(roomId);
    if (!room) fail('ROOM_NOT_FOUND', 'ルームが存在しません');
    const idx = this.db.tables.roomMembers.findIndex(
      (m) => m.roomId === roomId && m.userId === userId,
    );
    if (idx < 0) return room;
    this.db.tables.roomMembers.splice(idx, 1);
    this.roomPoints.delete(`${roomId}|${userId}`);
    if (room.hostId === userId) {
      const remaining = this.db.tables.roomMembers.filter((m) => m.roomId === roomId);
      if (remaining.length > 0) {
        room.hostId = remaining[0].userId;
      } else if (room.status === 'lobby') {
        room.status = 'closed';
      }
    }
    this._refreshAllReady(room);
    return room;
  }

  /** RPC ww_set_ready 相当（自分の準備OK切り替え） */
  setReady(roomId, userId, ready) {
    const member = this.db.tables.roomMembers.find(
      (m) => m.roomId === roomId && m.userId === userId,
    );
    if (!member) fail('NOT_A_MEMBER', 'このルームに参加していません');
    member.ready = !!ready;
    const room = this.db.tables.rooms.get(roomId);
    if (room) this._refreshAllReady(room);
    return { ok: true };
  }

  /** RPC ww_kick_member 相当（マスターのみ・待機室のみ） */
  kickMember(roomId, requesterId, targetId) {
    const room = this.db.tables.rooms.get(roomId);
    if (!room) fail('ROOM_NOT_FOUND', 'ルームが存在しません');
    if (room.hostId !== requesterId) fail('NOT_HOST', 'キックできるのはルームマスターだけです');
    if (room.status !== 'lobby') fail('ROOM_BUSY', 'キックは待機室でのみできます');
    if (targetId === room.hostId) fail('INVALID_TARGET', 'マスターはキックできません');
    const idx = this.db.tables.roomMembers.findIndex(
      (m) => m.roomId === roomId && m.userId === targetId,
    );
    if (idx < 0) fail('NOT_A_MEMBER', '対象はこのルームのメンバーではありません');
    this.db.tables.roomMembers.splice(idx, 1);
    this.roomPoints.delete(`${roomId}|${targetId}`);
    this._refreshAllReady(room);
    return { ok: true };
  }

  /**
   * rooms.all_ready_at の再計算（実 DB の ww__refresh_all_ready 相当）。
   * 満室＋マスター以外の全員が準備OKの間だけ時刻を保持する（証跡）。
   */
  _refreshAllReady(room) {
    const members = this.db.tables.roomMembers.filter((m) => m.roomId === room.id);
    const ok = room.status === 'lobby'
      && members.length === room.capacity
      && members.every((m) => m.userId === room.hostId || m.ready);
    if (ok) {
      if (room.allReadyAt === null || room.allReadyAt === undefined) {
        room.allReadyAt = this.db.now();
      }
    } else {
      room.allReadyAt = null;
    }
  }

  /** RPC ww_post_room_message 相当（待機室チャット） */
  postRoomMessage(roomId, senderId, body) {
    const room = this.db.tables.rooms.get(roomId);
    if (!room) fail('ROOM_NOT_FOUND', 'ルームが存在しません');
    if (!this.db.tables.roomMembers.some((m) => m.roomId === roomId && m.userId === senderId)) {
      fail('NOT_A_MEMBER', 'このルームに参加していません');
    }
    if (typeof body !== 'string' || body.trim().length === 0) fail('EMPTY_MESSAGE', '本文が空です');
    if (body.length > this.config.maxMessageLength) fail('MESSAGE_TOO_LONG', '文字数上限を超えています');
    const message = {
      id: this.db.nextId('rmsg'),
      roomId,
      senderId,
      kind: 'chat',
      body,
      at: this.db.now(),
    };
    this.db.tables.roomMessages.push(message);
    return message;
  }

  roomMessagesOf(roomId) {
    return this.db.tables.roomMessages.filter((m) => m.roomId === roomId);
  }

  /** RPC ww_heartbeat 相当：対戦中プレイヤーの生存信号を記録する */
  heartbeat(roomId, userId) {
    const member = this.db.tables.roomMembers.find(
      (m) => m.roomId === roomId && m.userId === userId,
    );
    if (!member) fail('NOT_A_MEMBER', 'このルームに参加していません');
    member.lastHeartbeatAt = this.db.now();
    return { ok: true };
  }

  /**
   * RPC ww_start_game 相当：待機室から1ゲームを開始する（ゲーム単位制）。
   * 開始条件＝満室＋マスター以外の全員が準備OK＋マスターの開始。
   * セットは「1ゲームだけのコンテナ」（gamesPerSet = 1）として作る。
   */
  startGame(roomId, requesterId) {
    const room = this.db.tables.rooms.get(roomId);
    if (!room) fail('ROOM_NOT_FOUND', 'ルームが存在しません');
    if (room.hostId !== requesterId) fail('NOT_HOST', '開始できるのはルームマスターだけです');
    if (room.status !== 'lobby') fail('ROOM_BUSY', 'すでに進行中です');
    const members = this.db.tables.roomMembers.filter((m) => m.roomId === roomId);
    if (members.length !== room.capacity) {
      fail('ROOM_NOT_FULL', `満室にならないと開始できません（現在 ${members.length} / ${room.capacity}人）`);
    }
    if (members.some((m) => m.userId !== room.hostId && !m.ready)) {
      fail('NOT_ALL_READY', '全員が準備OKを押さないと開始できません');
    }
    const set = {
      id: this.db.nextId('set'),
      roomId,
      status: 'running',
      gamesPerSet: 1,
      playerIds: members.map((m) => m.userId),
      createdAt: this.db.now(),
      terminatedUserIds: null,
      terminateAfterGameUserIds: [],
      terminatedReason: null,
    };
    this.db.tables.sets.set(set.id, set);
    room.status = 'playing';
    room.allReadyAt = null;
    const game = this._newGame(set, 1);
    return { set, game };
  }

  /**
   * お題の抽選（SQL の ww__new_game と同じ規則）：
   * - ジャンル指定ルーム：そのカテゴリのペアだけから抽選
   * - おまかせ：カテゴリを1つ抽選してから、そのカテゴリのペアを抽選
   *   （ゲームごとにジャンルが変わる）
   */
  _pickPair(room) {
    let pool = this.topics;
    if (room?.genre) {
      pool = this.topics.filter((t) => t.category === room.genre);
    } else {
      const categories = [...new Set(this.topics.map((t) => t.category).filter(Boolean))];
      if (categories.length > 0) {
        const picked = pickRandom(categories, this.rng);
        pool = this.topics.filter((t) => t.category === picked);
      }
    }
    if (pool.length === 0) pool = this.topics;
    return pickRandom(pool, this.rng);
  }

  _newGame(set, gameIndex) {
    const now = this.db.now();
    const room = this.db.tables.rooms.get(set.roomId);
    const pair = this._pickPair(room);
    const wolfCount = WW_WOLF_COUNT[set.playerIds.length];
    const wolfIds = shuffled(set.playerIds, this.rng).slice(0, wolfCount);
    const wolfSet = new Set(wolfIds);
    const game = {
      id: this.db.nextId('game'),
      setId: set.id,
      roomId: set.roomId,
      gameIndex,
      phase: WW_PHASE.INTRO,
      phaseVersion: 0,
      phaseStartedAt: now,
      phaseDeadlineAt: now + this.config.introSeconds,
      playerIds: [...set.playerIds],
      discussionSeconds: discussionSecondsFor(set.playerIds.length),
      voteRound: 1,
      extended: false,
      votesCast: 0,
      exiledId: null,
      winner: null,
      winReason: null,
      reversalChoices: null,
      reversalOutcome: null,
      // ↓ 秘匿列（実環境では ww_game_secrets。クライアントには出さない）
      secret: {
        citizenTopic: pair.citizen,
        wolfTopic: pair.wolf,
        category: pair.category ?? null,
        wolfIds: [...wolfIds],
      },
    };
    this.db.tables.games.set(game.id, game);
    for (const playerId of set.playerIds) {
      this.db.tables.playerTopics.push({
        gameId: game.id,
        playerId,
        topic: wolfSet.has(playerId) ? pair.wolf : pair.citizen,
      });
    }
    return game;
  }

  // ---------- 参照（Realtime 購読＋ポーリングの代替） ----------

  getGame(gameId) {
    const game = this.db.tables.games.get(gameId);
    if (!game) fail('GAME_NOT_FOUND', 'ゲームが存在しません');
    return game;
  }

  getSet(setId) {
    return this.db.tables.sets.get(setId);
  }

  currentGameOfSet(setId) {
    const games = [...this.db.tables.games.values()].filter((g) => g.setId === setId);
    games.sort((a, b) => b.gameIndex - a.gameIndex);
    return games[0] ?? null;
  }

  /**
   * プレイヤー個人ビュー。自分のお題だけを含み、陣営情報は
   * ゲーム終了（result 以降）まで絶対に含めない。
   */
  playerView(gameId, playerId) {
    const game = this.getGame(gameId);
    if (!game.playerIds.includes(playerId)) fail('NOT_A_PLAYER', 'このゲームの参加者ではありません');
    const myTopicRow = this.db.tables.playerTopics.find(
      (r) => r.gameId === gameId && r.playerId === playerId,
    );
    const finished = game.phase === WW_PHASE.RESULT || game.phase === WW_PHASE.DONE;
    const set = this.db.tables.sets.get(game.setId);
    const view = {
      gameId: game.id,
      gameIndex: game.gameIndex,
      setStatus: set?.status ?? 'running',
      terminatedUserIds: set?.terminatedUserIds ?? null,
      phase: game.phase,
      phaseVersion: game.phaseVersion,
      phaseDeadlineAt: game.phaseDeadlineAt,
      playerIds: [...game.playerIds],
      voteRound: game.voteRound,
      extended: game.extended,
      votesCast: game.votesCast,
      playerCount: game.playerIds.length,
      // ジャンル（カテゴリ）は全員に公開（SQL の ww_player_view と同じ）
      category: game.secret.category,
      myTopic: myTopicRow?.topic,
      myVote: this._myVote(game, playerId),
      exiledId: finished || game.phase === WW_PHASE.REVERSAL ? game.exiledId : null,
      winner: finished ? game.winner : null,
      winReason: finished ? game.winReason : null,
    };
    if (game.phase === WW_PHASE.REVERSAL && playerId === game.exiledId) {
      view.reversalChoices = [...(game.reversalChoices ?? [])];
    }
    if (finished) {
      view.reveal = game.playerIds.map((id) => ({
        id,
        isWolf: game.secret.wolfIds.includes(id),
        topic: this.db.tables.playerTopics.find((r) => r.gameId === gameId && r.playerId === id)?.topic,
      }));
      view.topicPair = { citizen: game.secret.citizenTopic, wolf: game.secret.wolfTopic };
      view.reversalOutcome = game.reversalOutcome;
    }
    return view;
  }

  _myVote(game, playerId) {
    const row = this.db.tables.votes.find(
      (v) => v.gameId === game.id && v.voteRound === game.voteRound && v.voterId === playerId,
    );
    return row ? row.targetId : undefined;
  }

  messagesOf(gameId) {
    return this.db.tables.messages.filter((m) => m.gameId === gameId);
  }

  resultsOfSet(setId) {
    return this.db.tables.results.filter((r) => r.setId === setId);
  }

  /** テスト専用：秘匿情報の参照（実環境のサーバー内部処理に相当） */
  _secretOf(gameId) {
    return this.getGame(gameId).secret;
  }

  // ---------- アクション RPC（締め切りチェック付き） ----------

  /**
   * 締め切りチェック。フェーズ違いより先に「そのフェーズの
   * 締め切りを過ぎているか」を見る：遷移が未実行でも、過ぎた
   * アクションは DEADLINE_PASSED で拒否する（公平性の核）。
   */
  _requireActionWindow(game, phases) {
    if (!phases.includes(game.phase)) {
      fail('INVALID_PHASE', `現在のフェーズは ${game.phase} です`);
    }
    if (this.db.now() >= game.phaseDeadlineAt) {
      fail('DEADLINE_PASSED', '締め切りを過ぎています');
    }
  }

  /** RPC ww_post_message 相当 */
  postMessage(gameId, senderId, body) {
    const game = this.getGame(gameId);
    if (!game.playerIds.includes(senderId)) fail('NOT_A_PLAYER', 'このゲームの参加者ではありません');
    this._requireActionWindow(game, [WW_PHASE.INTRO, WW_PHASE.DISCUSSION]);
    if (typeof body !== 'string' || body.length === 0) fail('EMPTY_MESSAGE', '本文が空です');
    if (body.length > this.config.maxMessageLength) fail('MESSAGE_TOO_LONG', '文字数上限を超えています');
    const message = {
      id: this.db.nextId('msg'),
      gameId,
      senderId,
      kind: 'chat',
      body,
      at: this.db.now(),
    };
    this.db.tables.messages.push(message);
    return message;
  }

  /** RPC ww_cast_vote 相当。targetId が null ならスルー（棄権） */
  castVote(gameId, voterId, targetId) {
    const game = this.getGame(gameId);
    if (!game.playerIds.includes(voterId)) fail('NOT_A_PLAYER', 'このゲームの参加者ではありません');
    this._requireActionWindow(game, [WW_PHASE.VOTING]);
    if (this._myVote(game, voterId) !== undefined) fail('ALREADY_SUBMITTED', 'すでに投票済みです');
    if (targetId !== null && targetId !== undefined) {
      if (!game.playerIds.includes(targetId)) fail('UNKNOWN_PLAYER', '投票先が存在しません');
      if (targetId === voterId) fail('INVALID_TARGET', '自分には投票できません');
    }
    this.db.tables.votes.push({
      gameId,
      voteRound: game.voteRound,
      voterId,
      targetId: targetId ?? null,
    });
    game.votesCast += 1;
    return { ok: true, votesCast: game.votesCast };
  }

  /** RPC ww_submit_reversal 相当。受理されれば即解決する */
  submitReversal(gameId, playerId, choice) {
    const game = this.getGame(gameId);
    this._requireActionWindow(game, [WW_PHASE.REVERSAL]);
    if (playerId !== game.exiledId) fail('NOT_EXILED_WOLF', '逆転回答ができるのは追放されたウルフだけです');
    if (!game.reversalChoices?.includes(choice)) fail('INVALID_CHOICE', '候補の中から選んでください');
    const correct = choice === game.secret.citizenTopic;
    game.reversalOutcome = { attempted: true, correct, timedOut: false };
    this._finishGame(game, correct ? 'wolves' : 'citizens', 'reversal');
    return { correct };
  }

  // ---------- ペナルティ（0010 / kl__apply_penalty 相当） ----------

  /** 現在の制限終了時刻（秒）。制限が無ければ null */
  penaltyUntilOf(userId) {
    const until = this.penaltyUntilByUser.get(userId);
    if (until === undefined) return null;
    return until > this.db.now() ? until : null;
  }

  penaltyEventsOf(userId) {
    return this.db.tables.penalties.filter((e) => e.userId === userId);
  }

  systemDmsOf(userId) {
    return this.db.tables.systemDms.filter((d) => d.userId === userId);
  }

  /** 制限中ユーザーの参加・作成を拒否する（ww_create_room / ww_join_room の冒頭チェック） */
  assertJoinable(userId) {
    const until = this.penaltyUntilOf(userId);
    if (until !== null) {
      const remainMin = until === Infinity
        ? '無期限'
        : `あと約${Math.max(1, Math.ceil((until - this.db.now()) / 60))}分`;
      fail('PENALTY_ACTIVE', `ペナルティ期間中のため、${remainMin}はルームに参加・作成できません`);
    }
  }

  /**
   * ペナルティを1件適用する：段階を決め、制限を積み増しし、記録して
   * システムDMで通知する。harassment トラックは定数のみで適用経路は無い。
   */
  _applyPenalty(userId, { track = 'afk', kind, roomId = null, setId = null, gameId = null, forcedRemoval = false, reasonText }) {
    const now = this.db.now();
    const { step, minutes } = nextStepFor(this.db.tables.penalties.filter((e) => e.userId === userId), track, now);
    const prev = this.penaltyUntilByUser.get(userId) ?? now;
    const until = minutes === -1 || prev === Infinity
      ? Infinity
      : Math.max(prev, now) + minutes * 60;
    this.penaltyUntilByUser.set(userId, until);
    const event = {
      userId, track, kind, roomId, setId, gameId,
      step, minutes, penaltyUntilSec: until, forcedRemoval, atSec: now,
    };
    this.db.tables.penalties.push(event);
    const remainMin = until === Infinity ? null : Math.max(1, Math.round((until - now) / 60));
    const body = [
      '【ペナルティのお知らせ】',
      reasonText,
      until === Infinity
        ? 'ペナルティとして、無期限でルームへの参加・作成ができなくなりました。'
        : `ペナルティとして あと約${remainMin}分間 ルームへの参加・作成ができません（今回の制限：${formatMinutes(minutes)}）。`,
      'ペナルティの回数が増えると制限時間は長くなります（30日間違反がなければ段階的に軽くなります）。対戦中は最後まで参加しましょう。',
    ].join('\n');
    this.db.tables.systemDms.push({ id: this.db.nextId('sysdm'), userId, body, atSec: now });
    return event;
  }

  /**
   * ポイントだけの違反記録（制限は発生しない。段階計算の対象外）。
   * ポイントはルーム滞在中に累積し、退室・キック・強制退室で
   * リセットされる（実 DB の room_members.violation_points 相当）。
   */
  _recordPoint(userId, { kind, points, roomId = null, setId = null, gameId = null }) {
    const event = {
      userId, track: 'afk', kind, roomId, setId, gameId,
      step: 0, minutes: 0, points,
      penaltyUntilSec: this.penaltyUntilByUser.get(userId) ?? this.db.now(),
      forcedRemoval: false, atSec: this.db.now(),
    };
    this.db.tables.penalties.push(event);
    if (roomId !== null && roomId !== undefined) {
      const key = `${roomId}|${userId}`;
      this.roomPoints.set(key, (this.roomPoints.get(key) ?? 0) + points);
    }
    return event;
  }

  /** ルーム滞在中での違反ポイント合計 */
  _pointsInRoom(userId, roomId) {
    return this.roomPoints.get(`${roomId}|${userId}`) ?? 0;
  }

  /**
   * 投票解決時の違反ポイント記録（2026-11-24 おぎ確定のポイント制）：
   * - 発言0件＋未投票（投票行為なし） …… 1.0ポイント
   * - 発言0件＋投票あり …………………… 0.5ポイント
   * - 発言あり＋未投票／棄権 …………… 0.5ポイント
   * - 発言あり＋投票あり ………………… 0ポイント
   * ポイントはルーム滞在中に累積し、合計1.0に達した時点で強制退室＋
   * ペナルティ階段+1（実際の退室と対戦終了は、そのゲームの
   * result 終了時に確定する）。1.0未満では制限もDMも発生しない。
   * なお明示的な棄権（target null の投票行）は「投票なし」には
   * 数えない（その場にいて意思表示したものとして vote_skip 側）。
   */
  _recordVoteSkips(game) {
    if (game.skipsRecorded) return;
    game.skipsRecorded = true;
    const set = this.db.tables.sets.get(game.setId);
    for (const playerId of game.playerIds) {
      const mine = this._myVote(game, playerId);
      const hasValidVote = mine !== undefined && mine !== null;
      const hasVoteRow = mine !== undefined;
      const msgCount = this.db.tables.messages.filter(
        (m) => m.gameId === game.id && m.senderId === playerId && m.kind === 'chat',
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
      this._recordPoint(playerId, {
        kind, points, roomId: game.roomId, setId: game.setId, gameId: game.id,
      });
      if (this._pointsInRoom(playerId, game.roomId) < 1.0) continue;
      this._applyPenalty(playerId, {
        kind,
        roomId: game.roomId,
        setId: game.setId,
        gameId: game.id,
        forcedRemoval: true,
        reasonText: kind === 'silent_no_vote'
          ? '対戦中に発言も投票もなかったため、強制退室となりました。'
          : '対戦中の違反ポイントが上限（1.0）に達したため、強制退室となりました。',
      });
      if (set && !set.terminateAfterGameUserIds.includes(playerId)) {
        set.terminateAfterGameUserIds.push(playerId);
      }
    }
  }

  /**
   * 対戦の強制終了：ルームを待機状態に戻し、対象者を退室させ、
   * ログ用ゲームのチャットへシステムログを流す（詳細理由は出さない）。
   * 完了済みゲームの結果（results）はそのまま残る＝勝敗は有効。
   * 残ったメンバーの準備OKはリセットする。
   */
  _terminateSet(set, userIds, logGame, reason) {
    set.status = 'terminated';
    set.terminatedUserIds = [...userIds];
    set.terminatedReason = reason;
    set.terminateAfterGameUserIds = [];
    const room = this.db.tables.rooms.get(set.roomId);
    if (room) {
      room.status = 'lobby';
      room.allReadyAt = null;
    }
    this.db.tables.roomMembers = this.db.tables.roomMembers.filter(
      (m) => !(m.roomId === set.roomId && userIds.includes(m.userId)),
    );
    for (const m of this.db.tables.roomMembers) {
      if (m.roomId === set.roomId) m.ready = false;
    }
    // マスター本人が対象なら最古参の残存メンバーへ移譲する
    if (room && userIds.includes(room.hostId)) {
      const remaining = this.db.tables.roomMembers.filter((m) => m.roomId === set.roomId);
      if (remaining.length > 0) room.hostId = remaining[0].userId;
    }
    for (const userId of userIds) {
      this.roomPoints.delete(`${set.roomId}|${userId}`);
      this.db.tables.messages.push({
        id: this.db.nextId('msg'),
        gameId: logGame.id,
        senderId: null,
        kind: 'system',
        body: `${userId}さんがゲームルールに違反したため、強制退室となりました`,
        at: this.db.now(),
      });
    }
    this.db.tables.messages.push({
      id: this.db.nextId('msg'),
      gameId: logGame.id,
      senderId: null,
      kind: 'system',
      body: '対戦は終了しました。完了したゲームの勝敗は記録されています。',
      at: this.db.now(),
    });
  }

  /**
   * 離脱・放置の検知（ww_sweep の前段）。進行中セットの現在ゲームに
   * ついて、ハートビートが猶予（2分）を超えて途絶したプレイヤーを
   * 離脱確定とし、セットを即時強制終了する。
   * ハートビートが誰からも記録されていないセット（旧データ・
   * ハートビート未実装のテストリグ）は判定対象にしない。
   */
  _detectAbandons() {
    const now = this.db.now();
    let terminated = 0;
    for (const set of this.db.tables.sets.values()) {
      if (set.status !== 'running') continue;
      const game = this.currentGameOfSet(set.id);
      if (!game || game.phase === WW_PHASE.DONE) continue;
      const members = this.db.tables.roomMembers.filter((m) => m.roomId === set.roomId);
      if (!members.some((m) => m.lastHeartbeatAt !== null && m.lastHeartbeatAt !== undefined)) continue;
      const stale = set.playerIds.filter((playerId) => {
        const member = members.find((m) => m.userId === playerId);
        const hb = member?.lastHeartbeatAt ?? set.createdAt;
        return now - hb > PENALTY.heartbeatGraceSec;
      });
      if (stale.length === 0) continue;
      for (const userId of stale) {
        this._applyPenalty(userId, {
          kind: 'abandon',
          roomId: set.roomId,
          setId: set.id,
          gameId: game.id,
          forcedRemoval: true,
          reasonText: '対戦中に接続が切れたまま復帰がなかったため、離脱と判定されました。',
        });
      }
      // 進行中ゲームは無効（勝敗なし）。result 中なら結果は確定済みなので保持
      if (game.phase !== WW_PHASE.RESULT) {
        game.winner = null;
        game.winReason = 'aborted';
      }
      game.phase = WW_PHASE.DONE;
      game.phaseVersion += 1;
      game.phaseDeadlineAt = null;
      this._terminateSet(set, stale, game, 'abandon');
      terminated += 1;
    }
    return terminated;
  }

  // ---------- 進行 RPC（合図／見回り） ----------

  /**
   * RPC ww_advance 相当（クライアントの合図）。
   * - 期待フェーズと違う → 遷移済みとして現状態を返す（冪等）
   * - 投票フェーズで全員投票済み → 締め切り前でも早期解決
   * - 締め切り前 → まだ進めない
   * - 締め切り到達 → 遷移を実行（先着1件のみ）
   */
  signalAdvance(gameId, expectedPhase) {
    const game = this.getGame(gameId);
    if (game.phase === WW_PHASE.DONE) {
      return { advanced: false, reason: 'already_advanced', phase: game.phase, phaseVersion: game.phaseVersion };
    }
    if (game.phase !== expectedPhase) {
      return { advanced: false, reason: 'already_advanced', phase: game.phase, phaseVersion: game.phaseVersion };
    }
    if (game.phase === WW_PHASE.VOTING && this._allVotesIn(game)) {
      this._resolveVote(game);
      return { advanced: true, early: true, phase: game.phase, phaseVersion: game.phaseVersion };
    }
    if (this.db.now() < game.phaseDeadlineAt) {
      return { advanced: false, reason: 'not_yet', phase: game.phase, phaseVersion: game.phaseVersion };
    }
    this._advanceExpired(game);
    return { advanced: true, early: false, phase: game.phase, phaseVersion: game.phaseVersion };
  }

  /** RPC ww_sweep 相当（pg_cron の見回り）。締め切り超過のゲームを進める */
  sweep() {
    this._detectAbandons();
    const advanced = [];
    for (const game of this.db.tables.games.values()) {
      if (game.phase === WW_PHASE.DONE) continue;
      if (this.db.now() >= game.phaseDeadlineAt) {
        this._advanceExpired(game);
        advanced.push(game.id);
      }
    }
    return advanced;
  }

  _allVotesIn(game) {
    return game.playerIds.every(
      (id) => this._myVote(game, id) !== undefined,
    );
  }

  /** 締め切り到達時の遷移（合図・見回りの共通処理） */
  _advanceExpired(game) {
    switch (game.phase) {
      case WW_PHASE.INTRO:
        this._setPhase(game, WW_PHASE.DISCUSSION, this.db.now() + game.discussionSeconds);
        break;
      case WW_PHASE.DISCUSSION:
        game.votesCast = 0;
        this._setPhase(game, WW_PHASE.VOTING, this.db.now() + this.config.votingSeconds);
        break;
      case WW_PHASE.VOTING:
        this._resolveVote(game);
        break;
      case WW_PHASE.REVERSAL:
        game.reversalOutcome = { attempted: false, correct: false, timedOut: true };
        this._finishGame(game, 'citizens', 'reversal');
        break;
      case WW_PHASE.RESULT:
        this._endGame(game);
        break;
      default:
        break;
    }
  }

  _setPhase(game, phase, deadlineAt) {
    game.phase = phase;
    game.phaseStartedAt = this.db.now();
    game.phaseDeadlineAt = deadlineAt;
    game.phaseVersion += 1;
  }

  /** 投票解決（本家エンジン resolveVote と同一ルール） */
  _resolveVote(game) {
    const tally = new Map();
    for (const v of this.db.tables.votes) {
      if (v.gameId !== game.id || v.voteRound !== game.voteRound) continue;
      if (v.targetId === null || v.targetId === undefined) continue;
      tally.set(v.targetId, (tally.get(v.targetId) ?? 0) + 1);
    }

    // 有効票ゼロ（全員スルー）→ ウルフの勝ち
    if (tally.size === 0) {
      game.exiledId = null;
      this._recordVoteSkips(game);
      this._finishGame(game, 'wolves', 'no_votes');
      return;
    }

    const max = Math.max(...tally.values());
    const top = [...tally.entries()].filter(([, c]) => c === max).map(([id]) => id);

    if (top.length > 1) {
      if (!game.extended) {
        // 同票 → 話し合いを +60秒 延長してもう1回だけ投票
        game.extended = true;
        game.voteRound = 2;
        this._setPhase(game, WW_PHASE.DISCUSSION, this.db.now() + this.config.extensionSeconds);
        return;
      }
      // 延長後の再投票でも同票 → ウルフの勝ち
      game.exiledId = null;
      this._recordVoteSkips(game);
      this._finishGame(game, 'wolves', 'tie');
      return;
    }

    game.exiledId = top[0];
    this._recordVoteSkips(game);
    const set = this.db.tables.sets.get(game.setId);
    const room = this.db.tables.rooms.get(set.roomId);
    if (game.secret.wolfIds.includes(game.exiledId)) {
      if (room.reversalEnabled) {
        game.reversalChoices = this._buildReversalChoices(game);
        this._setPhase(game, WW_PHASE.REVERSAL, this.db.now() + this.config.reversalSeconds);
      } else {
        this._finishGame(game, 'citizens', 'wolf_exiled');
      }
    } else {
      this._finishGame(game, 'wolves', 'citizen_exiled');
    }
  }

  /** 逆転回答の6択を組み立てる（本家エンジンと同一方針） */
  _buildReversalChoices(game) {
    const { citizenTopic, wolfTopic, category } = game.secret;
    const excluded = new Set([citizenTopic, wolfTopic]);
    const seen = new Set(excluded);
    const sameCategory = [];
    const otherCategory = [];
    for (const pair of this.topics) {
      if (pair.citizen === citizenTopic && pair.wolf === wolfTopic) continue;
      const bucket = pair.category === category ? sameCategory : otherCategory;
      for (const topic of [pair.citizen, pair.wolf]) {
        if (seen.has(topic)) continue;
        seen.add(topic);
        bucket.push(topic);
      }
    }
    const dummyCount = REVERSAL_CHOICE_COUNT - 1;
    const dummies = [...shuffled(sameCategory, this.rng).slice(0, dummyCount)];
    if (dummies.length < dummyCount) {
      dummies.push(...shuffled(otherCategory, this.rng).slice(0, dummyCount - dummies.length));
    }
    return shuffled([citizenTopic, ...dummies], this.rng);
  }

  /** 勝敗を確定し、結果行を書いて result（余韻）フェーズへ */
  _finishGame(game, winner, reason) {
    game.winner = winner;
    game.winReason = reason;
    for (const playerId of game.playerIds) {
      const isWolf = game.secret.wolfIds.includes(playerId);
      const won = winner === 'wolves' ? isWolf : !isWolf;
      this.db.tables.results.push({
        setId: game.setId,
        gameId: game.id,
        gameIndex: game.gameIndex,
        userId: playerId,
        won,
        winner,
        reason,
      });
    }
    this._setPhase(game, WW_PHASE.RESULT, this.db.now() + this.config.afterglowSeconds);
  }

  /**
   * result 終了時の処理（ゲーム単位制）：次ゲームは作らない。
   * 違反ポイント1.0到達者がいれば強制退室を確定し、そうでなければ
   * 通常終了。どちらもルームは待機室に戻り、準備OKはリセットされる
   * （違反ポイントはルーム滞在中は保持される）。
   */
  _endGame(game) {
    const set = this.db.tables.sets.get(game.setId);
    game.phase = WW_PHASE.DONE;
    game.phaseVersion += 1;
    game.phaseDeadlineAt = null;
    if (set.terminateAfterGameUserIds.length > 0) {
      this._terminateSet(set, set.terminateAfterGameUserIds, game, 'rule_violation');
      return;
    }
    set.status = 'finished';
    const room = this.db.tables.rooms.get(set.roomId);
    room.status = 'lobby';
    room.allReadyAt = null;
    for (const m of this.db.tables.roomMembers) {
      if (m.roomId === set.roomId) m.ready = false;
    }
  }
}
