"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Link2, Mail, Share2 } from "lucide-react";
import { cn } from "@/lib/cn";

// Official WhatsApp / LinkedIn glyphs (Simple Icons paths), inline so no dependency is needed.
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="#25D366">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="#0A66C2">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

const item = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 focus-ring";

export function ShareMenu({ companyId, companyName, buttonClassName }: { companyId: string; companyName: string; buttonClassName: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Always the plain company page (no tab / query), whichever tab is open.
  const url = () => `${window.location.origin}/companies/${companyId}`;
  const message = () => `${companyName} on DIRECTOR.LTD`;

  function openExternal(href: string) {
    window.open(href, "_blank", "noopener,noreferrer");
    setOpen(false);
  }

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(url());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setOpen(false);
    } catch {
      setError("Could not copy the link.");
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: companyName, text: message(), url: url() });
      setOpen(false);
    } catch (err) {
      // Dismissing the system sheet is not an error.
      if (!(err instanceof DOMException && err.name === "AbortError")) setError("Could not open the share sheet.");
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          setError(null);
          // navigator.share only exists in some browsers; checked when the menu opens (never during render).
          setCanNativeShare(typeof navigator.share === "function");
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Share this company. It opens only for signed-in users; your notes, contacts and follow-ups stay private to you."
        className={buttonClassName}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Share2 className="h-3.5 w-3.5" />}
        {copied ? "Link copied" : "Share"}
      </button>
      {open && (
        <div role="menu" aria-label="Share company" className={cn("absolute left-0 z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white p-1 shadow-lg")}>
          <button role="menuitem" type="button" onClick={copy} className={item}>
            <Link2 className="h-4 w-4 text-slate-500" /> Copy link
          </button>
          <button role="menuitem" type="button" onClick={() => openExternal(`https://wa.me/?text=${encodeURIComponent(`${message()}\n${url()}`)}`)} className={item}>
            <WhatsAppIcon className="h-4 w-4" /> WhatsApp
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              // mailto opens the default mail app in this tab's context without navigating the page away.
              window.location.href = `mailto:?subject=${encodeURIComponent(`${companyName} - DIRECTOR.LTD`)}&body=${encodeURIComponent(`${companyName}\n${url()}`)}`;
              setOpen(false);
            }}
            className={item}
          >
            <Mail className="h-4 w-4 text-slate-500" /> Email
          </button>
          <button role="menuitem" type="button" onClick={() => openExternal(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url())}`)} className={item}>
            <LinkedInIcon className="h-4 w-4" /> LinkedIn
          </button>
          {canNativeShare && (
            <button role="menuitem" type="button" onClick={nativeShare} className={item}>
              <Share2 className="h-4 w-4 text-slate-500" /> More options…
            </button>
          )}
          {error && <p role="alert" className="px-2.5 py-1 text-[11px] font-medium text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
