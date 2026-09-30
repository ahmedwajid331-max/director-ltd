import Link from "next/link";

export function MarketingFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-xs font-bold text-white">
              DL
            </div>
            <span className="text-sm font-semibold text-slate-900">DIRECTOR.LTD</span>
          </div>
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} DIRECTOR.LTD. Companies House data platform.
          </p>
          <Link href="/login" className="text-xs font-medium text-indigo-600 hover:text-indigo-700">
            Sign in →
          </Link>
        </div>
      </div>
    </footer>
  );
}
