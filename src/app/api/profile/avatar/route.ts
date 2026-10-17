import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/activity";
import { AVATAR_MAX_BYTES, detectImageType, removeAvatar, saveAvatar } from "@/lib/avatar";

// A person changes ONLY their own picture: the target is always the signed-in user's id from the server-side session,
// never a value from the request. The file is checked by size and by its real bytes before anything is written.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  if (file.size > AVATAR_MAX_BYTES) return NextResponse.json({ error: "The image is too large (2 MB maximum)." }, { status: 413 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const ext = detectImageType(bytes);
  if (!ext) return NextResponse.json({ error: "Use a JPEG, PNG or WebP image." }, { status: 415 });

  await saveAvatar(session.userId, ext, bytes);
  await logActivity(session, "profile_picture_changed", { meta: { action: "set" } });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await removeAvatar(session.userId);
  await logActivity(session, "profile_picture_changed", { meta: { action: "removed" } });
  return NextResponse.json({ ok: true });
}
