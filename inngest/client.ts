import { Inngest, EventSchemas } from "inngest";

type Events = {
  "crawl/seed.requested": {
    data: {
      crawl_job_id: string;
      seed_id: string;
      seed_username: string;
      // Optional per-seed cap on how many followings to scrape from the seed
      // itself. Recursion still uses settings.max_profiles_per_account.
      profile_limit?: number | null;
      // Scrape the seed's entire following list, ignoring profile_limit and
      // stopping only when Instagram runs out of pages.
      full_account?: boolean;
      // Optional one-off override of the configured scrape provider.
      provider_override?: string | null;
    };
  };
  "crawl/profile.discovered": {
    data: {
      crawl_job_id: string;
      seed_id: string | null;
      username: string;
      depth: number;
      parent_username: string | null;
    };
  };
  "crawl/recurse.requested": {
    data: {
      crawl_job_id: string;
      seed_id: string | null;
      username: string;
      depth: number;
    };
  };
  "leads/backfill.metadata.requested": {
    data: {
      usernames: string[];
      crawl_job_id?: string | null;
    };
  };
  "lead/score.requested": {
    data: {
      lead_id: string;
      crawl_job_id?: string | null;
      /** Set to true to bypass the "already scored" skip guard and force a re-classification */
      force?: boolean;
    };
  };
};

// Decide dev vs. cloud deterministically instead of letting the SDK guess.
// Rule: only talk to Inngest Cloud when a real event key is configured.
// Otherwise force dev mode so events always go to the local dev server
// (http://localhost:8288). This makes the "401 Event key not found" cloud
// fallback impossible during local development — no key, no cloud, ever.
// Set INNGEST_DEV=0 (or "false") to override and force cloud explicitly.
const isDev =
  process.env.INNGEST_DEV !== undefined
    ? process.env.INNGEST_DEV !== "0" && process.env.INNGEST_DEV !== "false"
    : !process.env.INNGEST_EVENT_KEY;

export const inngest = new Inngest({
  id: "email-outbound",
  schemas: new EventSchemas().fromRecord<Events>(),
  isDev,
});
