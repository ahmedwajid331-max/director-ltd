import {
  Search,
  SlidersHorizontal,
  FileSpreadsheet,
  Star,
  BellRing,
  ShieldCheck,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { MarketingHeader } from "@/components/marketing/Header";
import { MarketingFooter } from "@/components/marketing/Footer";
import { db } from "@/lib/db";
import { REAL_COMPANIES_WHERE } from "@/lib/data/scope";
import { REGISTER_SIZE_ESTIMATE } from "@/lib/jobs/display";

// Without this, Next statically prerenders the landing page at build time
// and bakes in whatever the company count was then — silently defeating
// the point of making these numbers real. Revalidate frequently instead.
export const revalidate = 60;

const CAPABILITIES = [
  {
    icon: Search,
    title: "Full Companies House search",
    description:
      "Search Companies House company data by name, company number, postcode, SIC code or address. Coverage grows as the register is loaded — the live figure is shown below.",
  },
  {
    icon: SlidersHorizontal,
    title: "Any permutation of filters",
    description:
      "Combine DS01 filings, dormancy, age, postcode, director count and filing status into a single query — no limits on combinations.",
  },
  {
    icon: FileSpreadsheet,
    title: "Reports that refresh daily",
    description:
      "Save a filter as a report once. Results update automatically each day, and export to CSV or print in one click.",
  },
  {
    icon: Star,
    title: "Built-in CRM",
    description:
      "Follow companies, add notes and director contact details, and manage leads without leaving the results table.",
  },
  {
    icon: BellRing,
    title: "Follow-ups & calendar",
    description: "Set chasing reminders and follow-up dates, and see everything due on a shared calendar.",
  },
  {
    icon: ShieldCheck,
    title: "Super Admin oversight",
    description: "Create and manage users, control access, and review every search and report across your team.",
  },
];

const WORKFLOW = [
  "Sign in",
  "Search or build a filter",
  "Review results instantly",
  "Save the report",
  "Export, follow up, close",
];

export default async function Home() {
  // Real numbers, not marketing copy — this is the same query Settings
  // uses, so the landing page can never claim more than what's actually
  // ingested. See src/app/(app)/settings for the full breakdown.
  const realCompanies = await db.company.count({ where: REAL_COMPANIES_WHERE });
  const isLive = realCompanies > 0;
  const pct = (realCompanies / REGISTER_SIZE_ESTIMATE) * 100;

  const stats = [
    { value: realCompanies.toLocaleString(), label: "Real Companies House companies loaded" },
    { value: pct === 0 ? "0%" : pct < 0.01 ? "<0.01%" : `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`, label: "Of the register loaded (approx.)" },
    { value: "Daily", label: "Scheduled report refresh" },
    { value: "Stream", label: "Live DS01 filing feed" },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto max-w-7xl px-6 pb-16 pt-20 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600">
              <span className={`h-1.5 w-1.5 rounded-full ${isLive ? "bg-emerald-500" : "bg-amber-500"}`} />
              {isLive ? `${realCompanies.toLocaleString()} real Companies House companies loaded` : "Running on development data"}
            </div>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Search, filter and monitor every UK company —{" "}
              <span className="text-indigo-600">in one platform.</span>
            </h1>
            <p className="mt-5 text-lg text-slate-600">
              DIRECTOR.LTD turns the full Companies House dataset into filterable reports and a working sales
              pipeline, so your team can find the right companies and act on them the same day.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <LinkButton href="/login" size="lg">
                Sign in to the platform
                <ArrowRight className="h-4 w-4" />
              </LinkButton>
              <LinkButton href="#platform" variant="outline" size="lg">
                See how it works
              </LinkButton>
            </div>
          </div>

          {/* Product preview */}
          <div className="mx-auto mt-16 max-w-5xl rounded-2xl border border-slate-200 bg-slate-50 p-2 shadow-xl shadow-slate-200/50">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
              </div>
              <div className="grid grid-cols-4 gap-3 p-5 text-left">
                {stats.map((stat) => (
                  <div key={stat.label} className="rounded-lg border border-slate-100 px-3 py-3">
                    <div className="text-lg font-semibold text-slate-900">{stat.value}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="platform" className="border-t border-slate-100 bg-slate-50/60 py-20">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-semibold text-slate-900">Everything you need to work the register</h2>
              <p className="mt-3 text-slate-600">
                One platform for data, filtering, reporting and follow-up — designed for company formation agents,
                accountants and sales teams.
              </p>
            </div>

            <div id="filters" className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map(({ icon: Icon, title, description }) => (
                <div key={title} className="rounded-xl border border-slate-200 bg-white p-6">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50">
                    <Icon className="h-5 w-5 text-indigo-600" />
                  </div>
                  <h3 className="mt-4 text-sm font-semibold text-slate-900">{title}</h3>
                  <p className="mt-1.5 text-sm text-slate-500">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Workflow */}
        <section id="reports" className="py-20">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-semibold text-slate-900">From search to closed lead</h2>
              <p className="mt-3 text-slate-600">A friction-free path for non-technical users, end to end.</p>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-5">
              {WORKFLOW.map((step, i) => (
                <div key={step} className="relative rounded-xl border border-slate-200 bg-white p-5">
                  <span className="text-xs font-semibold text-indigo-600">Step {i + 1}</span>
                  <p className="mt-1.5 text-sm font-medium text-slate-900">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CRM */}
        <section id="crm" className="border-t border-slate-100 bg-slate-50/60 py-20">
          <div className="mx-auto grid max-w-7xl items-center gap-12 px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-semibold text-slate-900">A CRM built into your results table</h2>
              <p className="mt-3 text-slate-600">
                Follow companies, send irrelevant ones to trash without losing them, add notes and director
                contact details, and schedule follow-ups — without switching tools.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Follow, trash and restore companies",
                  "Notes and manually-sourced director contacts",
                  "Follow-up reminders on a shared calendar",
                  "Sort and reorder columns to match your workflow",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2.5 text-sm text-slate-700">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <div className="space-y-3">
                {["Acme Consulting Ltd", "Bridge Street Holdings", "Northfield Trading Co"].map((name, i) => (
                  <div
                    key={name}
                    className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3"
                  >
                    <div>
                      <div className="text-sm font-medium text-slate-900">{name}</div>
                      <div className="text-xs text-slate-500">{i === 0 ? "Follow-up due today" : "Followed"}</div>
                    </div>
                    <Star className={`h-4 w-4 ${i !== 2 ? "fill-amber-400 text-amber-400" : "text-slate-300"}`} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20">
          <div className="mx-auto max-w-4xl rounded-2xl bg-slate-900 px-8 py-14 text-center">
            <h2 className="text-3xl font-semibold text-white">Ready to work the register?</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-300">
              Sign in with your team credentials to start searching, filtering and building reports.
            </p>
            <div className="mt-8">
              <LinkButton href="/login" size="lg">
                Sign in to DIRECTOR.LTD
                <ArrowRight className="h-4 w-4" />
              </LinkButton>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
