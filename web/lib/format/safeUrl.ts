/** A link that may leave the page: https only, no credentials in it. Anything else is not linked. */
export function safeHttpsUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}
