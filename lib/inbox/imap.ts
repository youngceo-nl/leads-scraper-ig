import "server-only";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// A single message pulled from the Gmail INBOX over IMAP. Matching to a lead /
// outreach send happens in the caller (app/actions/inbox.ts), not here.
export type FetchedMessage = {
  uid: number;
  messageId: string | null;   // Message-ID header of this message
  inReplyTo: string | null;   // the message-id this is replying to
  references: string[];       // full reference chain (message-ids)
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  date: string | null;        // ISO timestamp
  text: string | null;
  html: string | null;
};

function gmailCreds(): { user: string; pass: string } {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not configured");
  return { user, pass };
}

// Connect to Gmail IMAP and pull recent INBOX messages. We fetch the raw source
// and parse it with mailparser so we get reliable In-Reply-To / References
// headers (which is how we tie a reply back to the exact outreach we sent).
export async function fetchInboxMessages(opts: {
  since?: Date | null;   // only messages received on/after this date
  sinceDays?: number;    // fallback window when `since` is null (default 30)
  limit?: number;        // cap most-recent N matched UIDs (default 300)
}): Promise<FetchedMessage[]> {
  const { user, pass } = gmailCreds();
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const out: FetchedMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = opts.since ?? new Date(Date.now() - (opts.sinceDays ?? 30) * 86_400_000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (uids.length === 0) return out;
      const pick = uids.slice(-(opts.limit ?? 300));

      for await (const msg of client.fetch(pick, { uid: true, source: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const refs = Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [];
        const fromAddr = parsed.from?.value?.[0];
        out.push({
          uid: msg.uid,
          messageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          references: refs,
          fromEmail: fromAddr?.address ?? null,
          fromName: fromAddr?.name || null,
          subject: parsed.subject ?? null,
          date: parsed.date ? parsed.date.toISOString() : null,
          text: parsed.text ?? null,
          html: typeof parsed.html === "string" ? parsed.html : null,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out;
}
