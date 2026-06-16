// Plain-language labels for the internal vocabulary used in the database and
// pipeline. Keeping the mapping in one place means the UI can stay beginner
// friendly while the backend keeps its terse identifiers.

// crawl_logs.action → human label + a tone for badge styling.
const ACTION_LABELS: Record<string, string> = {
  scraped_following: "Loaded follow list",
  scraped: "Profile loaded",
  filtered_hard: "Skipped — didn't fit",
  filtered_metrics: "Skipped — low activity",
  scored: "Analyzed & scored",
  qualified: "Qualified",
  rejected: "Not a fit",
  recurse_queued: "Queued deeper search",
  recursed: "Searched their follows",
  persisted: "Saved",
  email_found: "Email found",
  email_not_found: "No email found",
  funnel_found: "Offer found",
  funnel_not_found: "No offer found",
  error: "Error",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? prettify(action);
}

// Whether an action represents an in-progress/positive step (vs. a skip/error),
// used to pick a badge variant.
const POSITIVE_ACTIONS = new Set([
  "scraped_following",
  "scraped",
  "scored",
  "qualified",
  "recurse_queued",
  "recursed",
  "persisted",
  "email_found",
  "funnel_found",
]);

export function actionIsPositive(action: string): boolean {
  return POSITIVE_ACTIONS.has(action);
}

// Lead/job statuses → friendlier wording.
const STATUS_LABELS: Record<string, string> = {
  // lead statuses
  qualified: "Qualified",
  review: "Needs review",
  rejected: "Not a fit",
  pending: "Not analyzed yet",
  // crawl_job statuses
  queued: "Starting…",
  running: "Searching…",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? prettify(status);
}

function prettify(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
