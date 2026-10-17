import fs from "node:fs/promises";
import path from "node:path";

// Profile pictures live on disk (not in the database), one file per user, named from the user's id only - no user-supplied
// name or path ever reaches the filesystem. The type is decided from the file's own bytes, never from its declared MIME type.

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
export type AvatarExt = keyof typeof AVATAR_TYPES;
const ID = /^[a-z0-9]{10,40}$/i;

export const avatarDir = () => path.resolve(process.env.AVATAR_DIR || path.join(process.cwd(), "data", "avatars"));
export const isUserId = (id: string) => ID.test(id);

// JPEG / PNG / WebP by magic number; anything else (SVG, GIF, HTML, a renamed executable...) is refused.
export function detectImageType(b: Uint8Array): AvatarExt | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

const file = (userId: string, ext: AvatarExt) => path.join(avatarDir(), `${userId}.${ext}`);

export async function findAvatar(userId: string): Promise<{ ext: AvatarExt; mtimeMs: number } | null> {
  if (!isUserId(userId)) return null;
  for (const ext of Object.keys(AVATAR_TYPES) as AvatarExt[]) {
    try {
      const st = await fs.stat(file(userId, ext));
      return { ext, mtimeMs: Math.floor(st.mtimeMs) };
    } catch {
      /* not this extension */
    }
  }
  return null;
}

export async function readAvatar(userId: string, ext: AvatarExt): Promise<Buffer> {
  return fs.readFile(file(userId, ext));
}

export async function removeAvatar(userId: string): Promise<void> {
  if (!isUserId(userId)) return;
  for (const ext of Object.keys(AVATAR_TYPES) as AvatarExt[]) await fs.rm(file(userId, ext), { force: true });
}

export async function saveAvatar(userId: string, ext: AvatarExt, bytes: Buffer): Promise<void> {
  if (!isUserId(userId)) throw new Error("bad user id");
  await fs.mkdir(avatarDir(), { recursive: true });
  const tmp = path.join(avatarDir(), `.${userId}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, bytes);
  await removeAvatar(userId); // a user has exactly one picture, whatever format it was in before
  await fs.rename(tmp, file(userId, ext));
}

// The URL the header/settings use; the version changes whenever the picture does, so the browser never shows a stale one.
export const avatarUrl = (userId: string, version: number) => `/api/profile/avatar/${userId}?v=${version}`;
