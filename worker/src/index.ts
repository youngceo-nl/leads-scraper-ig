import { createSupabase } from "./supabase";
import { claimJob } from "./jobs/claimJob";
import { updateJob } from "./jobs/updateJob";
import { logJobEvent } from "./jobs/logJobEvent";
import { processJob } from "./processJob";
import { config } from "./config";
import { logger } from "./utils/logger";

const sb = createSupabase();
let shuttingDown = false;

process.on("SIGINT", () => (shuttingDown = true));
process.on("SIGTERM", () => (shuttingDown = true));

async function tick(): Promise<boolean> {
  const job = await claimJob(sb);
  if (!job) return false;

  try {
    await processJob(sb, job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`job ${job.id} failed`, { message });
    await logJobEvent(sb, job.id, "failed", message);
    await updateJob(sb, job.id, {
      status: "failed",
      error_message: message,
      attempt_count: job.attempt_count + 1,
    });
  }
  return true;
}

async function main() {
  logger.info("outreach-video worker starting", { pollIntervalMs: config.pollIntervalMs });
  while (!shuttingDown) {
    const processed = await tick();
    if (!processed) await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
  logger.info("worker shut down");
}

main().catch((err) => {
  logger.error("worker crashed", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
