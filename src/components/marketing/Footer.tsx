import Link from "next/link";

const COLS: { title: string; links: [string, string][] }[] = [
  { title: "Platform", links: [["UK companies", "/companies"], ["Report builder", "/reports/new"], ["Saved reports", "/reports"], ["Calendar", "/calendar"]] },
  { title: "Your work", links: [["Watches", "/watches"], ["Saved", "/saved"], ["Red flags", "/red-flags"], ["Trash", "/trash"]] },
  { title: "On this page", links: [["UK data", "#uk-data"], ["Filters", "#filters"], ["Reports & CRM", "#workflow"], ["FAQ", "#faq"]] },
];

export function MarketingFooter() {
  return (
    <footer className="bg-indigo-950 text-blue-100">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sm font-bold text-indigo-900">DL</span>
            <span className="text-xl font-bold text-white">DIRECTOR.LTD</span>
          </div>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-blue-200">UK company intelligence built on Companies House data: search, reports, CRM and daily updates.</p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="text-xs font-semibold uppercase tracking-widest text-blue-300">{c.title}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {c.links.map(([label, href]) => (
                <li key={label}>
                  {href.startsWith("#") ? (
                    <a href={href} className="hover:text-white">{label}</a>
                  ) : (
                    <Link href={href} className="hover:text-white">{label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-6 py-5 text-xs text-blue-300 sm:flex-row">
          <p>© {new Date().getFullYear()} DIRECTOR.LTD. Contains public sector information from Companies House, licensed under the Open Government Licence.</p>
          <Link href="/login" className="font-semibold text-white hover:underline">Sign in →</Link>
        </div>
      </div>
    </footer>
  );
}
