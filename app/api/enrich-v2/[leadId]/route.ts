import { createClient } from "@/lib/supabase/server";
import { enrichPipelineV2 } from "@/lib/pipeline/enrich-pipeline-v2";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await ctx.params;

  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ type: "result", ok: false, error: "unauthorized" }) + "\n", {
      status: 401,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await enrichPipelineV2({
          leadId,
          force: true,
          onStep: (ev) => send({ type: "step", ...ev }),
        });
        send({ type: "result", ...result });
      } catch (err) {
        send({
          type: "result",
          ok: false,
          email: null,
          email_status: "error",
          error: "Something went wrong. Please try again.",
          detail: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
