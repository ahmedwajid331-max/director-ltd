import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ShieldCheck, Filter, FileSpreadsheet, Users2 } from "lucide-react";
import { LoginForm } from "./LoginForm";
import { MonitoringNotice } from "@/components/staff/MonitoringNotice";

export const metadata: Metadata = { title: "Sign in" };

const FEATURES = [
  { icon: Filter, text: "Build any permutation of Companies House filters" },
  { icon: FileSpreadsheet, text: "Save reports that refresh automatically every day" },
  { icon: Users2, text: "Manage leads with a built-in CRM and follow-ups" },
  { icon: ShieldCheck, text: "Role-based access with full Super Admin oversight" },
];

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-slate-900 p-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.4) 1px, transparent 0)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500 text-sm font-bold">
            DL
          </div>
          <span className="text-lg font-semibold">DIRECTOR.LTD</span>
        </div>

        <div className="relative">
          <h2 className="text-3xl font-semibold leading-tight">
            Companies House intelligence,
            <br /> built for professionals.
          </h2>
          <p className="mt-3 max-w-md text-sm text-slate-400">
            Search the full UK company register, build custom reports and manage leads —
            all in one platform.
          </p>
          <ul className="mt-8 space-y-3">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-slate-300">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10">
                  <Icon className="h-3.5 w-3.5" />
                </div>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-slate-500">© {new Date().getFullYear()} DIRECTOR.LTD</p>
      </div>

      <div className="flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
              DL
            </div>
            <span className="text-base font-semibold text-slate-900">DIRECTOR.LTD</span>
          </div>

          <h1 className="text-xl font-semibold text-slate-900">Welcome back</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to access your dashboard.</p>

          <div className="mt-6">
            <Suspense>
              <LoginForm />
          <div className="mt-6"><MonitoringNotice /></div>
            </Suspense>
          </div>

          <p className="mt-6 text-center text-xs text-slate-400">
            Need access? Contact your Super Admin.{" "}
            <Link href="/" className="font-medium text-indigo-600 hover:text-indigo-700">
              Back to home
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
