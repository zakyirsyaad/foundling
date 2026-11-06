"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(cb: () => void) {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

/** Muted looping video with captions; the poster alone under reduced motion or with no file yet. */
export function Video({ src, poster, captions, alt, loop = false }: { src: string | null; poster: string | null; captions: string | null; alt: string; loop?: boolean }) {
  const reduced = useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => true);
  if (!src) {
    return (
      <div className="fm-video fm-video-empty" role="img" aria-label={alt}>
        Video coming soon
      </div>
    );
  }
  if (reduced) {
    // eslint-disable-next-line @next/next/no-img-element
    return poster ? <img className="fm-video" src={poster} alt={alt} /> : <div className="fm-video fm-video-empty" role="img" aria-label={alt} />;
  }
  return (
    <video data-testid="video-element" className="fm-video" src={src} poster={poster ?? undefined} muted autoPlay loop={loop} playsInline aria-label={alt}>
      {captions ? <track kind="captions" src={captions} srcLang="en" label="English" default /> : null}
    </video>
  );
}
