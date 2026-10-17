// Password rules for every user-created or admin-created account.
// Deliberately simple and explainable: length first (NIST 800-63B), plus a
// blocklist of passwords that are trivially guessable.
const COMMON = [
  "password", "passw0rd", "letmein", "welcome", "administrator", "admin", "qwerty", "qwertyuiop",
  "abc123", "iloveyou", "monkey", "dragon", "football", "baseball", "master", "directorltd",
  "directoradmin", "director", "changeme", "changeit", "trustno1", "sunshine",
];

export const MIN_PASSWORD_LENGTH = 8;

// Returns a human-readable reason the password is unacceptable, or null if OK.
export function validatePassword(password: string, context: { email?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > 200) return "Password is too long.";

  const normalised = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lettersOnly = password.toLowerCase().replace(/[^a-z]/g, "");
  for (const bad of COMMON) {
    if (normalised === bad || lettersOnly === bad) return "That password is too common.";
    // "Password1234!"-style: a common word padded with a few extra characters.
    if (normalised.includes(bad) && normalised.length <= bad.length + 5) return "That password is too easy to guess.";
  }
  if (/^(.)\1+$/.test(password)) return "Password cannot be one repeated character.";
  if (/^(0123456789|1234567890|123456789012|abcdefghijkl|qwertyuiopas)/i.test(password)) {
    return "Password is a simple sequence.";
  }
  if (new Set(password).size < 5) return "Use a wider variety of characters.";

  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return "Password must not contain your email name.";
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 2 && password.length < 16) return "Mix letters with numbers or symbols, or use 16+ characters.";
  return null;
}
