import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma sends every query as a cached prepared statement. After a statement has
// run five times on a connection PostgreSQL may switch it to a "generic" plan
// that ignores the actual parameter values (OFFSET, LIMIT, filter values). On the
// 5.69M-company register that made identical searches swing between about 1 s and
// 5-10 s depending on how many times the connection had already run them.
// statement_cache_size=0 makes PostgreSQL plan each statement with its real
// values (parse/plan overhead is a fraction of a millisecond). An explicit
// statement_cache_size already present in DATABASE_URL always wins.
function datasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || /[?&]statement_cache_size=/.test(url)) return undefined;
  return `${url}${url.includes("?") ? "&" : "?"}statement_cache_size=0`;
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasourceUrl: datasourceUrl(),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
