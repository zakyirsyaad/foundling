import { GeistMono } from "geist/font/mono";
import localFont from "next/font/local";

/** Inter with the optical-size axis, self-hosted (OFL, see THIRD_PARTY_NOTICES.md). */
export const inter = localFont({
  src: [
    { path: "./fonts/InterVariable-latin-opsz.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/InterVariable-latin-ext-opsz.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});

export const geistMono = GeistMono;
