import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A real bcrypt hash of a random string nobody knows, generated once per
// process. Compared against when the account does not exist so "unknown
// email" and "wrong password" take the same time (no enumeration by timing).
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash(randomBytes(24).toString("hex"), SALT_ROUNDS);
  return dummyHash;
}
