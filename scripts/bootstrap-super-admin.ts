// Creates the FIRST Super Admin in the database named by DATABASE_URL - no companies, no demo data.
//   npm run admin:bootstrap
// Interactive prompts (password input is hidden): Email, Name, Password, Confirm password, then a
// y/N confirmation that shows the target database (host:port/database, never credentials).
// The password is never accepted on the command line, never printed, never logged.
// Piped stdin (one answer per line) is also supported for automation/tests.
// Refuses if any Super Admin already exists. Safe to run more than once.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd()); // load .env BEFORE any Prisma client exists (modules below are imported dynamically)

function describeTarget(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}:${u.port || "5432"}/${decodeURIComponent(u.pathname.replace(/^\//, ""))}`;
  } catch {
    return "(DATABASE_URL is missing or invalid)";
  }
}

// One reader for both modes. TTY: raw mode, optional echo suppression. Piped: consume stdin lines in order.
let pipedLines: string[] | null = null;

async function readPipedLine(): Promise<string> {
  if (pipedLines === null) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    pipedLines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }
  return pipedLines.shift() ?? "";
}

function readTtyLine(hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\nCancelled.\n");
          process.exit(2);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (!hidden) process.stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          buf += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function ask(prompt: string, hidden = false): Promise<string> {
  process.stdout.write(prompt);
  if (process.stdin.isTTY) return readTtyLine(hidden);
  const line = await readPipedLine();
  process.stdout.write("\n");
  return line;
}

async function main(): Promise<number> {
  const { BootstrapError, createFirstSuperAdmin, validateBootstrapInput } = await import("../src/lib/auth/bootstrap");
  const { db } = await import("../src/lib/db");

  try {
    console.log(`Target database: ${describeTarget()}`);
    console.log("This creates the FIRST Super Admin only (no companies or demo data).\n");

    const email = (await ask("Email: ")).trim();
    const name = (await ask("Name (optional, default 'Super Admin'): ")).trim();
    const password = await ask("Password: ", true);
    const confirm = await ask("Confirm password: ", true);

    // Validate before touching the database, so bad input fails fast.
    validateBootstrapInput({ email, password, confirm });

    const answer = (await ask(`\nCreate the FIRST Super Admin in this database (${describeTarget()})? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled. Nothing was changed.");
      return 2;
    }

    const user = await createFirstSuperAdmin({ email, name, password, confirm });
    console.log(`\nSuper Admin created: ${user.email} (id ${user.id}).`);
    console.log("Sign in at /login, then create further users from the Users screen.");
    return 0;
  } catch (err) {
    if (err instanceof BootstrapError) {
      console.error(`\nRefused: ${err.message}`);
      return 1;
    }
    // Never echo raw driver errors that might carry connection details.
    console.error("\nBootstrap failed:", err instanceof Error ? err.message.split("\n").pop() : "unknown error");
    return 1;
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

main().then((code) => process.exit(code));
