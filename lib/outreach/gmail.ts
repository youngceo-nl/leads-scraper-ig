import "server-only";
import { getSettings } from "@/lib/config/settings";
import { gmailSend } from "@/lib/google/gmail-api";
import { gmailOAuthConfigured } from "@/lib/google/oauth";

// Outreach sending via the Gmail API (OAuth, gmail.send scope). Replaces the
// old SMTP app-password transport: that credential could read the whole inbox
// over IMAP; the OAuth send scope cannot read any mail at all.

export type SendResult = {
  messageId: string;          // RFC Message-Id header (used to match replies)
  threadId: string;           // Gmail thread id (reply polling fetches only these)
  accepted: string[];
  rejected: string[];
};

export async function sendEmail(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}): Promise<SendResult> {
  const settings = await getSettings();
  const fromName = (settings.gmail_from_name || process.env.GMAIL_FROM_NAME || "").trim() || null;

  const r = await gmailSend({
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    fromName,
    replyTo: opts.replyTo,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
    threadId: opts.threadId,
  });

  return {
    messageId: r.rfcMessageId ?? r.messageId,
    threadId: r.threadId,
    accepted: [opts.to],
    rejected: [],
  };
}

// True when the Gmail OAuth app is connected and ready to send.
export async function gmailReady(): Promise<boolean> {
  return gmailOAuthConfigured(await getSettings());
}
