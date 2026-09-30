import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";

const LINKS = [
  { href: "#platform", label: "Platform" },
  { href: "#filters", label: "Filters" },
  { href: "#reports", label: "Reports" },
  { href: "#crm", label: "CRM" },
];

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            DL
          </div>
          <span className="text-base font-semibold text-slate-900">DIRECTOR.LTD</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <LinkButton href="/login" variant="ghost" size="sm">
            Sign in
          </LinkButton>
          <LinkButton href="/login" size="sm">
            Get access
          </LinkButton>
        </div>
      </div>
    </header>
  );
}
