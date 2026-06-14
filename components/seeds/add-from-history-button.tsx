"use client";
import { useTransition, useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addSeed, startCrawl, type ScrapeProvider } from "@/app/actions/seeds";

const PROVIDER_OPTIONS: { value: ScrapeProvider; label: string }[] = [
  { value: "auto",        label: "Auto (best available)" },
  { value: "cookie",      label: "Cookie only (free)" },
  { value: "proxy",       label: "Cookie + IP rotation" },
  { value: "apify",       label: "Apify" },
  { value: "scrapingbee", label: "ScrapingBee" },
];

export function ScrapeFromHistoryButton({
  username,
  seedId,
  defaultLimit,
}: {
  username: string;
  seedId?: string;
  defaultLimit: number;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [provider, setProvider] = useState<ScrapeProvider>("auto");
  const [limit, setLimit] = useState<string>("");

  const handleScrape = () =>
    start(async () => {
      let id = seedId;

      if (!id) {
        const fd = new FormData();
        fd.append("input", username);
        if (limit) fd.append("max_profiles_to_scrape", limit);
        const res = await addSeed(fd);
        if ("error" in res && res.error) { setMsg(`Error: ${res.error}`); return; }
        const { createClient } = await import("@/lib/supabase/client");
        const sb = createClient();
        const { data } = await sb.from("seeds").select("id").eq("username", username).single();
        if (!data?.id) { setMsg("Could not find seed after adding."); return; }
        id = data.id;
      }

      const res = await startCrawl(id!, provider);
      if ("error" in res && res.error) setMsg(`Error: ${res.error}`);
      else setMsg(`Search started (${provider}).`);
    });

  if (msg) return <span className="text-xs text-muted-foreground">{msg}</span>;

  return (
    <div className="flex items-center gap-2 justify-end">
      <Input
        type="number"
        min={1}
        value={limit}
        onChange={(e) => setLimit(e.target.value)}
        placeholder={`default ${defaultLimit}`}
        className="w-36 h-8 text-xs"
        aria-label="How many accounts to check"
      />
      <select
        value={provider}
        onChange={(e) => setProvider(e.target.value as ScrapeProvider)}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-sm"
        aria-label="Scrape method"
      >
        {PROVIDER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <Button size="sm" variant="secondary" disabled={pending} onClick={handleScrape}>
        <Play className="h-3 w-3 mr-1.5" />
        {pending ? "Starting…" : "Start search"}
      </Button>
    </div>
  );
}
