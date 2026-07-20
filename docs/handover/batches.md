### 1. Expandable account rows (preview list) ✅

**Current behavior:**
Accounts on the leads handover page are not expandable — no way to 
preview which accounts are inside them.

**Current markup for the account row:**
<div class="flex items-center gap-3 px-3 py-2.5"><div class="flex-1 min-w-0"><div class="flex items-center gap-2"><span class="font-medium text-sm truncate">@dariusworkout</span><span class="text-xs text-muted-foreground tabular-nums">0/36 enriched</span></div><div class="mt-1.5 h-1 w-full max-w-xs rounded-full bg-muted overflow-hidden"><div class="h-full bg-emerald-500 transition-all" style="width: 0%;"></div></div></div><div class="flex items-center gap-1.5"><button class="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs">Batch 15</button></div></div>

**Desired behavior:**
- Each account row becomes expandable (click to open/collapse)
- Expanded view shows a preview list of the accounts it contains
- Preview only — no actions/interactions inside the preview 


---

### 2. "Batch 15" click → copy-to-clipboard confirmation ✅

**Current behavior:**
Clicking "batch 15" (or a batch item) does nothing really


**Current markup for the batch button:**
<button class="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs">Batch 15</button>

**Desired behavior:**
- Clicking a batch copies 15 leads to clipboard (name, iG url and bio)
- Show a confirmation toast/message, e.g. "Copied to clipboard"

---

### 3. New button: upload enriched leads (CSV) ✅

**Desired behavior:**
- Add a new button, separate from the batch-copy action
- Clicking it opens a file upload for CSV format
- Uploaded CSV = the enriched version of that batch's leads
- this button lives in the handover section right top corner
-  the data updates automatically according to what seed account it was from, then updates how far along that seed account is. 

---

### 4. Page lock during batch dispatch ✅

**Desired behavior:**
- When a batch is dispatched, the entire page becomes non-interactable 
  (disabled/greyed out) until the enriched batch is returned unless you want to copy the same one again
- the software tracks which leads went out and which came back, if all leads came back, it knows the batch was enriched and thus makes it interactable again