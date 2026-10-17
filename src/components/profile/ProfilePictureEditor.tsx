"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ImageUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Avatar } from "./Avatar";

const ACCEPT = ["image/jpeg", "image/png", "image/webp"];
const MAX_PICK_BYTES = 10 * 1024 * 1024; // what we will try to read; the upload itself is downscaled well under the server's 2 MB limit
const MAX_SIDE = 512;

// Downscales and re-encodes in the browser (centred square crop), so phone photos upload quickly and the server only ever
// receives a small WebP/JPEG. Throws if the browser cannot decode the file.
async function prepare(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(MAX_SIDE, side);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const webp: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.85));
  if (webp && webp.type === "image/webp") return webp;
  const jpeg: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  if (!jpeg) throw new Error("encode failed");
  return jpeg;
}

export function ProfilePictureEditor({ currentSrc, initials }: { currentSrc: string | null; initials: string }) {
  const router = useRouter();
  const chooseRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview]
  );

  async function onPick(file: File | undefined) {
    setError(null);
    setMessage(null);
    if (!file) return;
    if (!ACCEPT.includes(file.type)) return setError("Use a JPEG, PNG or WebP image.");
    if (file.size > MAX_PICK_BYTES) return setError("That image is too large (10 MB maximum).");
    try {
      const b = await prepare(file);
      setBlob(b);
      setPreview(URL.createObjectURL(b));
    } catch {
      setError("That image could not be read. Try a different JPEG, PNG or WebP file.");
    }
  }

  async function save() {
    if (!blob) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", blob, blob.type === "image/webp" ? "avatar.webp" : "avatar.jpg");
      const res = await fetch("/api/profile/avatar", { method: "POST", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return setError(data.error ?? "Could not save the picture.");
      setBlob(null);
      setPreview(null);
      setMessage("Profile picture saved.");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile/avatar", { method: "DELETE" });
      if (!res.ok) return setError("Could not remove the picture.");
      setMessage("Profile picture removed.");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    void onPick(e.target.files?.[0]);
    e.target.value = "";
  };

  return (
    <div className="flex flex-wrap items-center gap-5 p-5">
      <Avatar src={preview ?? currentSrc} initials={initials} className="flex h-20 w-20 items-center justify-center rounded-full bg-slate-200 text-xl font-semibold text-slate-600" />
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input ref={chooseRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" tabIndex={-1} aria-label="Choose a picture from your device" onChange={pick} />
          <input ref={cameraRef} type="file" accept="image/*" capture="user" className="sr-only" tabIndex={-1} aria-label="Take a picture with your camera" onChange={pick} />
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => chooseRef.current?.click()}>
            <ImageUp className="h-4 w-4" /> Upload / choose from gallery
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => cameraRef.current?.click()}>
            <Camera className="h-4 w-4" /> Take a photo
          </Button>
          {currentSrc && !blob && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={remove}>
              <Trash2 className="h-4 w-4" /> Remove picture
            </Button>
          )}
        </div>
        {blob && (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={save}>
              Save picture
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBlob(null);
                setPreview(null);
              }}
            >
              Cancel
            </Button>
            <span className="text-xs text-slate-500">Preview - not saved yet.</span>
          </div>
        )}
        <p className="text-xs text-slate-500">JPEG, PNG or WebP, cropped to a square. &ldquo;Take a photo&rdquo; opens the camera on phones and tablets; on a computer it opens the file chooser.</p>
        {error && (
          <p role="alert" className="text-xs font-medium text-red-600">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-xs font-medium text-emerald-700">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
