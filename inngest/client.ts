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
    };
  };
  "crawl/profile.discovered": {
    data: {
      crawl_job_id: string;
      seed_id: string;
      username: string;
      depth: number;
      parent_username: string | null;
    };
  };
  "crawl/recurse.requested": {
    data: {
      crawl_job_id: string;
      seed_id: string;
      username: string;
      depth: number;
    };
  };
  "lead/funnel.enrich.requested": {
    data: {
      lead_id: string;
      external_link: string;
      crawl_job_id?: string | null;
    };
  };
  "lead/email.enrich.requested": {
    data: {
      lead_id: string;
      crawl_job_id?: string | null;
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
    };
  };
};

export const inngest = new Inngest({
  id: "leads-scraper-ig",
  schemas: new EventSchemas().fromRecord<Events>(),
});
