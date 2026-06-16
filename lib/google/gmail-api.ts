import "server-only";
import { getGmailAccessToken } from "@/lib/google/oauth";

// Thin Gmail REST client used to:
//   • send a message (gmail.send)
//   • fetch a thread by id (gmail.readonly)
//   • search for replies (gmail.readonly) — scoped by the action to the addresses
//     we actually emailed, so unrelated personal mail is never read.
// The thread path catches replies in threads we started; the search path also
// catches replies Gmail re-threaded (changed subject, broken threading) or that
// landed in a thread we didn't record.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Build a minimal RFC 2822 message. Gmail threads a reply when In-Reply-To /
// References point at the parent and the subject matches, so we pass those through.
function buildMime(opts: {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
  ];
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);

  const body = opts.html ?? opts.text ?? "";
  const contentType = opts.html ? "text/html; charset=UTF-8" : "text/plain; charset=UTF-8";
  headers.push(`Content-Type: ${contentType}`);
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export type GmailSendResult = {
  messageId: string;   // Gmail's internal id
  threadId: string;    // the thread this message belongs to
  rfcMessageId: string | null; // the RFC Message-Id header (for reply matching)
};

export async function gmailSend(opts: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  fromName?: string | null;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string; // reply within an existing thread
}): Promise<GmailSendResult> {
  const { accessToken, email } = await getGmailAccessToken();
  const from = opts.fromName ? `${opts.fromName} <${email}>` : email;
  const mime = buildMime({ ...opts, from });
  const raw = base64url(mime);

  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(opts.threadId ? { raw, threadId: opts.threadId } : { raw }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`gmail send failed: ${json?.error?.message || res.status}`);
  }

  // Read back the RFC Message-Id header so replies can be matched on it later.
  let rfcMessageId: string | null = null;
  try {
    const meta = await gmailGetMessageMetadata(json.id, accessToken);
    rfcMessageId = headerValue(meta?.payload?.headers, "Message-Id");
  } catch { /* non-fatal — threadId is enough to find replies */ }

  return { messageId: json.id, threadId: json.threadId, rfcMessageId };
}

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[]; mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
};

function headerValue(headers: GmailHeader[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Walk the MIME tree pulling the first text/plain and text/html bodies.
function extractBodies(payload: GmailMessage["payload"]): { text: string | null; html: string | null } {
  let text: string | null = null;
  let html: string | null = null;
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data && text === null) text = decodeB64Url(part.body.data);
    if (part.mimeType === "text/html" && part.body?.data && html === null) html = decodeB64Url(part.body.data);
    for (const p of part.parts ?? []) walk(p);
  };
  if (payload?.body?.data && payload.mimeType === "text/plain") text = decodeB64Url(payload.body.data);
  for (const p of payload?.parts ?? []) walk(p);
  return { text, html };
}

async function gmailGetMessageMetadata(id: string, accessToken: string): Promise<GmailMessage> {
  const res = await fetch(`${API}/messages/${id}?format=metadata&metadataHeaders=Message-Id`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`gmail message meta failed: ${res.status}`);
  return res.json();
}

export type ThreadMessage = {
  gmailMessageId: string;
  threadId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
};

function parseMessage(m: GmailMessage): ThreadMessage {
  const headers = m.payload?.headers;
  const { email: fromEmail, name: fromName } = parseFrom(headerValue(headers, "From"));
  const { text, html } = extractBodies(m.payload);
  return {
    gmailMessageId: m.id ?? "",
    threadId: m.threadId ?? null,
    rfcMessageId: headerValue(headers, "Message-Id"),
    inReplyTo: headerValue(headers, "In-Reply-To"),
    references: headerValue(headers, "References"),
    fromEmail,
    fromName,
    subject: headerValue(headers, "Subject"),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : headerValue(headers, "Date"),
    text,
    html,
  };
}

// Fetch a single thread by id and return its messages, parsed.
export async function gmailGetThread(threadId: string): Promise<ThreadMessage[]> {
  const { accessToken } = await getGmailAccessToken();
  const res = await fetch(`${API}/threads/${threadId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return [];
  const json = await res.json();
  if (!res.ok) throw new Error(`gmail thread fetch failed: ${json?.error?.message || res.status}`);
  return (json.messages ?? []).map(parseMessage);
}

// Search the mailbox and return matching message ids (paginated up to a cap).
// The `q` is built by the caller and scoped to addresses we contacted.
export async function gmailSearch(query: string, maxResults = 200): Promise<string[]> {
  const { accessToken } = await getGmailAccessToken();
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${API}/messages`);
    u.searchParams.set("q", query);
    u.searchParams.set("maxResults", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await res.json();
    if (!res.ok) throw new Error(`gmail search failed: ${json?.error?.message || res.status}`);
    for (const m of json.messages ?? []) ids.push(m.id as string);
    pageToken = json.nextPageToken;
  } while (pageToken && ids.length < maxResults);
  return ids.slice(0, maxResults);
}

// Fetch a single message by id, parsed. Returns null if it no longer exists.
export async function gmailGetMessage(id: string): Promise<ThreadMessage | null> {
  const { accessToken } = await getGmailAccessToken();
  const res = await fetch(`${API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  const json = await res.json();
  if (!res.ok) throw new Error(`gmail message fetch failed: ${json?.error?.message || res.status}`);
  return parseMessage(json);
}

// "Jane Doe <jane@x.com>" → { name: "Jane Doe", email: "jane@x.com" }
function parseFrom(raw: string | null): { name: string | null; email: string | null } {
  if (!raw) return { name: null, email: null };
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}

// The Gmail address we're connected as (recorded at authorize time).
export async function gmailProfileEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`gmail profile failed: ${json?.error?.message || res.status}`);
  return json.emailAddress as string;
}
