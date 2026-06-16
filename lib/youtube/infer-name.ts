import "server-only";
import OpenAI from "openai";

const SYSTEM = `You extract a person's real searchable name from an Instagram profile.
Reply with ONLY the name — nothing else, no punctuation, no explanation.
If you cannot determine a real name with confidence, reply with the single word: unknown`;

/**
 * Asks GPT-4o-mini to infer the creator's real name (first + last, or first +
 * well-known brand name) from their Instagram profile data.
 *
 * Returns null when:
 *  - no API key supplied
 *  - the model replies "unknown"
 *  - the response has < 2 tokens (same weak-name problem we started with)
 */
export async function inferRealName(opts: {
  apiKey: string;
  username: string | null;
  fullName: string | null;
  bio: string | null;
}): Promise<string | null> {
  if (!opts.apiKey) return null;
  if (!opts.username && !opts.fullName && !opts.bio) return null;

  const lines: string[] = [];
  if (opts.username) lines.push(`Instagram username: ${opts.username}`);
  if (opts.fullName) lines.push(`Display name: ${opts.fullName}`);
  if (opts.bio)      lines.push(`Bio: ${opts.bio.slice(0, 300)}`);

  const client = new OpenAI({ apiKey: opts.apiKey });
  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 20,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: lines.join("\n") },
      ],
    });

    const raw = (res.choices[0]?.message?.content ?? "").trim();
    if (!raw || /^unknown$/i.test(raw)) return null;

    // Reject single-token results — same problem we started with.
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;

    return raw;
  } catch {
    return null;
  }
}
