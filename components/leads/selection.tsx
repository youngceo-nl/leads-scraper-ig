"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Trash2, Loader2, AlertCircle, Mail, Check } from "lucide-react";
import { deleteLeads } from "@/app/actions/leads";
import { enrichLeadsBulk } from "@/app/actions/enrich";

type Ctx = {
  allIds: string[];
  selected: Set<string>;
  toggle: (id: string) => void;
  toggleAll: () => void;
  clear: () => void;
};

const SelectionContext = createContext<Ctx>({
  allIds: [],
  selected: new Set(),
  toggle: () => {},
  toggleAll: () => {},
  clear: () => {},
});

export function SelectionProvider({
  allIds,
  children,
}: {
  allIds: string[];
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // When the page of leads changes (navigation, post-delete refresh), drop any
  // selected ids that are no longer present so the toolbar count stays honest.
  const key = allIds.join(",");
  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(allIds);
      const next = new Set<string>();
      for (const id of prev) if (present.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => (prev.size === allIds.length ? new Set() : new Set(allIds)));

  const clear = () => setSelected(new Set());

  const value = useMemo(
    () => ({ allIds, selected, toggle, toggleAll, clear }),
    [allIds, selected],
  );

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function SelectAllCheckbox() {
  const { allIds, selected, toggleAll } = useContext(SelectionContext);
  const ref = useRef<HTMLInputElement>(null);
  const all = allIds.length > 0 && selected.size === allIds.length;
  const some = selected.size > 0 && !all;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
      checked={all}
      onChange={toggleAll}
      disabled={allIds.length === 0}
      aria-label="Select all leads on this page"
    />
  );
}

export function LeadCheckbox({ id }: { id: string }) {
  const { selected, toggle } = useContext(SelectionContext);
  return (
    <input
      type="checkbox"
      className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
      checked={selected.has(id)}
      onChange={() => toggle(id)}
      aria-label="Select lead"
    />
  );
}

export function BulkDeleteBar() {
  const { selected, clear } = useContext(SelectionContext);
  const [pending, start] = useTransition();
  const [enriching, startEnrich] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();
  const count = selected.size;

  if (count === 0) return null;

  const onEnrich = () => {
    const ids = [...selected];
    setError(null);
    setNotice(null);
    startEnrich(async () => {
      const r = await enrichLeadsBulk(ids);
      if (r.ok) {
        setNotice(`Queued ${r.queued} — emails will appear as they're found. Refresh in a bit.`);
        router.refresh();
      } else {
        setError(r.error ?? "couldn't queue");
      }
    });
  };

  const onDelete = () => {
    const ids = [...selected];
    const ok = window.confirm(
      `Delete ${ids.length} lead${ids.length === 1 ? "" : "s"}? ` +
        `They'll be added to your exclusion list so the scraper won't re-add them.`,
    );
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await deleteLeads(ids);
      if (r.ok) {
        clear();
        router.refresh();
      } else {
        setError(r.error ?? "delete failed");
      }
    });
  };

  return (
    <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
      <span className="text-sm font-medium tabular-nums">
        {count} selected
      </span>
      <Button variant="default" size="sm" onClick={onEnrich} disabled={enriching || pending}>
        {enriching ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : (
          <Mail className="h-3.5 w-3.5 mr-1.5" />
        )}
        {enriching ? "Queuing…" : "Find emails"}
      </Button>
      <Button variant="destructive" size="sm" onClick={onDelete} disabled={pending || enriching}>
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
        )}
        {pending ? "Deleting…" : "Delete selected"}
      </Button>
      <Button variant="ghost" size="sm" onClick={clear} disabled={pending || enriching}>
        Clear
      </Button>
      {notice && (
        <span className="inline-flex items-center gap-1 text-xs text-green-600">
          <Check className="h-3.5 w-3.5" /> {notice}
        </span>
      )}
      {error && (
        <span className="inline-flex items-center gap-1 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </span>
      )}
    </div>
  );
}
