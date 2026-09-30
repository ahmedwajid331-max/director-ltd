// Sets (or rotates) a user's password without ever putting it on the command line.
//   NEW_PASSWORD='...' npm run user:set-password -- someone@example.com
//   npm run user:set-password -- someone@example.com --generate   (random password written to ./.dev-credentials.local)
// The password must satisfy the same policy as the Users screen.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { validatePassword } from "../src/lib/auth/password-policy";

async function main() {
  const email = process.argv[2]?.toLowerCase();
  if (!email || email.startsWith("--")) throw new Error("Usage: npm run user:set-password -- <email> [--generate]");

  const generate = process.argv.includes("--generate");
  const password = generate ? randomBytes(15).toString("base64url") + "!aA1" : process.env.NEW_PASSWORD;
  if (!password) throw new Error("Set NEW_PASSWORD in the environment, or pass --generate.");

  const weakness = validatePassword(password, { email });
  if (weakness) throw new Error(`Password rejected: ${weakness}`);

  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No user with email ${email}`);

  await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
  if (generate) {
    fs.appendFileSync(".dev-credentials.local", `${email} (${user.role}): ${password}\n`, { mode: 0o600 });
    console.log(`Password rotated for ${email}; the new password was written to .dev-credentials.local (gitignored).`);
  } else {
    console.log(`Password rotated for ${email}.`);
  }
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
