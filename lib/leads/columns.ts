// Single source of truth for the Leads table columns. Shared between the
// server-rendered table (which tags every <th>/<td> with data-col="<key>") and
// the client-side column-visibility menu (which hides the ones the user turns
// off via CSS). Order here matches the on-screen column order.

export type LeadColumnKey =
  | "account"
  | "bio"
  | "niche"
  | "followers"
  | "engagement"
  | "reels"
  | "score"
  | "status"
  | "analyze"
  | "source"
  | "level"
  | "offer"
  | "youtube"
  | "linkedin"
  | "email"
  | "outreach";

export type LeadColumn = {
  key: LeadColumnKey;
  label: string;
  defaultVisible: boolean;
  // Account is the row's identity (handle, name, links out) — keep it always on
  // so the table can never become a wall of anonymous rows.
  hideable: boolean;
};

export const LEAD_COLUMNS: LeadColumn[] = [
  { key: "account",    label: "Account",     defaultVisible: true,  hideable: false },
  { key: "bio",        label: "Bio",         defaultVisible: false, hideable: true },
  { key: "niche",      label: "Niche",       defaultVisible: true,  hideable: true },
  { key: "followers",  label: "Followers",   defaultVisible: true,  hideable: true },
  { key: "engagement", label: "Engagement",  defaultVisible: false, hideable: true },
  { key: "reels",      label: "Reels (30d)", defaultVisible: false, hideable: true },
  { key: "score",      label: "Score",       defaultVisible: false, hideable: true },
  { key: "status",     label: "Status",      defaultVisible: false, hideable: true },
  { key: "analyze",    label: "Analyze",     defaultVisible: false, hideable: true },
  { key: "source",     label: "Source",      defaultVisible: false, hideable: true },
  { key: "level",      label: "Level",       defaultVisible: false, hideable: true },
  { key: "offer",      label: "Offer",       defaultVisible: false, hideable: true },
  { key: "youtube",    label: "YouTube",     defaultVisible: true,  hideable: true },
  { key: "linkedin",   label: "LinkedIn",    defaultVisible: true,  hideable: true },
  { key: "email",      label: "Email",       defaultVisible: true,  hideable: true },
  { key: "outreach",   label: "Outreach",    defaultVisible: true,  hideable: true },
];

export const LEAD_COLUMN_STORAGE_KEY = "leads:columns";

export const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = Object.fromEntries(
  LEAD_COLUMNS.map((c) => [c.key, c.defaultVisible]),
);
