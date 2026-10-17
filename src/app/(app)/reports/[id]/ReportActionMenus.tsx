"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Download, FileText, FileType2, Link2, Loader2, Mail, Printer, Share2, Sheet, ClipboardList, Smartphone, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { SortableField } from "@/lib/data/companies";
import type { FilterGroupNode } from "@/lib/filters/types";
import { ACCESS_NOTE, canNativeShare, copyText, mailtoUrl, shareSummary, shareText, whatsappUrl } from "@/lib/reports/share";

// WhatsApp brand glyph (Simple Icons, CC0).
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="WhatsApp" className={className} fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

// Popover behaviour shared by both menus: toggle, close on outside click / Escape, return focus to the trigger.
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function MenuItem({ icon: Icon, iconNode, label, hint, onClick, href, disabled }: { icon?: LucideIcon; iconNode?: React.ReactNode; label: string; hint?: string; onClick?: () => void; href?: string; disabled?: boolean }) {
  const inner = (
    <>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-slate-500">{iconNode ?? (Icon ? <Icon className="h-4 w-4" /> : null)}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-slate-800">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-slate-500">{hint}</span>}
      </span>
    </>
  );
  const cls = "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
  return href ? (
    <a role="menuitem" href={href} {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})} onClick={onClick} className={cls}>
      {inner}
    </a>
  ) : (
    <button role="menuitem" type="button" onClick={onClick} disabled={disabled} className={cls}>
      {inner}
    </button>
  );
}

const panel = "absolute right-0 z-30 mt-1.5 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg";

export function filenameFrom(res: Response, fallback: string): string {
  const m = /filename="?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "");
  return m?.[1] ?? fallback;
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type Notice = { kind: "ok" | "error"; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role={notice.kind === "error" ? "alert" : "status"} className={cn("text-xs font-medium", notice.kind === "error" ? "text-red-600" : "text-emerald-700")}>
      {notice.text}
    </p>
  );
}

export function ReportActionMenus({
  reportId,
  reportName,
  filter,
  columns,
  sortField,
  sortDir,
  total,
  canShare = true,
  canCsv = true,
  canDocs = true,
}: {
  reportId: string;
  reportName: string;
  filter: FilterGroupNode;
  columns?: string[] | null;
  sortField: SortableField;
  sortDir: "asc" | "desc";
  total: number | null;
  // What the signed-in user may do. The server enforces the same rules; these only hide what would be refused.
  canShare?: boolean;
  canCsv?: boolean;
  canDocs?: boolean;
}) {
  const [notice, setNotice] = useState<Notice>(null);
  const flash = useCallback((n: Notice) => {
    setNotice(n);
    if (n?.kind === "ok") setTimeout(() => setNotice((cur) => (cur === n ? null : cur)), 4000);
  }, []);

  return (
    <div className="flex flex-col items-end gap-1.5 print:hidden">
      <div className="flex flex-wrap justify-end gap-2">
        {canShare && <ShareMenu reportId={reportId} reportName={reportName} total={total} flash={flash} />}
        <ExportMenu reportId={reportId} filter={filter} columns={columns} sortField={sortField} sortDir={sortDir} flash={flash} canCsv={canCsv} canDocs={canDocs} />
      </div>
      <NoticeLine notice={notice} />
    </div>
  );
}

function ExportMenu({ reportId, filter, columns, sortField, sortDir, flash, canCsv, canDocs }: { reportId: string; filter: FilterGroupNode; columns?: string[] | null; sortField: SortableField; sortDir: "asc" | "desc"; flash: (n: Notice) => void; canCsv: boolean; canDocs: boolean }) {
  const { open, setOpen, ref } = useMenu();
  const [busy, setBusy] = useState<null | "csv" | "pdf" | "docx">(null);

  async function run(kind: "csv" | "pdf" | "docx") {
    setOpen(false);
    setBusy(kind);
    flash(null);
    try {
      const res =
        kind === "csv"
          ? await fetch("/api/companies/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter, ...(columns ? { columns } : {}) }) })
          : await fetch(`/api/reports/${reportId}/export?format=${kind}&sortField=${sortField}&sortDir=${sortDir}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flash({ kind: "error", text: data.error ?? `The ${kind.toUpperCase()} export failed (${res.status}).` });
        return;
      }
      const name = filenameFrom(res, kind === "csv" ? `report-${reportId}.csv` : `report-${reportId}.${kind}`);
      saveBlob(await res.blob(), kind === "csv" ? `report-${reportId}.csv` : name);
      flash({ kind: "ok", text: `${kind === "csv" ? "CSV" : kind === "pdf" ? "PDF" : "Word document"} downloaded.` });
    } catch {
      flash({ kind: "error", text: "The download could not be completed. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button variant="outline" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={busy !== null}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {busy ? `Preparing ${busy === "docx" ? "Word" : busy.toUpperCase()}…` : "Export"}
        {!busy && <ChevronDown className="h-3.5 w-3.5" />}
      </Button>
      {open && (
        <div role="menu" aria-label="Export report" className={panel}>
          {canCsv && <MenuItem icon={Sheet} label="Export CSV (.csv)" hint="Every company in the report, with the report's columns." onClick={() => run("csv")} />}
          {canDocs && <MenuItem icon={FileText} label="Download PDF (.pdf)" hint="Formatted report, up to 5,000 companies." onClick={() => run("pdf")} />}
          {canDocs && <MenuItem icon={FileType2} label="Download Word Document (.docx)" hint="Editable table, up to 5,000 companies." onClick={() => run("docx")} />}
          {(canCsv || canDocs) && <div className="my-1 border-t border-slate-100" />}
          <MenuItem
            icon={Printer}
            label="Print Report"
            hint="Prints the rows currently on screen (this page of results)."
            onClick={() => {
              setOpen(false);
              setTimeout(() => window.print(), 50);
            }}
          />
        </div>
      )}
    </div>
  );
}

function ShareMenu({ reportId, reportName, total, flash }: { reportId: string; reportName: string; total: number | null; flash: (n: Notice) => void }) {
  const { open, setOpen, ref } = useMenu();
  const [native, setNative] = useState(false);
  const [copied, setCopied] = useState<null | "link" | "summary">(null);
  // Capability check after mount so server and client markup match.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time browser capability detection
    setNative(canNativeShare(navigator));
  }, []);

  // The canonical report address (no ?saved= banner parameter).
  const input = () => ({ title: reportName, total, url: `${window.location.origin}/reports/${reportId}` });

  // Fire-and-forget audit record; a failure must never get in the way of sharing.
  function record(method: "link" | "whatsapp" | "email" | "device" | "summary") {
    fetch(`/api/reports/${reportId}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method }), keepalive: true }).catch(() => undefined);
  }

  async function copy(kind: "link" | "summary") {
    const i = input();
    const ok = await copyText(kind === "link" ? i.url : shareText(i), navigator, document);
    if (ok) {
      record(kind);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
      flash({ kind: "ok", text: kind === "link" ? "Report link copied." : "Report summary copied." });
    } else {
      flash({ kind: "error", text: "Could not copy automatically. Select the address bar and copy the link manually." });
    }
    setOpen(false);
  }

  async function nativeShare() {
    setOpen(false);
    const i = input();
    try {
      await navigator.share({ title: `DIRECTOR.LTD report: ${i.title}`, text: shareSummary(i), url: i.url });
      record("device");
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") flash({ kind: "error", text: "Sharing was not possible on this device. Use Copy report link instead." });
    }
  }

  return (
    <div ref={ref} className="relative">
      <Button variant="outline" size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
        {copied ? "Copied" : "Share"}
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <div role="menu" aria-label="Share report" className={panel}>
          <MenuItem icon={Link2} label="Copy report link" onClick={() => copy("link")} />
          <MenuItem iconNode={<WhatsAppIcon className="h-4 w-4 text-[#25D366]" />} label="Share on WhatsApp" href={open ? whatsappUrl(input()) : undefined} onClick={() => { record("whatsapp"); setOpen(false); }} />
          <MenuItem icon={Mail} label="Share by Email" href={mailtoUrl(input())} onClick={() => { record("email"); setOpen(false); }} />
          {native && <MenuItem icon={Smartphone} label="Share via device…" hint="Use this device's share menu." onClick={nativeShare} />}
          <MenuItem icon={ClipboardList} label="Copy report summary" onClick={() => copy("summary")} />
          <p className="mx-1 mt-1 border-t border-slate-100 px-1.5 pt-2 pb-1 text-[11px] leading-snug text-slate-500">
            Not a public link. {ACCESS_NOTE} Others will be asked to sign in.
          </p>
        </div>
      )}
    </div>
  );
}
