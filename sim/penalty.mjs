// ペナルティの定数と段階計算（Lite）。
//
// 決定の正本は計画書（werewolf-battle-revival/docs/lite-plan-draft.md）
// の「ペナルティ」節（2026-11-24 おぎ確定）。数値を変えるときは
// ここ（sim／クライアント検証用）と supabase/migrations/0010 の
// kl_penalty_minutes / kl_penalty_max_step（実 DB 用）を合わせて直す。
//
// 段階の考え方（執行猶予方式）：
// - 違反のたびに「現在のレベル＋1」の段が適用される
// - 最後の違反から30日経過するごとにレベルが1段下がる
// - ただし一度ペナルティを受けたユーザーのレベルは 0 には戻らない
//   （完全なゼロリセットはしない。最低レベル1＝次回は2段目から）
// - 段はトラックごとの階段の上限で頭打ち（離脱系は5段目=24時間が上限）

export const PENALTY = Object.freeze({
  /** ハートビート途絶から離脱確定までの猶予（秒） */
  heartbeatGraceSec: 120,
  /** レベルが1段下がるまでの無違反期間（日） */
  decayDays: 30,
  /** トラック別・段別の制限時間（分）。-1 は無期限 */
  ladders: Object.freeze({
    // 離脱・放置系（2026-11-24 おぎ確定）：
    // 1時間 → 3時間 → 6時間 → 12時間 → 24時間（上限、以降毎回24時間）
    afk: Object.freeze([60, 180, 360, 720, 1440]),
    // 嫌がらせ・セクハラ系：おぎ方針「一発アウトでも良いぐらい重く」。
    // 処分の適用（自動調査）は処分フェーズの範囲で、ここは定数の置き場のみ。
    // 7日 → 30日 → 無期限
    harassment: Object.freeze([10080, 43200, -1]),
  }),
});

/** トラックの最大段（階段の段数） */
export function maxStep(track) {
  return PENALTY.ladders[track]?.length ?? 1;
}

/** 段 → 制限時間（分）。段が階段を超えたら最終段の値 */
export function ladderMinutes(track, step) {
  const ladder = PENALTY.ladders[track];
  if (!ladder) return 0;
  const s = Math.min(Math.max(step, 1), ladder.length);
  return ladder[s - 1];
}

/**
 * 次の違反に適用する段を求める。
 * @param {Array<{track:string, step:number, minutes:number, atSec:number}>} events
 *   そのユーザーのペナルティ適用履歴（時刻順でなくてもよい）
 * @param {string} track
 * @param {number} nowSec 現在時刻（秒）
 * @returns {{ level:number, step:number, minutes:number }}
 *   level = 軽減後の現在レベル、step = 次に適用する段
 */
export function nextStepFor(events, track, nowSec) {
  const applied = events.filter(
    (e) => e.track === track && (e.minutes > 0 || e.minutes === -1),
  );
  if (applied.length === 0) return { level: 0, step: 1, minutes: ladderMinutes(track, 1) };
  const last = applied.reduce((a, b) => (b.atSec >= a.atSec ? b : a));
  const elapsedDays = Math.max(0, (nowSec - last.atSec) / 86400);
  const periods = Math.floor(elapsedDays / PENALTY.decayDays);
  const level = Math.max(1, last.step - periods); // ゼロには戻らない
  const step = Math.min(level + 1, maxStep(track));
  return { level, step, minutes: ladderMinutes(track, step) };
}

/** 分の表示（60分以上は時間単位、-1 は無期限） */
export function formatMinutes(minutes) {
  if (minutes === -1) return '無期限';
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}
