/**
 * The CSP nonce of the document as it was first loaded. After a client-side navigation the server
 * sends a new x-nonce, but the page still runs under its first policy, so near-connect must use this.
 */
export function pageNonce(fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const script = document.querySelector<HTMLScriptElement>("script[nonce]");
  return script?.nonce || fallback;
}
