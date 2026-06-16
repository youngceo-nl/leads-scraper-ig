"use client";
import { useRef, useState, useTransition } from "react";
import { Download, X, ChevronRight, Check, AlertCircle, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { importLeadsFromCsv, type CsvImportRow } from "@/app/actions/leads";

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const parsed: string[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        row.push(field.trim());
        field = "";
      } else {
        field += ch;
      }
    }
    row.push(field.trim());
    parsed.push(row);
  }
  const headers = parsed[0] ?? [];
  return { headers, rows: parsed.slice(1).filter(r => r.some(c => c)) };
}

// ─── Field definitions ────────────────────────────────────────────────────────

type FieldKey = keyof CsvImportRow;

const FIELDS: { key: FieldKey; label: string; hint: string; required?: true }[] = [
  { key: "username",    label: "Instagram username", hint: "Handle without @, e.g. johndoe", required: true },
  { key: "profile_url", label: "Instagram profile URL", hint: "Alternative to username — we'll extract it" },
  { key: "full_name",   label: "Full name",          hint: "Display name on the profile" },
  { key: "email",       label: "Email",              hint: "Contact email address" },
  { key: "followers",   label: "Followers",          hint: "Follower count (number)" },
  { key: "bio",         label: "Bio",                hint: "Profile biography text" },
  { key: "niche",       label: "Niche / category",   hint: "e.g. fitness coach, course creator" },
  { key: "youtube_url", label: "YouTube URL",        hint: "Link to their YouTube channel" },
  { key: "linkedin_url",label: "LinkedIn URL",       hint: "Link to their LinkedIn profile" },
];

// Common aliases for auto-detection
const ALIASES: Record<FieldKey, string[]> = {
  username:    ["username", "handle", "instagram", "ig", "ig_username", "instagram_handle", "user"],
  profile_url: ["url", "link", "profile", "profile url", "profile_url", "instagram url", "instagram_url"],
  full_name:   ["name", "full name", "full_name", "fullname", "display name"],
  email:       ["email", "email address", "mail", "e-mail", "email_address"],
  followers:   ["followers", "follower count", "followers_count", "follower_count"],
  bio:         ["bio", "biography", "description", "about"],
  niche:       ["niche", "category", "type", "industry"],
  youtube_url: ["youtube", "youtube url", "youtube_url", "yt", "yt_url"],
  linkedin_url:["linkedin", "linkedin url", "linkedin_url", "li", "li_url"],
};

function autoDetect(headers: string[]): Record<FieldKey, string> {
  const mapping: Record<string, string> = {};
  for (const field of FIELDS) {
    const aliases = ALIASES[field.key].map(a => a.toLowerCase());
    const match = headers.find(h => aliases.includes(h.toLowerCase()));
    if (match) mapping[field.key] = match;
  }
  return mapping as Record<FieldKey, string>;
}

const SKIP = "— skip —";

// ─── Component ────────────────────────────────────────────────────────────────

type Step = "upload" | "map" | "done";

export function CsvImportButton({
  open: controlledOpen,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => { setInternalOpen(v); onOpenChange?.(v); };
  const [step, setStep] = useState<Step>("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<FieldKey, string>>>({});
  const [result, setResult] = useState<{ imported: number; skipped: number; error?: string } | null>(null);
  const [importing, startImport] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const reset = () => {
    setStep("upload");
    setHeaders([]);
    setRows([]);
    setMapping({});
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const close = () => { setOpen(false); setTimeout(reset, 300); };

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".csv")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: h, rows: r } = parseCSV(text);
      setHeaders(h);
      setRows(r);
      setMapping(autoDetect(h));
      setStep("map");
    };
    reader.readAsText(file);
  };

  const handleImport = () => {
    // Build rows from mapping
    const importRows: CsvImportRow[] = rows.map(row => {
      const obj: CsvImportRow = {};
      for (const field of FIELDS) {
        const col = mapping[field.key];
        if (!col || col === SKIP) continue;
        const idx = headers.indexOf(col);
        if (idx === -1) continue;
        (obj as Record<string, string>)[field.key] = row[idx] ?? "";
      }
      return obj;
    });

    startImport(async () => {
      const res = await importLeadsFromCsv(importRows);
      setResult({ imported: res.imported, skipped: res.skipped, error: res.error });
      setStep("done");
    });
  };

  const canImport = FIELDS.filter(f => f.required).every(f => {
    const usernameCol = mapping.username && mapping.username !== SKIP;
    const profileUrlCol = mapping.profile_url && mapping.profile_url !== SKIP;
    return usernameCol || profileUrlCol;
  });

  const preview = rows.slice(0, 3);

  return (
    <>
      {controlledOpen === undefined && (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          <Download className="h-4 w-4 mr-2" />
          Import CSV
        </Button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" onClick={close} />

          {/* Modal */}
          <div className="relative z-10 bg-background rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <div>
                <h2 className="text-lg font-semibold">Import leads from CSV</h2>
                <p className="text-sm text-muted-foreground">
                  {step === "upload" && "Upload a CSV file with Instagram accounts"}
                  {step === "map" && `${rows.length} rows found — map your columns below`}
                  {step === "done" && "Import complete"}
                </p>
              </div>
              <button onClick={close} className="text-muted-foreground hover:text-foreground p-1 rounded">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 px-6 py-5">

              {/* ── Step 1: Upload ── */}
              {step === "upload" && (
                <div
                  className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer
                    ${dragOver ? "border-primary bg-primary/5" : "border-input hover:border-primary/50"}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files[0];
                    if (file) handleFile(file);
                  }}
                >
                  <FileText className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                  <p className="font-medium text-sm mb-1">Drop a CSV file here, or click to browse</p>
                  <p className="text-xs text-muted-foreground">Must be a .csv file. First row must be column headers.</p>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                  />
                </div>
              )}

              {/* ── Step 2: Map columns ── */}
              {step === "map" && (
                <div className="space-y-5">
                  {/* Mapping table */}
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-muted/50 text-xs text-muted-foreground uppercase tracking-wide">
                          <th className="text-left px-4 py-2 font-medium w-48">Our field</th>
                          <th className="text-left px-4 py-2 font-medium">Your column</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {FIELDS.map(field => (
                          <tr key={field.key} className="hover:bg-muted/30">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium">{field.label}</span>
                                {field.required && <span className="text-[10px] text-destructive font-semibold">REQ*</span>}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">{field.hint}</p>
                            </td>
                            <td className="px-4 py-2.5">
                              <select
                                value={mapping[field.key] ?? SKIP}
                                onChange={e => setMapping(prev => ({ ...prev, [field.key]: e.target.value }))}
                                className="w-full h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
                              >
                                <option value={SKIP}>{SKIP}</option>
                                {headers.map(h => (
                                  <option key={h} value={h}>{h}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Preview */}
                  {preview.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">Preview (first {preview.length} rows)</p>
                      <div className="overflow-x-auto rounded-lg border">
                        <table className="text-xs w-max min-w-full">
                          <thead>
                            <tr className="bg-muted/50 text-muted-foreground">
                              {headers.map(h => (
                                <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y">
                            {preview.map((row, i) => (
                              <tr key={i} className="hover:bg-muted/20">
                                {headers.map((_, j) => (
                                  <td key={j} className="px-3 py-1.5 max-w-[180px] truncate">{row[j] ?? ""}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {!canImport && (
                    <p className="text-xs text-amber-600 flex items-center gap-1">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      Map either <strong>Instagram username</strong> or <strong>Instagram profile URL</strong> to continue.
                    </p>
                  )}
                </div>
              )}

              {/* ── Step 3: Done ── */}
              {step === "done" && result && (
                <div className="text-center py-8 space-y-3">
                  {result.error ? (
                    <>
                      <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
                      <p className="font-medium text-destructive">Import failed</p>
                      <p className="text-sm text-muted-foreground">{result.error}</p>
                    </>
                  ) : (
                    <>
                      <Check className="h-12 w-12 text-green-500 mx-auto" />
                      <p className="text-2xl font-semibold">{result.imported} leads imported</p>
                      {result.skipped > 0 && (
                        <p className="text-sm text-muted-foreground">{result.skipped} rows skipped — no valid username found or already in your leads.</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-2">Leads are in <strong>Pending</strong> status — use Analyze to score them.</p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t shrink-0">
              <Button variant="ghost" size="sm" onClick={step === "upload" ? close : reset}>
                {step === "upload" ? "Cancel" : "← Start over"}
              </Button>
              <div className="flex items-center gap-2">
                {step === "map" && (
                  <Button onClick={handleImport} disabled={!canImport || importing}>
                    {importing ? "Importing…" : (
                      <><ChevronRight className="h-4 w-4 mr-1" />Import {rows.length} rows</>
                    )}
                  </Button>
                )}
                {step === "done" && (
                  <Button onClick={close}>
                    <Check className="h-4 w-4 mr-1" /> Done
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
