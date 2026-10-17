"use client";

import { useState } from "react";

// The picture when there is one that loads, otherwise the initials the app has always shown. The caller supplies the
// circle's size/colour classes, so existing layouts are unchanged.
export function Avatar({ src, initials, className }: { src: string | null; initials: string; className: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src;
  return (
    <span className={`${className} relative shrink-0 overflow-hidden`}>
      {show ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small private, versioned image; next/image optimisation is not needed
        <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(src)} />
      ) : (
        initials
      )}
    </span>
  );
}
