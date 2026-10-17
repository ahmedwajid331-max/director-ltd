// Share helpers for the saved-report page. Pure, so the URL encoding is unit-tested.
//
// Privacy: a report link is NOT public. It opens only for signed-in users allowed to see the report (its owner and
// admins) - everyone else gets the login page or "not found". The message therefore carries only the report name, its
// matching-company count and the link: never company rows, filter values, or any credential.

export interface ShareInput {
  title: string;
  total: number | null;
  url: string;
}

export const ACCESS_NOTE = "Opens only for signed-in users who are allowed to see this report (its owner and admins).";

export function shareSummary({ title, total }: Pick<ShareInput, "title" | "total">): string {
  const count = total === null ? "" : ` - ${total.toLocaleString("en-GB")} ${total === 1 ? "company" : "companies"}`;
  return `DIRECTOR.LTD report "${title}"${count}`;
}

export function shareText(input: ShareInput): string {
  return `${shareSummary(input)}\n${input.url}\n(Sign-in required to view.)`;
}

export function whatsappUrl(input: ShareInput): string {
  return `https://wa.me/?text=${encodeURIComponent(shareText(input))}`;
}

export function mailtoUrl(input: ShareInput): string {
  const subject = `DIRECTOR.LTD report: ${input.title}`;
  const body = `Hi,\n\nI'd like to share this DIRECTOR.LTD report with you.\n\n${shareSummary(input)}\n${input.url}\n\nYou need to be signed in to DIRECTOR.LTD, with access to the report, to open it.`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function canNativeShare(nav: { share?: unknown } | undefined | null): boolean {
  return !!nav && typeof nav.share === "function";
}

// Clipboard with a fallback for insecure contexts / denied permission. Resolves false when nothing worked.
export async function copyText(text: string, nav: { clipboard?: { writeText?: (t: string) => Promise<void> } } | undefined, doc?: Document): Promise<boolean> {
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    if (!doc) return false;
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand("copy");
    doc.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
