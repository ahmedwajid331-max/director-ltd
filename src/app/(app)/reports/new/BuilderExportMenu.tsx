"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, FileSpreadsheet, FileText, FileType2, Loader2, Sheet, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { FilterGroupNode } from "@/lib/filters/types";
import type { SortableField } from "@/lib/data/companies";
import { filenameFrom, saveBlob } from "../[id]/ReportActionMenus";

export type ExportNotice = { kind: "ok" | "error"; text: string } | null;
type Kind = "xlsx" | "csv" | "pdf" | "docx";

const LABEL: Record<Kind, string> = { xlsx: "Excel", csv: "CSV", pdf: "PDF", docx: "Word" };
const ITEMS: { kind: Kind; ext: string; icon: LucideIcon; needs: "csv" | "docs"; hint: string }[] = [
  { kind: "xlsx", ext: ".xlsx", icon: FileSpreadsheet, needs: "csv", hint: "Spreadsheet of the matching companies (up to 50,000)" },
  { kind: "csv", ext: ".csv", icon: Sheet, needs: "csv", hint: "Every matching company, up to your export limit" },
  { kind: "pdf", ext: ".pdf", icon: FileText, needs: "docs", hint: "Formatted report of every matching company, up to your export limit" },
  { kind: "docx", ext: ".docx", icon: FileType2, needs: "docs", hint: "Editable Word table of every matching company, up to your export limit" },
];

const MENU_W = 176; // 11rem
const GAP = 4;
const EDGE = 8; // keep this far from the viewport edge
const ROW_H = 32;

// Where the menu goes: right edge aligned to the button, on whichever side has room (below preferred), never outside the
// viewport, and scrollable if even that side is short. It is positioned in viewport coordinates and rendered in a portal,
// so no overflow / scroll container around the button can clip it.
function place(button: HTMLElement, itemCount: number) {
  const r = button.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(EDGE, r.right - MENU_W), Math.max(EDGE, vw - MENU_W - EDGE));
  const below = vh - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;
  const needed = itemCount * ROW_H + 10;
  if (below >= needed || below >= above) return { left, top: r.bottom + GAP, maxHeight: Math.max(ROW_H * 2, below) };
  return { left, bottom: vh - r.top + GAP, maxHeight: Math.max(ROW_H * 2, above) };
}

// Export of the Report Builder's CURRENT results, without saving a report. It sends the conditions exactly as they stand
// on screen. CSV goes to the same streaming endpoint the saved report uses (/api/companies/export); Excel, PDF and Word go
// to /api/reports/export, which shares one implementation with the saved-report downloads. The server enforces access and
// row limits and refuses (never truncates) when a format cannot hold every matching company; its message is shown here.
export function BuilderExportMenu({
  filter,
  columns,
  sort,
  name,
  disabled,
  disabledReason,
  canCsv = true,
  canDocs = true,
  onNotice,
}: {
  filter: FilterGroupNode;
  columns: string[] | null;
  sort: { field: SortableField; dir: "asc" | "desc" };
  name: string;
  disabled: boolean;
  disabledReason?: string;
  // What the signed-in user may do. The server enforces the same rules; these only hide what would be refused.
  canCsv?: boolean;
  canDocs?: boolean;
  onNotice: (n: ExportNotice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<ReturnType<typeof place> | null>(null);
  const [busy, setBusy] = useState<Kind | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = ITEMS.filter((i) => (i.needs === "csv" ? canCsv : canDocs));

  // While open: close on outside click / Escape (Escape returns focus to the button), keep the menu glued to the button
  // when the page scrolls or the window resizes, and put the keyboard on the first item.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const reposition = () => buttonRef.current && setPos(place(buttonRef.current, items.length));
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, items.length]);

  function toggle() {
    if (open) return setOpen(false);
    if (buttonRef.current) setPos(place(buttonRef.current, items.length));
    setOpen(true);
  }

  function onMenuKey(e: React.KeyboardEvent) {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === "Home") buttons[0]?.focus();
    else if (e.key === "End") buttons[buttons.length - 1]?.focus();
    else if (e.key === "Tab") setOpen(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  }

  async function run(kind: Kind) {
    setOpen(false);
    setBusy(kind);
    onNotice(null);
    try {
      const res =
        kind === "csv"
          ? await fetch("/api/companies/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter, ...(columns ? { columns } : {}) }) })
          : await fetch("/api/reports/export", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ format: kind, filter, ...(columns ? { columns } : {}), sortField: sort.field, sortDir: sort.dir, ...(name.trim() ? { name: name.trim() } : {}) }),
            });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        onNotice({ kind: "error", text: data.error ?? `The ${LABEL[kind]} export failed (${res.status}).` });
        return;
      }
      // A large PDF / Word file streams: this resolves only when the whole file has arrived, and rejects if the server
      // aborted part-way - so "exported successfully" is never shown for an incomplete download.
      const blob = await res.blob();
      saveBlob(blob, filenameFrom(res, `director-ltd-export.${kind}`));
      onNotice({ kind: "ok", text: "Report exported successfully." });
    } catch {
      onNotice({ kind: "error", text: "The export could not be completed. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  if (!canCsv && !canDocs) return null;

  return (
    <div className="relative shrink-0">
      <Button
        ref={buttonRef}
        variant="outline"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        disabled={disabled || busy !== null}
        title={disabled ? disabledReason : "Export the matching companies without saving the report"}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {busy ? `Preparing ${LABEL[busy]}…` : "Export"}
        {!busy && <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />}
      </Button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Export results"
            onKeyDown={onMenuKey}
            style={{ position: "fixed", left: pos.left, top: "top" in pos ? pos.top : undefined, bottom: "bottom" in pos ? pos.bottom : undefined, width: MENU_W, maxHeight: pos.maxHeight }}
            className="z-50 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-md ring-1 ring-slate-900/5"
          >
            {items.map(({ kind, ext, icon: Icon, hint }) => (
              <button
                key={kind}
                role="menuitem"
                type="button"
                title={hint}
                aria-label={`${LABEL[kind]} (${ext})`}
                onClick={() => run(kind)}
                className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-slate-700 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:bg-indigo-50 focus-visible:text-indigo-700 focus-visible:outline-none"
              >
                <Icon className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-indigo-600 group-focus-visible:text-indigo-600" />
                {LABEL[kind]}
                <span className="ml-auto text-[11px] font-normal text-slate-400">{ext}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
