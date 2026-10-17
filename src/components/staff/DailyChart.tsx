import type { DailyPoint } from "@/lib/staff/stats";
import { formatDuration } from "@/lib/staff/sessions";

// Daily bars of recorded meaningful actions: one series, one hue, so no legend box (the heading names it). Bars are thin
// with a rounded data end, a visible zero baseline (a quiet day is a short stub, not a gap), a hover title per bar, and a
// table view for screen readers and anyone who prefers numbers. Session time is listed in the table only, because it is
// session time, not working time, and must not be read as a second bar competing with the actions.
export function DailyChart({ points, label }: { points: DailyPoint[]; label: string }) {
  const W = 720;
  const H = 180;
  const pad = { l: 34, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...points.map((p) => p.meaningfulActions));
  // "Nice" axis maximum so gridlines land on round numbers.
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 50 ? 10 : max <= 100 ? 20 : Math.pow(10, Math.floor(Math.log10(max))) ;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(18, slot * 0.6));
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(points.length / 12));
  const short = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;

  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-slate-300" : "stroke-slate-100"} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums">
              {t}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          const h = Math.max(p.meaningfulActions === 0 ? 1.5 : 3, (p.meaningfulActions / top) * ih);
          return (
            <g key={p.day}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih + 2} fill="transparent">
                <title>{`${p.day}: ${p.meaningfulActions} recorded actions, ${formatDuration(p.sessionMs)} signed in`}</title>
              </rect>
              <rect x={x} y={pad.t + ih - h} width={bw} height={h} rx={Math.min(4, bw / 2)} className={p.meaningfulActions === 0 ? "fill-slate-200" : "fill-indigo-500"} pointerEvents="none" />
              {i % every === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="fill-slate-500 text-[10px]">
                  {short(p.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer font-medium text-slate-700">View as table</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-1.5 font-semibold">Day</th>
                <th className="px-3 py-1.5 text-right font-semibold">Recorded actions</th>
                <th className="px-3 py-1.5 text-right font-semibold">Session time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {points.map((p) => (
                <tr key={p.day}>
                  <td className="px-3 py-1">{p.day}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{p.meaningfulActions}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{formatDuration(p.sessionMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
