import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";

const LINKS = [
  { href: "#uk-data", label: "UK data" },
  { href: "#search", label: "Search" },
  { href: "#filters", label: "Filters" },
  { href: "#workflow", label: "Reports & CRM" },
  { href: "#api", label: "API" },
  { href: "#faq", label: "FAQ" },
];

// Two rows like a data-platform site: brand + actions, then the section navigation.
export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">DL</span>
          <span className="text-xl font-bold tracking-tight text-indigo-600">
            DIRECTOR<span className="text-indigo-900">.LTD</span>
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <LinkButton href="/login" size="md">
            Sign in
          </LinkButton>
          <LinkButton href="#uk-data" variant="outline" size="md" className="hidden sm:inline-flex">
            Explore UK data
          </LinkButton>
        </div>
      </div>
      <nav className="mx-auto hidden h-11 max-w-7xl items-center gap-9 px-6 md:flex" aria-label="Sections">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} className="text-[15px] font-semibold text-indigo-900 hover:text-indigo-600">
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
