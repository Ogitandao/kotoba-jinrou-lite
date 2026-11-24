// 決定的乱数ユーティリティ。
// シミュレーションを再現可能にするため、エンジンには必ず rng を注入する。
// 本番では Math.random ベースの rng を渡せばよい。

/** mulberry32: シード付き疑似乱数ジェネレータ。0 <= x < 1 を返す関数を返す。 */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 配列をシャッフルした新しい配列を返す（Fisher–Yates）。 */
export function shuffled(array, rng) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 配列からランダムに1要素返す。空配列なら undefined。 */
export function pickRandom(array, rng) {
  if (array.length === 0) return undefined;
  return array[Math.floor(rng() * array.length)];
}
