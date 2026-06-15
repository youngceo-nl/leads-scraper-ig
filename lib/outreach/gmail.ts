import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getSettings } from "@/lib/config/settings";

// Transport is cached per credentials string so a settings change invalidates it.
let cachedTransport: { key: string; transport: Transporter } | null = null;

async function getTransport(): Promise<{ transport: Transporter; user: string; fromName: string | null }> {
  const settings = await getSettings();
  const user = (settings.gmail_user || process.env.GMAIL_USER || "").trim();
  const pass = (settings.gmail_app_password || process.env.GMAIL_APP_PASSWORD || "").trim().replace(/\s+/g, "");
  const fromName = (settings.gmail_from_name || process.env.GMAIL_FROM_NAME || "").trim() || null;

  if (!user || !pass) throw new Error("Gmail credentials not configured — add them in Settings → Outreach.");

  const key = `${user}:${pass}`;
  if (!cachedTransport || cachedTransport.key !== key) {
    cachedTransport = {
      key,
      transport: nodemailer.createTransport({ service: "gmail", auth: { user, pass } }),
    };
  }
  return { transport: cachedTransport.transport, user, fromName };
}

export type SendResult = {
  messageId: string;
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
}): Promise<SendResult> {
  const { transport, user, fromName } = await getTransport();
  const from = fromName ? `${fromName} <${user}>` : user;

  const info = await transport.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
  return {
    messageId: info.messageId,
    accepted: info.accepted as string[],
    rejected: info.rejected as string[],
  };
}

export async function verifyTransport(): Promise<boolean> {
  const { transport } = await getTransport();
  await transport.verify();
  return true;
}
