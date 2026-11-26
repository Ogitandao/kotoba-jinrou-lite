// push-send — Web Push 送信係（0059）
//
// 呼び出し元：
// - DM 到着トリガー（pg_net）: { mode: "dm", messageId }
// - 呼び戻し cron（pg_net）: { mode: "comeback", userIds }
// - 運営告知（手動実行）: { mode: "announce", text }
//
// 認証：verify_jwt は無効でデプロイし、x-cron-secret ヘッダーを
// kl_config の 'push_secret'（service role でのみ読める）と照合する。
// VAPID 鍵も kl_config（'vapid_public' / 'vapid_private'）から読む。
//
// 文言（2026-11-26 おぎ確定）：ロック画面に本文・名前は出さない。
// - DM: 「メッセージが届きました」
// - 招待: 「招待が届きました」
// - システムDM: 「システムよりお知らせ」
// - イベント告知: 告知文そのもの（個人情報ではないため）
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP_NAME = "ことば人狼";

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: cfgRows, error: cfgErr } = await supabase
    .from("kl_config")
    .select("key, value")
    .in("key", ["push_secret", "vapid_public", "vapid_private"]);
  if (cfgErr) return json({ error: "config" }, 500);
  const conf: Record<string, string> = Object.fromEntries(
    (cfgRows ?? []).map((r) => [r.key, r.value]),
  );
  if (!conf.push_secret || req.headers.get("x-cron-secret") !== conf.push_secret) {
    return new Response("forbidden", { status: 403 });
  }
  if (!conf.vapid_public || !conf.vapid_private) {
    return json({ error: "vapid not configured" }, 500);
  }
  webpush.setVapidDetails(
    "mailto:ogi-games-support@googlegroups.com",
    conf.vapid_public,
    conf.vapid_private,
  );

  const body = await req.json().catch(() => ({} as Record<string, unknown>));

  // 1ユーザーへ、設定（全体＋カテゴリ）を見て送る。失効した購読は掃除する
  async function sendToUser(
    userId: string,
    payload: Record<string, string>,
    category: "dm" | "invite" | "announce" | "comeback" | null,
  ): Promise<number> {
    const { data: prefs } = await supabase
      .from("kl_push_prefs")
      .select("master, dm, invite, announce, comeback")
      .eq("user_id", userId)
      .maybeSingle();
    const p = prefs ?? { master: true, dm: true, invite: true, announce: true, comeback: true };
    if (!p.master) return 0;
    if (category && (p as Record<string, boolean>)[category] === false) return 0;
    const { data: subs } = await supabase
      .from("kl_push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", userId);
    let sent = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60 * 6 },
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          await supabase.from("kl_push_subscriptions").delete().eq("id", s.id);
        }
      }
    }
    return sent;
  }

  if (body.mode === "dm") {
    const { data: msg } = await supabase
      .from("dm_messages")
      .select("id, sender_id, recipient_id, kind")
      .eq("id", String(body.messageId ?? ""))
      .single();
    if (!msg) return json({ sent: 0, note: "message not found" });
    let payload: Record<string, string>;
    let category: "dm" | "invite";
    if (msg.kind === "invite") {
      payload = { title: APP_NAME, body: "招待が届きました", tag: `dm-${msg.sender_id}`, url: `/#dm/${msg.sender_id}` };
      category = "invite";
    } else if (msg.kind === "system") {
      payload = { title: APP_NAME, body: "システムよりお知らせ", tag: "system", url: "/#dm/system" };
      category = "dm";
    } else {
      payload = { title: APP_NAME, body: "メッセージが届きました", tag: `dm-${msg.sender_id}`, url: `/#dm/${msg.sender_id}` };
      category = "dm";
    }
    const sent = await sendToUser(msg.recipient_id, payload, category);
    return json({ sent });
  }

  if (body.mode === "announce") {
    const text = String(body.text ?? "").slice(0, 120);
    if (!text) return json({ sent: 0, note: "empty text" });
    const { data: owners } = await supabase
      .from("kl_push_subscriptions")
      .select("user_id");
    const userIds = [...new Set((owners ?? []).map((r) => r.user_id))];
    let sent = 0;
    for (const uid of userIds) {
      sent += await sendToUser(
        uid,
        { title: APP_NAME, body: text, tag: "announce", url: "/" },
        "announce",
      );
    }
    return json({ sent, users: userIds.length });
  }

  if (body.mode === "comeback") {
    const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
    let sent = 0;
    for (const uid of userIds) {
      // 呼び戻しは「運営からのお知らせ」と同じ扱い（2026-11-26 おぎ）：
      // プッシュ通知OFF／お知らせOFFの人には送らない
      sent += await sendToUser(
        uid,
        { title: APP_NAME, body: "おひさしぶりです！ことば人狼で遊びませんか？", tag: "comeback", url: "/" },
        "announce",
      );
    }
    return json({ sent, users: userIds.length });
  }

  return json({ error: "unknown mode" }, 400);
});
