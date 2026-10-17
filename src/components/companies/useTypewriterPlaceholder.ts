"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const PHRASES = ["Search by company name…", "Try a company number…", "Find a company by postcode…", "Discover UK businesses…"];

// Typewriter text for an input placeholder. Returns "" (caller falls back to a static placeholder) while
// inactive or when the user prefers reduced motion; pausing/stopping never touches the input's value.
export function useTypewriterPlaceholder(active: boolean): { text: string; animating: boolean } {
  const [text, setText] = useState("");
  const reduced = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => true
  );

  const animating = active && !reduced;

  useEffect(() => {
    if (!animating) return;
    let phrase = 0;
    let len = 0;
    let erasing = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const full = PHRASES[phrase];
      if (!erasing) {
        len += 1;
        setText(full.slice(0, len));
        if (len === full.length) {
          erasing = true;
          timer = setTimeout(tick, 1600);
          return;
        }
        timer = setTimeout(tick, 70);
      } else {
        len -= 1;
        setText(full.slice(0, len));
        if (len === 0) {
          erasing = false;
          phrase = (phrase + 1) % PHRASES.length;
          timer = setTimeout(tick, 350);
          return;
        }
        timer = setTimeout(tick, 35);
      }
    };
    timer = setTimeout(tick, 500);
    return () => clearTimeout(timer);
  }, [animating]);

  return { text: animating ? text : "", animating };
}
