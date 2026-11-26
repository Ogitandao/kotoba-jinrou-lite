/**
 * ことば人狼：異議申し立てのシート同期＋判定反映（enforcement-design §4）
 *
 * 役割：
 * - 未処理の申立てを DB からシートへ追記する（A〜J列＋L列「未処理」）
 * - おぎが K 列に Yes（解除）／No（維持）を入れた行を DB へ反映する
 *   （RPC kl_resolve_appeal が処分の解除・記録・結果DMまで原子的に行う。
 *    既に処理済みの申立ては RPC 側でスキップされるので再実行しても安全）
 *
 * セットアップ（おぎの作業・1回だけ）：
 * 1. 新しい Google スプレッドシートを作り、1行目に列見出しを入れる：
 *    appeal_id / 受付日時 / 公開ID / ユーザー名 / 処分種別 / 段階 /
 *    処分日時 / 解除予定 / 理由カテゴリ / 申立て文 / 判断 / 処理状態 /
 *    処理日時 / エラーメモ
 *    ※このシートは運営だけが見られる場所に置く（申立て文が載るため）
 * 2. 拡張機能 → Apps Script で、このファイルの内容を貼る
 * 3. プロジェクトの設定 → スクリプト プロパティに3つ登録する：
 *    SUPABASE_URL  = https://dtdwkluanoaqiaruzbwe.supabase.co
 *    SUPABASE_ANON_KEY = アプリの公開キー（client/kl-config.js と同じもの）
 *    APPEAL_TOKEN  = DB の kl_config テーブル 'appeal_token' の値
 *                    （Supabase の SQL Editor で
 *                     select value from kl_config where key='appeal_token';
 *                     を実行してコピーする。人に渡さないこと）
 * 4. 関数 setup() を1回実行する（5分おきの自動実行トリガーが付く）
 * 5. K列にはデータの入力規則で Yes / No のドロップダウンを設定すると楽
 */

const PROPS = PropertiesService.getScriptProperties();

function rpc_(name, params) {
  const url = PROPS.getProperty('SUPABASE_URL') + '/rest/v1/rpc/' + name;
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: PROPS.getProperty('SUPABASE_ANON_KEY'),
      Authorization: 'Bearer ' + PROPS.getProperty('SUPABASE_ANON_KEY'),
    },
    payload: JSON.stringify(params),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code >= 300) throw new Error('RPC ' + name + ' HTTP ' + code + ': ' + body.slice(0, 200));
  return body ? JSON.parse(body) : null;
}

function sheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

/** 未処理の申立てをシートへ追記（既にある appeal_id は飛ばす） */
function syncAppeals() {
  const token = PROPS.getProperty('APPEAL_TOKEN');
  const items = rpc_('kl_list_appeals_for_sheet', { p_token: token }) || [];
  if (!items.length) return;
  const sh = sheet_();
  const last = sh.getLastRow();
  const known = new Set();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach((r) => known.add(String(r[0])));
  }
  const rows = [];
  for (const it of items) {
    if (known.has(it.appealId)) continue;
    rows.push([
      it.appealId, it.receivedAt, it.publicId, it.displayName, it.trackLabel,
      it.stepLabel, it.penaltyAt, it.untilLabel, it.category, it.reasonText,
      '', '未処理', '', '',
    ]);
  }
  if (rows.length) {
    sh.getRange(last + 1, 1, rows.length, 14).setValues(rows);
  }
}

/** K列の判断を DB へ反映する（未処理の行だけ。冪等） */
function processDecisions() {
  const token = PROPS.getProperty('APPEAL_TOKEN');
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const values = sh.getRange(2, 1, last - 1, 14).getValues();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const rowNum = i + 2;
    const decision = String(row[10]).trim(); // K
    const status = String(row[11]).trim();   // L
    if ((decision !== 'Yes' && decision !== 'No') || status !== '未処理') continue;
    try {
      rpc_('kl_resolve_appeal', {
        p_appeal_id: String(row[0]),
        p_accept: decision === 'Yes',
        p_token: token,
      });
      sh.getRange(rowNum, 12).setValue('反映済み');
      sh.getRange(rowNum, 13).setValue(new Date());
      sh.getRange(rowNum, 14).setValue('');
    } catch (e) {
      sh.getRange(rowNum, 12).setValue('エラー');
      sh.getRange(rowNum, 14).setValue(String(e).slice(0, 200));
    }
  }
}

/** 定期実行の本体（同期→反映） */
function runAppealsJob() {
  syncAppeals();
  processDecisions();
}

/** 初回セットアップ：5分おきのトリガーを付ける（重複防止つき） */
function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'runAppealsJob')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runAppealsJob').timeBased().everyMinutes(5).create();
  runAppealsJob();
}
