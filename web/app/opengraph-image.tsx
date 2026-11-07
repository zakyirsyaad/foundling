import { ImageResponse } from "next/og";

import { HERO } from "@/content/landing";
import { SITE } from "@/content/seo";
import { splitFirstSentence } from "@/lib/format/text";

/**
 * The share card for every page. Its text states no claim, so it never needs claims.json.
 * Pages with their own openGraph point at it through SHARE_IMAGE in lib/seo/site.ts.
 */
export const alt = `${SITE.name}, a USDC vault on NEAR`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#171717";
const MUTED = "#737373";
const PAPER = "#ffffff";
const RULE = "#e5e5e5";

export default function OpengraphImage() {
  const { head, rest } = splitFirstSentence(HERO.lead);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 80, background: PAPER, color: INK }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 36, fontWeight: 600, letterSpacing: -1 }}>
          <svg width="48" height="48" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="7" fill={INK} />
            <path d="M11 8h11v3.5h-7v3.25h6v3.5h-6V24h-4z" fill={PAPER} />
          </svg>
          {SITE.name}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: -3, lineHeight: 1.05 }}>{head}</div>
          {rest ? <div style={{ fontSize: 34, lineHeight: 1.4, color: MUTED, maxWidth: 940 }}>{rest}</div> : null}
        </div>
        <div style={{ display: "flex", borderTop: `2px solid ${RULE}`, paddingTop: 24, fontSize: 24, color: MUTED }}>Not audited · hackathon build</div>
      </div>
    ),
    size,
  );
}
