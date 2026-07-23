"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ColumnMapping, DetectedColumns } from "@/lib/handover/format";

const NONE = "__none__";

/**
 * Shown when a returned Clay CSV's identifying or email column couldn't be
 * confidently recognized from its header name — asks the operator which real
 * column is which, rather than silently treating an unrecognized column as
 * absent (which is indistinguishable from "Clay genuinely found nothing" and
 * is exactly how a whole batch of found emails went missing once already).
 *
 * Purely presentational: all state (open/closed, the CSV text being held)
 * lives in the caller.
 */
export function ColumnMappingDialog({
  headers,
  detected,
  onConfirm,
  onCancel,
}: {
  headers: string[];
  detected: DetectedColumns;
  onConfirm: (mapping: ColumnMapping) => void;
  onCancel: () => void;
}) {
  // Falls back to the first header only if nothing was detected — better than
  // an empty required field the operator has to notice and fill themselves.
  const [username, setUsername] = useState(detected.username ?? headers[0] ?? "");
  const [email, setEmail] = useState(detected.email ?? NONE);
  const [badReason, setBadReason] = useState(detected.badReason ?? NONE);

  const confirm = () => {
    if (!username) return;
    onConfirm({
      username,
      email: email === NONE ? null : email,
      badReason: badReason === NONE ? null : badReason,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="absolute inset-0 bg-black/40" />

      <div className="relative z-10 bg-background border rounded-lg shadow-xl w-full max-w-md mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Match columns</h2>
          <button type="button" onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          This file&apos;s columns don&apos;t match what we expect. Pick which one is which —
          nothing is imported until you confirm.
        </p>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Identifying column (profile URL or username)</Label>
            <select
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
            >
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Email column</Label>
            <select
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
            >
              <option value={NONE}>— none, not in this file —</option>
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Bad-lead reason column</Label>
            <select
              value={badReason}
              onChange={(e) => setBadReason(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
            >
              <option value={NONE}>— none, not in this file —</option>
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={!username} onClick={confirm}>Import with this mapping</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
