import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword } from "./password";
import { validatePassword } from "./password-policy";

// First-Super-Admin bootstrap (production-safe alternative to the dev seed).
// Used only by `npm run admin:bootstrap`; there is deliberately no HTTP endpoint.
//
// Guarantees:
//  - creates exactly one row, in User; no companies, CRM, reports or demo data
//  - refuses if ANY Super Admin already exists (active or not) and never
//    modifies, demotes or deactivates an existing user
//  - the existence check and the insert run under one transaction-scoped
//    PostgreSQL advisory lock, so two simultaneous runs cannot both create one
//  - the password is validated with the application's password policy and
//    stored only as a bcrypt hash; it is never logged or returned

export class BootstrapError extends Error {
  constructor(public code: "INVALID_EMAIL" | "WEAK_PASSWORD" | "MISMATCH" | "SUPER_ADMIN_EXISTS" | "EMAIL_TAKEN", message: string) {
    super(message);
  }
}

// Same schema and normalisation the login route uses (zod email + lower-case).
const emailSchema = z.string().email().max(254);

export function normaliseEmail(raw: string): string {
  const parsed = emailSchema.safeParse(raw.trim());
  if (!parsed.success) throw new BootstrapError("INVALID_EMAIL", "Enter a valid email address.");
  return parsed.data.toLowerCase();
}

export function validateBootstrapInput(input: { email: string; password: string; confirm: string }): string {
  const email = normaliseEmail(input.email);
  if (input.password !== input.confirm) throw new BootstrapError("MISMATCH", "The passwords do not match.");
  const weakness = validatePassword(input.password, { email });
  if (weakness) throw new BootstrapError("WEAK_PASSWORD", `Password rejected: ${weakness}`);
  return email;
}

// Arbitrary constant identifying this lock ("DIRECTOR" as digits).
const BOOTSTRAP_LOCK_KEY = 4472657430;

export async function createFirstSuperAdmin(input: { email: string; name?: string; password: string; confirm: string }) {
  const email = validateBootstrapInput(input);
  const name = input.name?.trim() || "Super Admin";
  const passwordHash = await hashPassword(input.password);

  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);

      const existing = await tx.user.count({ where: { role: "SUPER_ADMIN" } });
      if (existing > 0) {
        throw new BootstrapError("SUPER_ADMIN_EXISTS", "A Super Admin already exists. Bootstrap refuses to create another; nothing was changed.");
      }
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new BootstrapError("EMAIL_TAKEN", "A user with that email already exists. Nothing was changed.");
      }
      return tx.user.create({
        data: { email, name, passwordHash, role: "SUPER_ADMIN", active: true },
        select: { id: true, email: true, name: true, role: true },
      });
    },
    { timeout: 15_000 }
  );
}
