/** Ready to publish: no "TBD" left and an https link to the 1Click terms. */
export function termsReady(v: { date: string; oneClickTosUrl: string }): boolean {
  if (v.date === "TBD" || v.oneClickTosUrl === "TBD") return false;
  try {
    return new URL(v.oneClickTosUrl).protocol === "https:";
  } catch {
    return false;
  }
}
