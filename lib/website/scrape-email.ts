import "server-only";
import { extractEmailFromHtml } from "@/lib/leads/email-extract";

/**
 * Fetches a webpage and extracts any email address from the HTML.
 * Checks both mailto: links and plain-text email patterns.
 * Free — no third-party API needed.
 */
export async function scrapeWebsiteForEmail(url: string): Promise<{ email: string | null; error: string | null }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LeadBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { email: null, error: `http_${res.status}` };
    const html = await res.text();
    const email = extractEmailFromHtml(html);
    return { email, error: email ? null : "no_email_found" };
  } catch (err) {
    return { email: null, error: `fetch_failed: ${(err as Error).message.slice(0, 200)}` };
  }
}
