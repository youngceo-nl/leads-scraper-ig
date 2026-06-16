// Live progress events emitted by the email-enrichment pipeline as it walks its
// sources (Instagram bio → website → YouTube). Streamed to the client so the
// "Find email" button can show, with the right brand icon, exactly which source
// is being checked right now. Kept in its own module (no "server-only" import)
// so both the server pipeline and the client button can import the type.

export type EnrichStage = "bio" | "website" | "youtube" | "domain_inference";

export type EnrichProgress = {
  stage: EnrichStage;
  // "start" = now checking this source; "hit" = email found here.
  state: "start" | "hit";
  // Short, user-facing label shown inline on the button (keep it tight).
  label: string;
};
