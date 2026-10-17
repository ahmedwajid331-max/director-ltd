/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers return loosely-typed JSON */
import "../support/require-scratch-db"; // must stay first: integration tests create/delete rows
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";

export const BASE = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3211";
export const BASE_PROD = process.env.TEST_BASE_URL_PROD ?? "http://127.0.0.1:3212";
export const db = new PrismaClient();

export const STRONG_PASSWORD = "Correct-Horse-Battery-42!";
let hash: string | null = null;

export async function createUser(role: "USER" | "ADMIN" | "SUPER_ADMIN", label = "t") {
  hash ??= await bcrypt.hash(STRONG_PASSWORD, 4); // low cost: test speed only
  const email = `${label}.${role.toLowerCase()}.${randomUUID().slice(0, 8)}@test.example`;
  const user = await db.user.create({ data: { email, name: `${label} ${role}`, passwordHash: hash, role } });
  return user;
}

export interface Session {
  cookie: string;
  userId: string;
  email: string;
}

export async function login(email: string, password = STRONG_PASSWORD, base = BASE): Promise<{ status: number; cookie: string | null; retryAfter: string | null; body: { error?: string } }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie?.match(/director_session=([^;]+)/)?.[1] ?? null;
  return { status: res.status, cookie, retryAfter: res.headers.get("retry-after"), body: await res.json().catch(() => ({})) };
}

export async function sessionFor(role: "USER" | "ADMIN" | "SUPER_ADMIN", label = "t", base = BASE): Promise<Session> {
  const user = await createUser(role, label);
  const r = await login(user.email, STRONG_PASSWORD, base);
  if (!r.cookie) throw new Error(`login failed for test user: ${r.status} ${JSON.stringify(r.body)}`);
  return { cookie: r.cookie, userId: user.id, email: user.email };
}

export async function api(
  s: Session | null,
  path: string,
  options: { method?: string; body?: unknown; base?: string } = {}
): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const res = await fetch(`${options.base ?? BASE}${path}`, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(s ? { cookie: `director_session=${s.cookie}` } : {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

export const rule = (field: string, operator: string, value?: unknown, value2?: unknown) => ({
  id: "r", kind: "rule", field, operator, ...(value !== undefined ? { value } : {}), ...(value2 !== undefined ? { value2 } : {}),
});
export const group = (combinator: "AND" | "OR", ...children: unknown[]) => ({ id: "g", kind: "group", combinator, children });

let counter = 0;
export async function makeCompany(over: Record<string, unknown> = {}) {
  counter++;
  const number = `T${String(Date.now()).slice(-6)}${String(counter).padStart(2, "0")}${Math.floor(Math.random() * 9)}`.slice(0, 9).toUpperCase();
  return db.company.create({
    data: {
      companyNumber: number,
      name: `TESTCO ${number}`,
      status: "active",
      type: "ltd",
      incorporationDate: new Date("2015-06-15T00:00:00Z"),
      registeredAddress1: "1 Test Street",
      registeredCity: "Testville",
      registeredPostcode: "TE1 1ST",
      source: "bulk_import",
      ...over,
    } as never,
  });
}
