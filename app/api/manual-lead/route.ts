import { analyzeIgLead } from "@/lib/manual-lead/analyze";

const SECRET = process.env.MANUAL_LEAD_SECRET;

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (SECRET) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${SECRET}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  if (!body.url) {
    return Response.json({ ok: false, error: "url is required" }, { status: 400 });
  }

  const result = await analyzeIgLead(body.url);
  return Response.json(result, { status: result.ok ? 200 : 422 });
}
