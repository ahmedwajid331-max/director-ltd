// Minimal structured logger for jobs and scripts. One JSON object per line
// (timestamp, level, component, message, fields) so CloudWatch / any log
// shipper can filter and alert on it; human-readable text when LOG_FORMAT=text
// or when running interactively outside production.
export type LogLevel = "debug" | "info" | "warn" | "error";

const asJson = () => process.env.LOG_FORMAT === "json" || (process.env.LOG_FORMAT !== "text" && process.env.NODE_ENV === "production");

export function makeLogger(component: string) {
  const emit = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    const ts = new Date().toISOString();
    if (asJson()) {
      const line = JSON.stringify({ ts, level, component, message, ...fields });
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    } else {
      const extra = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
      (level === "error" || level === "warn" ? console.error : console.log)(`[${ts}] ${level.toUpperCase()} ${component}: ${message}${extra}`);
    }
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
  };
}
