import Link from "next/link";
import {
  ArrowRight,
  Building2,
  FileSpreadsheet,
  Star,
  Calendar,
  Flag,
  Bookmark,
  Search,
  ListChecks,
  Eye,
  Landmark,
  Layers,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { LinkButton } from "@/components/ui/Button";
import { MarketingHeader } from "@/components/marketing/Header";
import { MarketingFooter } from "@/components/marketing/Footer";
import { SearchShowcase, WorkflowShowcase } from "@/components/marketing/LandingTabs";
import { getRegisterBreakdown } from "@/lib/data/companies";
import { COMPANY_FILTER_FIELDS } from "@/lib/filters/fields";

// Figures come from the live database (memoised for five minutes in getRegisterBreakdown); revalidate so the
// page never bakes in build-time numbers.
export const revalidate = 60;

const AUDIENCES = ["Accountants", "Formation agents", "Company secretaries", "Business researchers", "Compliance teams"];

const PLATFORM_CARDS: { icon: typeof Search; title: string; text: string; href: string }[] = [
  { icon: Building2, title: "UK companies", text: "Search the full Companies House register", href: "/companies" },
  { icon: ListChecks, title: "Report builder", text: "Filters with AND / OR and nested groups", href: "/reports/new" },
  { icon: FileSpreadsheet, title: "Saved reports", text: "Lists that refresh every day", href: "/reports" },
  { icon: Eye, title: "Watches", text: "Follow the companies you care about", href: "/watches" },
  { icon: Bookmark, title: "Saved", text: "Your shortlist of companies", href: "/saved" },
  { icon: Flag, title: "Red flags", text: "Mark companies that need attention", href: "/red-flags" },
  { icon: Calendar, title: "Calendar", text: "Follow-ups: overdue, upcoming, done", href: "/calendar" },
  { icon: Star, title: "Company records", text: "Notes, contacts and filing position", href: "/companies" },
];

const APART = [
  ["Official source only", "Company, status, address, SIC, filings and officers all come from Companies House. Nothing is scraped, estimated or invented."],
  ["Honest about coverage", "Director data is collected in the background. A company whose officers are not fetched yet shows “Not fetched”, never zero directors."],
  ["Search that scales", "Search, filtering, sorting and paging run on the server over the whole register, so a result is one page away even at millions of rows."],
  ["Reports and CRM in one place", "Turn a search into a daily-refreshing report, then follow, note and schedule from the same record."],
];

const APART_ICONS = [ShieldCheck, RefreshCw, Search, Layers];

const FAQ = [
  { q: "Where does the data come from?", a: "Directly from Companies House: the full company register, the live filing stream (including DS01 and DS02 strike-off events) and officer records. Nothing is scraped or estimated." },
  { q: "How often is it updated?", a: "Filing events update companies as they are filed. An automatic daily update recalculates overdue flags and refreshes every saved report that has daily refresh switched on. The dashboard shows when the last automatic update ran." },
  { q: "What does “not fetched” mean for directors?", a: "Officer data is collected from Companies House in the background. A company whose officers have not been fetched yet is shown as not fetched, never as zero directors, and director filters only evaluate companies with confirmed officer data." },
  { q: "Can I export results?", a: "Yes. Any search, filter or saved report can be exported as CSV. Exports follow your filters and are protected against spreadsheet formula injection." },
  { q: "Is there an API?", a: "Not yet. An API is planned. Today DIRECTOR.LTD is a web application, and no public endpoints or keys exist." },
  { q: "Do you hold ownership or corporate hierarchy data?", a: "Not currently. Parent and subsidiary relationships and beneficial ownership are not part of the data DIRECTOR.LTD holds today, so none are shown." },
];

function Eyebrow({ children, light }: { children: React.ReactNode; light?: boolean }) {
  return <p className={`text-[13px] font-semibold uppercase tracking-[0.16em] ${light ? "text-blue-300" : "text-indigo-600"}`}>{children}</p>;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
      <p className="text-3xl font-bold tabular-nums text-indigo-900">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{label}</p>
    </div>
  );
}

export default async function Home() {
  const r = await getRegisterBreakdown();
  const n = (v: number) => v.toLocaleString();
  const other = Math.max(0, r.total - r.active - r.dissolved);
  const pct = (v: number) => (r.total > 0 ? (v / r.total) * 100 : 0);
  const directorPct = r.total > 0 ? `${((r.directorsConfirmed / r.total) * 100).toFixed(r.directorsConfirmed / r.total < 0.1 ? 1 : 0)}%` : "0%";
  const filterGroups = Object.entries(
    COMPANY_FILTER_FIELDS.reduce<Record<string, string[]>>((acc, f) => {
      (acc[f.group] ??= []).push(f.label);
      return acc;
    }, {})
  );

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingHeader />

      <main className="flex-1">
        {/* 1. Hero */}
        <section className="border-b border-slate-100" style={{ backgroundImage: "radial-gradient(circle, #d6e2fb 1px, transparent 1px)", backgroundSize: "24px 24px" }}>
          <div className="mx-auto max-w-6xl px-6 pb-16 pt-20 text-center sm:pt-24">
            <h1 className="text-5xl font-extrabold leading-[1.02] tracking-tight text-indigo-900 sm:text-6xl lg:text-8xl">
              UK Company Data Solutions for <span className="text-indigo-600">Research &amp; CRM</span>
            </h1>
            <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-slate-500">
              Company data on every business on the UK register, sourced straight from Companies House. Built for teams that search, verify, report and follow up.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <LinkButton href="/login" size="lg" className="rounded-md px-8 py-4 text-base">
                Sign in to the platform
              </LinkButton>
              <LinkButton href="#uk-data" variant="outline" size="lg" className="rounded-md border-2 border-indigo-600 px-8 py-4 text-base text-indigo-600">
                Explore UK data
              </LinkButton>
            </div>
            <p className="mt-5 text-[15px] text-indigo-900">
              Looking for API access? <span className="font-semibold text-indigo-600">API planned, not yet available.</span>
            </p>
          </div>
          <div className="mx-auto max-w-5xl px-6 pb-14 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Built for</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-3 text-xl font-bold text-slate-400">
              {AUDIENCES.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </div>
        </section>

        {/* 2. UK register at a glance */}
        <section id="uk-data" className="py-24">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-2">
            <div>
              <Eyebrow>The UK register. Every company.</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight text-indigo-900">
                Official UK company data, <span className="text-indigo-600">one platform</span>
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-500">
                Every company on the Companies House register, searchable by name, company number or postcode. Open any company to see its status, address, industry, filings and officers.
              </p>
              <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat value={n(r.total)} label="UK companies loaded" />
                <Stat value={n(r.active)} label="Active" />
                <Stat value={n(r.dissolved)} label="Dissolved" />
                <Stat value={n(r.directorsConfirmed)} label="With confirmed directors" />
                <Stat value={String(COMPANY_FILTER_FIELDS.length)} label="Filter fields" />
                <Stat value="Daily" label="Automatic update" />
              </div>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-indigo-50 to-white p-8 shadow-xl shadow-blue-100/60">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white">
                  <Landmark className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-lg font-bold text-indigo-900">Companies House register</p>
                  <p className="text-sm text-slate-500">United Kingdom · registration ID: company number</p>
                </div>
              </div>
              <p className="mt-8 text-6xl font-extrabold tabular-nums tracking-tight text-indigo-900">{n(r.total)}</p>
              <p className="text-slate-500">companies in DIRECTOR.LTD today</p>
              <div className="mt-6 flex h-4 overflow-hidden rounded-full bg-slate-200" role="img" aria-label="Share of companies by status">
                <div className="bg-indigo-600" style={{ width: `${pct(r.active)}%` }} />
                <div className="bg-indigo-300" style={{ width: `${pct(r.dissolved)}%` }} />
                <div className="bg-slate-400" style={{ width: `${pct(other)}%` }} />
              </div>
              <ul className="mt-4 space-y-2 text-sm text-slate-600">
                <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-indigo-600" /> Active · {n(r.active)}</li>
                <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-indigo-300" /> Dissolved · {n(r.dissolved)}</li>
                <li className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-slate-400" /> Other statuses (liquidation, administration…) · {n(other)}</li>
              </ul>
            </div>
          </div>
        </section>

        {/* 3. Compliant / source card */}
        <section className="bg-slate-50/70 pb-24 pt-4">
          <div className="mx-auto max-w-6xl px-6">
            <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
              <div className="absolute inset-x-0 top-0 mx-auto h-0.5 w-2/3 bg-gradient-to-r from-transparent via-indigo-500 to-transparent" />
              <div className="grid lg:grid-cols-2">
                <div className="p-10 lg:p-14">
                  <Eyebrow>Official UK source</Eyebrow>
                  <h2 className="mt-4 text-4xl font-bold leading-tight tracking-tight text-indigo-900">Company data you can actually use</h2>
                  <p className="mt-5 text-lg leading-relaxed text-slate-500">
                    Every record comes from Companies House, the UK registrar, and carries its source. Filing events update companies as they are filed, and an automatic daily update keeps reports current.
                  </p>
                  <LinkButton href="/login" size="lg" className="mt-8 rounded-md">
                    Sign in to the platform
                  </LinkButton>
                </div>
                <div className="border-t border-slate-100 bg-slate-50/50 p-10 lg:border-l lg:border-t-0 lg:p-14">
                  <p className="flex items-center gap-2 text-sm font-semibold text-indigo-900"><ShieldCheck className="h-4 w-4 text-indigo-600" /> United Kingdom</p>
                  <p className="mt-3 text-6xl font-extrabold tabular-nums tracking-tight text-indigo-600">{n(r.total)}</p>
                  <p className="mt-1 text-sm text-slate-500">companies · Companies House</p>
                  <div className="mt-8 border-t border-slate-200 pt-8">
                    <p className="text-4xl font-bold tabular-nums text-indigo-900">{directorPct}</p>
                    <p className="mt-1 text-sm text-slate-500">of companies have confirmed director data so far. The rest show “Not fetched”, never zero.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4. Corporate structure (planned, honest) */}
        <section className="py-24">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <Eyebrow>Ownership data · planned</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight text-indigo-900">Corporate structure</h2>
              <p className="mt-5 text-lg leading-relaxed text-slate-500">
                Parent companies, subsidiaries and beneficial ownership are not part of the data DIRECTOR.LTD holds today, so none is shown or implied. Each company record has a Corporate structure section that will light up if verified data is added.
              </p>
              <ul className="mt-6 space-y-2 text-[15px] text-slate-600">
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-indigo-900" /> Parent company · planned</li>
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-indigo-400" /> Subsidiaries · planned</li>
                <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-sm bg-indigo-200" /> Beneficial owners · planned</li>
              </ul>
            </div>
            <div className="relative rounded-3xl border border-slate-200 bg-gradient-to-br from-indigo-50/60 to-white p-8">
              <div className="flex items-center gap-6">
                <div className="w-56 shrink-0 rounded-2xl border-2 border-dashed border-indigo-300 bg-white p-5">
                  <span className="rounded-full border border-indigo-300 px-3 py-0.5 text-xs font-semibold text-indigo-600">Parent</span>
                  <p className="mt-3 text-sm font-semibold text-slate-500">Not available</p>
                </div>
                <div className="flex-1 space-y-3 border-l-2 border-indigo-200 pl-6">
                  {["Subsidiary", "Subsidiary", "Beneficial owner"].map((l, i) => (
                    <div key={i} className="rounded-xl border border-dashed border-slate-300 bg-white px-5 py-3.5">
                      <p className="text-sm font-semibold text-slate-400">{l}</p>
                      <p className="text-xs text-slate-400">Not available in DIRECTOR.LTD</p>
                    </div>
                  ))}
                </div>
              </div>
              <p className="mt-6 text-xs text-slate-400">Illustration of a planned section. No relationships are displayed.</p>
            </div>
          </div>
        </section>

        {/* 5. Search and datapoints */}
        <section id="search" className="bg-indigo-50/70 py-24">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>Everything there is to know</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900">Search the whole UK register</h2>
              <p className="mt-4 text-lg text-slate-500">One search box over every company, then {COMPANY_FILTER_FIELDS.length} filter fields to narrow it down.</p>
            </div>
            <div className="mt-10">
              <SearchShowcase />
            </div>
            <p className="mt-6 text-center text-sm text-slate-500">
              Source: <span className="text-indigo-600">Companies House</span> · <Link href="#filters" className="font-semibold text-indigo-600 hover:underline">See all filter fields →</Link>
            </p>
            <div className="mx-auto mt-16 grid max-w-6xl grid-cols-2 gap-y-8 divide-slate-300 text-center md:grid-cols-5 md:divide-x">
              {[
                [n(r.total), "UK companies"],
                [n(r.active), "Active companies"],
                [n(r.directorsConfirmed), "Companies with confirmed directors"],
                [String(COMPANY_FILTER_FIELDS.length), "Filter fields"],
                ["DS01 · DS02", "Strike-off filing events tracked"],
              ].map(([v, l]) => (
                <div key={l} className="px-3">
                  <p className="text-3xl font-extrabold tabular-nums tracking-tight text-indigo-900 xl:text-4xl">{v}</p>
                  <p className="mt-2 text-sm text-slate-500">{l}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 6. Filters */}
        <section id="filters" className="py-24">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>Powerful filters</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900">Combine anything with AND / OR</h2>
              <p className="mt-4 text-lg text-slate-500">Nest groups for logic such as (Dormant AND Active) OR DS01 filed. Your own followed, saved and red-flagged companies are filters too.</p>
            </div>
            <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {filterGroups.map(([group, fields]) => (
                <div key={group} className="rounded-2xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md">
                  <p className="text-lg font-bold text-indigo-900">{group}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {fields.map((f) => (
                      <span key={f} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">{f}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 7. Workflow tabs */}
        <section id="workflow" className="border-t border-slate-100 bg-slate-50/70 py-24">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <Eyebrow>Reports, CRM and daily data</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900">
                Ready for <span className="text-indigo-600">your workflow</span>
              </h2>
              <p className="mt-4 text-lg text-slate-500">Find companies, build lists, follow up and keep it all current from one place.</p>
            </div>
            <WorkflowShowcase />
          </div>
        </section>

        {/* 8. Platform cards */}
        <section className="py-24">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>The platform</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900">Everything in one workspace</h2>
              <p className="mt-4 text-lg text-slate-500">Sign in to open any of these areas.</p>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {PLATFORM_CARDS.map(({ icon: Icon, title, text, href }) => (
                <Link key={title} href={href} className="group rounded-xl border border-slate-200 bg-white p-6 transition-all hover:border-indigo-300 hover:shadow-md">
                  <Icon className="h-6 w-6 text-indigo-600" />
                  <p className="mt-4 text-xl font-bold text-indigo-900">{title}</p>
                  <p className="mt-1 text-sm text-slate-500">{text}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-indigo-600 opacity-0 transition-opacity group-hover:opacity-100">Open <ArrowRight className="h-3.5 w-3.5" /></span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* 9. What sets us apart */}
        <section className="border-t border-slate-100 bg-slate-50/70 py-24">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-2">
            <div className="flex flex-col items-center text-center">
              <div className="relative flex h-56 w-96 max-w-full items-center justify-center" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span key={i} className="absolute h-44 w-44 rounded-full border-4 border-white bg-gradient-to-br from-indigo-100/70 to-white shadow-lg" style={{ left: `${i * 26 + 4}%` }} />
                ))}
              </div>
              <p className="mt-4 text-3xl font-bold text-indigo-900">Talk to us</p>
              <p className="mt-2 max-w-sm text-slate-500">Questions about access? Sign in or ask your Super Admin to add you.</p>
              <LinkButton href="/login" size="lg" className="mt-6 rounded-md">Sign in <ArrowRight className="h-4 w-4" /></LinkButton>
            </div>
            <div>
              <Eyebrow>What sets us apart</Eyebrow>
              <h2 className="mt-4 text-4xl font-extrabold leading-tight tracking-tight text-indigo-900">We don&apos;t stop at the data. We make it work for your business.</h2>
              <div className="mt-8 divide-y divide-slate-200 border-y border-slate-200">
                {APART.map(([t, d], i) => (
                  <details key={t} className="group py-5" open={i === 0}>
                    <summary className="flex cursor-pointer list-none items-center gap-4 text-lg font-bold text-indigo-900">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white">
                        {(() => {
                          const Icon = APART_ICONS[i];
                          return <Icon className="h-5 w-5" />;
                        })()}
                      </span>
                      {t}
                      <span className="ml-auto text-2xl font-light text-slate-400 group-open:rotate-45">+</span>
                    </summary>
                    <p className="mt-3 pl-[60px] text-[15px] leading-relaxed text-slate-600">{d}</p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 10. API (planned) */}
        <section id="api" className="bg-gradient-to-br from-indigo-900 to-indigo-950 py-24 text-white">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 lg:grid-cols-2">
            <div>
              <Eyebrow light>For developers · planned</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold leading-tight tracking-tight">Build with UK company data. API coming soon.</h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-blue-100">
                DIRECTOR.LTD does not offer a public API today. When it does, it will expose the same server-side search and filters you use in the app. No endpoints, keys or sample responses exist yet.
              </p>
              <div className="mt-8 grid gap-5 sm:grid-cols-2">
                {[["Company search", "Planned"], ["Filtered lead lists", "Planned"], ["Company record", "Planned"], ["Saved report results", "Planned"]].map(([t, s]) => (
                  <div key={t}>
                    <p className="text-lg font-semibold">{t}</p>
                    <p className="text-sm text-blue-300">{s}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/40 p-6 font-mono text-sm shadow-2xl">
              <p className="text-xs uppercase tracking-widest text-blue-300">Internal use only today</p>
              <div className="mt-4 rounded-lg border border-white/10 bg-black/40 p-4 text-blue-100">
                <p className="text-blue-300">{"// Not available yet"}</p>
                <p className="mt-2">{"The app's own search runs server-side."}</p>
                <p>{"A public API is on the roadmap."}</p>
              </div>
              <div className="mt-4 cursor-not-allowed rounded-lg bg-indigo-600/50 py-3 text-center font-sans font-semibold text-white/70">API not yet available</div>
            </div>
          </div>
        </section>

        {/* 11. Use cases */}
        <section className="py-24">
          <div className="mx-auto max-w-7xl px-6">
            <div className="mx-auto max-w-3xl text-center">
              <Eyebrow>Data for everyday decisions</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900">
                When accuracy is <span className="text-indigo-600">non-negotiable</span>
              </h2>
              <p className="mt-4 text-lg text-slate-500">Registry-sourced data for the people who work with UK companies every day.</p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {[
                ["ACCOUNTANTS", "Late accounts and confirmation statements", "Filter by overdue accounts and confirmation statements, save the list and chase it.", "from-indigo-900 to-indigo-700"],
                ["FORMATION AGENTS", "Strike-off and newly dormant companies", "Find DS01 filings and dormant companies as the live stream records them.", "from-indigo-700 to-indigo-500"],
                ["COMPLIANCE", "Know who the directors are", "Check status, address, filings and confirmed officers on one structured record.", "from-indigo-950 to-indigo-800"],
              ].map(([tag, title, text, grad]) => (
                <div key={tag} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className={`flex h-40 items-end bg-gradient-to-br ${grad} p-5`}>
                    <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold tracking-widest text-white">{tag}</span>
                  </div>
                  <div className="p-6">
                    <h3 className="text-xl font-bold text-indigo-900">{title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 12. FAQ */}
        <section id="faq" className="border-t border-slate-100 py-24">
          <div className="mx-auto max-w-3xl px-6">
            <div className="text-center">
              <Eyebrow>FAQ</Eyebrow>
              <h2 className="mt-4 text-5xl font-extrabold tracking-tight text-indigo-900">Questions, answered.</h2>
            </div>
            <div className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
              {FAQ.map(({ q, a }, i) => (
                <details key={q} className="group py-5" open={i === 0}>
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-lg font-semibold text-indigo-900">
                    {q}
                    <span className="text-2xl font-light text-indigo-600 group-open:hidden">+</span>
                    <span className="hidden text-2xl font-light text-indigo-600 group-open:inline">−</span>
                  </summary>
                  <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 13. Final CTA */}
        <section className="bg-gradient-to-br from-indigo-900 to-indigo-950 py-20">
          <div className="mx-auto max-w-4xl px-6 text-center">
            <h2 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl">Ready to work the UK register?</h2>
            <p className="mx-auto mt-4 max-w-xl text-lg text-blue-100">Sign in with your team credentials to start searching, filtering and building reports.</p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <LinkButton href="/login" size="lg" className="rounded-md !bg-white px-8 py-4 !text-indigo-900 hover:!bg-blue-50">
                Sign in to DIRECTOR.LTD <ArrowRight className="h-4 w-4" />
              </LinkButton>
              <LinkButton href="#uk-data" variant="outline" size="lg" className="rounded-md !border-white/60 px-8 py-4 !text-white hover:!bg-white/10">
                Explore UK data
              </LinkButton>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
