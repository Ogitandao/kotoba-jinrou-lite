// moderation-run — 処分パイプライン Phase B の採点係
//
// pg_cron（5分毎）→ pg_net → 本関数。未スコアの moderation_cases を
// OpenAI Moderation API（omni-moderation-latest・無料）で採点し、
// 確定判定は DB 側の kl__finalize_case に委ねる（本関数は薄い採点係）。
//
// 認証：verify_jwt は無効でデプロイし、x-cron-secret ヘッダーを
// kl_config の値（service role でのみ読める）と照合する。
// OPENAI_API_KEY は Edge Function Secrets にだけ置く（U10）。
import { createClient } from "jsr:@supabase/supabase-js@2";

const BATCH = 20;

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: cfg, error: cfgErr } = await supabase
    .from("kl_config")
    .select("value")
    .eq("key", "moderation_cron_secret")
    .single();
  if (cfgErr || !cfg || req.headers.get("x-cron-secret") !== cfg.value) {
    return new Response("forbidden", { status: 403 });
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    return new Response("OPENAI_API_KEY is not set", { status: 500 });
  }

  const { data: cases, error: listErr } = await supabase
    .from("moderation_cases")
    .select("id, snapshot_text")
    .in("decision", ["pending", "hidden"])
    .is("scored_at", null)
    .not("snapshot_text", "is", null)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (listErr) {
    return new Response(`case list failed: ${listErr.message}`, { status: 500 });
  }

  let processed = 0;
  let failed = 0;
  for (const c of cases ?? []) {
    try {
      const res = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "omni-moderation-latest",
          input: c.snapshot_text,
        }),
      });
      if (!res.ok) {
        failed++;
        continue;
      }
      const json = await res.json();
      const r = json.results?.[0];
      if (!r) {
        failed++;
        continue;
      }
      const { error } = await supabase.rpc("kl__finalize_case", {
        p_case_id: c.id,
        p_scores: { scores: r.category_scores, flagged: r.categories },
      });
      if (error) failed++;
      else processed++;
    } catch {
      failed++;
    }
  }

  return Response.json({
    processed,
    failed,
    batch: cases?.length ?? 0,
  });
});
