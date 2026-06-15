"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { addLead } from "@/app/actions/leads";

export function AddLeadButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setDone(null);
  };

  const onSubmit = (formData: FormData) => {
    reset();
    start(async () => {
      const res = await addLead(formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      // Lead was saved; res.error here means "added but analysis couldn't start".
      if (res.error) setError(res.error);
      setDone(
        res.already_existed
          ? `@${res.username} is already in your leads.`
          : res.analyzing
            ? `Added @${res.username} — analyzing now…`
            : `Added @${res.username}.`,
      );
      router.refresh();
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" /> Add lead
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4">
        <form action={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="add-lead-input" className="text-sm font-medium">Add a lead manually</Label>
            <Input
              id="add-lead-input"
              name="input"
              autoFocus
              autoComplete="off"
              placeholder="@username  or  instagram.com/username"
              required
            />
            <p className="text-xs text-muted-foreground">Enter an Instagram username or profile URL.</p>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" name="analyze" defaultChecked className="h-4 w-4 rounded border-input" />
            Scrape &amp; score it right away
          </label>

          {error && (
            <p className="text-xs text-destructive flex items-start gap-1">
              <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
              {error}
            </p>
          )}
          {done && (
            <p className="text-xs text-green-600 flex items-start gap-1">
              <Check className="h-3 w-3 shrink-0 mt-0.5" />
              {done}
            </p>
          )}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Adding…
              </>
            ) : (
              "Add lead"
            )}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
