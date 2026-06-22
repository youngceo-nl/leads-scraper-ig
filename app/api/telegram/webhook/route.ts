import { analyzeIgLead, type ManualLeadResult } from "@/lib/manual-lead/analyze";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// Extract every distinct IG username from a message (URLs, @handles, bare handles).
function extractIgTargets(text: string): string[] {
  const seen = new Set<string>();
  const add = (u: string) => { const s = u.toLowerCase(); if (s) seen.add(s); };

  // Full URLs: instagram.com/<username> (skip known non-profile paths)
  const NON_PROFILE = new Set(["p", "reel", "stories", "explore", "accounts", "direct"]);
  for (const [, u] of text.matchAll(/instagram\.com\/([a-zA-Z0-9_.]+)/g)) {
    if (!NON_PROFILE.has(u.toLowerCase())) add(u);
  }

  // @handles
  for (const [, u] of text.matchAll(/@([a-zA-Z0-9_.]{2,30})/g)) add(u);

  return [...seen];
}

function formatResult(result: ManualLeadResult): string {
  if (!result.ok) return `❌ @${result.username}: ${result.error}`;
  const { profile, score } = result;
  const dot = score.overall_score >= 7.5 ? "🟢" : score.overall_score >= 5.5 ? "🟡" : "🔴";
  return [
    `${dot} @${profile.username} — ${score.overall_score}/10 (${score.recommended_action})`,
    `Niche: ${score.niche} | Model: ${score.business_model}`,
    `ICP ${score.icp_fit_score} | Traction ${score.traction_score} | Monetization ${score.monetization_score} | Activity ${score.activity_score}`,
    `Offer: ${score.offer_type}`,
    score.reason_for_score,
    profile.external_link ? `Link: ${profile.external_link}` : "",
  ].filter(Boolean).join("\n");
}

async function tgSend(chatId: number, text: string, threadId?: number) {
  if (!BOT_TOKEN) return;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (threadId) body.message_thread_id = threadId;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type TgUpdate = {
  message?: {
    chat?: { id?: number };
    message_thread_id?: number;
    text?: string;
  };
};

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (WEBHOOK_SECRET) {
    const token = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (token !== WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const chatId = update.message?.chat?.id;
  const text = update.message?.text?.trim();
  const threadId = update.message?.message_thread_id;

  if (!chatId || !text) return new Response("ok");

  const targets = extractIgTargets(text);
  if (targets.length === 0) return new Response("ok");

  const plural = targets.length > 1 ? `${targets.length} profiles` : `@${targets[0]}`;
  await tgSend(chatId, `🔍 Analyzing ${plural}...`, threadId);

  // Analyze sequentially so SB key rotation stays coherent under load
  for (const target of targets) {
    const result = await analyzeIgLead(target);
    await tgSend(chatId, formatResult(result), threadId);
  }

  return new Response("ok");
}
