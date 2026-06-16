"use client";
import { useRef, useState, useEffect } from "react";
import { Bold, Italic, List, Eye, EyeOff } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

// Mirrors textToHtml for live preview (no server import needed).
function renderPreview(text: string): string {
  const blocks = text.split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^[-*]\s/.test(l.trimStart()))) {
      const items = lines.map((l) => {
        const content = l.replace(/^[-*]\s/, "").trim();
        return `<li>${inlineMd(esc(content))}</li>`;
      });
      return `<ul style="margin:0 0 0.75em 1.2em;padding:0">${items.join("")}</ul>`;
    }
    const inner = lines.map((l) => inlineMd(esc(l))).join("<br />");
    return `<p style="margin:0 0 0.75em 0">${inner}</p>`;
  }).join("\n");
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

// Returns the new body value and the new cursor positions after wrapping.
function computeWrap(
  val: string,
  selStart: number,
  selEnd: number,
  before: string,
  after: string,
): { value: string; start: number; end: number } {
  const selected = val.slice(selStart, selEnd) || "text";
  const next = val.slice(0, selStart) + before + selected + after + val.slice(selEnd);
  return { value: next, start: selStart + before.length, end: selStart + before.length + selected.length };
}

function computeBullet(
  val: string,
  selStart: number,
  selEnd: number,
): { value: string; start: number; end: number } {
  const lineStart = val.lastIndexOf("\n", selStart - 1) + 1;
  const rawEnd = val.indexOf("\n", selEnd);
  const lineEnd = rawEnd === -1 ? val.length : rawEnd;
  const segment = val.slice(lineStart, lineEnd);
  const lines = segment.split("\n");
  const allBulleted = lines.every((l) => /^[-*] /.test(l));
  const toggled = lines
    .map((l) => (allBulleted ? l.replace(/^[-*] /, "") : `- ${l}`))
    .join("\n");
  const next = val.slice(0, lineStart) + toggled + val.slice(lineEnd);
  return { value: next, start: lineStart, end: lineStart + toggled.length };
}

export function BodyEditor({
  name,
  defaultValue,
  rows = 10,
}: {
  name: string;
  defaultValue: string;
  rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [preview, setPreview] = useState(false);
  // After a programmatic value update we need to restore selection.
  const pendingCursor = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (pendingCursor.current && ref.current) {
      ref.current.selectionStart = pendingCursor.current.start;
      ref.current.selectionEnd = pendingCursor.current.end;
      pendingCursor.current = null;
    }
  });

  const applyFormat = (compute: (val: string, s: number, e: number) => { value: string; start: number; end: number }) => {
    const el = ref.current;
    if (!el) return;
    const result = compute(value, el.selectionStart, el.selectionEnd);
    pendingCursor.current = { start: result.start, end: result.end };
    setValue(result.value);
    el.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "b") {
      e.preventDefault();
      applyFormat((v, s, end) => computeWrap(v, s, end, "**", "**"));
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "i") {
      e.preventDefault();
      applyFormat((v, s, end) => computeWrap(v, s, end, "*", "*"));
    }
  };

  return (
    <div className="space-y-0">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 rounded-t-md border border-b-0 bg-muted/40 px-1.5 py-1">
        <ToolbarBtn label="Bold (⌘B)" onClick={() => applyFormat((v, s, e) => computeWrap(v, s, e, "**", "**"))}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn label="Italic (⌘I)" onClick={() => applyFormat((v, s, e) => computeWrap(v, s, e, "*", "*"))}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <ToolbarBtn label="Bullet list" onClick={() => applyFormat((v, s, e) => computeBullet(v, s, e))}>
          <List className="h-3.5 w-3.5" />
        </ToolbarBtn>
        <div className="ml-auto">
          <ToolbarBtn label={preview ? "Edit" : "Preview"} onClick={() => setPreview((v) => !v)} active={preview}>
            {preview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </ToolbarBtn>
        </div>
      </div>

      {preview ? (
        <>
          {/* Hidden textarea still in DOM so FormData picks it up */}
          <textarea name={name} value={value} onChange={() => {}} className="sr-only" aria-hidden />
          <div
            className="min-h-[220px] rounded-b-md border px-3 py-2.5 text-sm bg-background leading-relaxed"
            dangerouslySetInnerHTML={{
              __html: renderPreview(value) || "<em style='color:#888'>Nothing to preview yet</em>",
            }}
          />
        </>
      ) : (
        <Textarea
          ref={ref}
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={rows}
          className="rounded-t-none font-mono text-sm resize-y"
          spellCheck
        />
      )}

      <p className="text-xs text-muted-foreground pt-1.5">
        <strong>**bold**</strong> · <em>*italic*</em> · <code>- item</code> for bullets · <kbd>⌘B</kbd>/<kbd>⌘I</kbd> shortcuts
      </p>
    </div>
  );
}

function ToolbarBtn({
  children, label, onClick, active,
}: {
  children: React.ReactNode; label: string; onClick: () => void; active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`h-7 w-7 flex items-center justify-center rounded transition-colors hover:bg-muted ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
