/** Single-quotes a value for a POSIX shell, so a copied command runs exactly what it shows. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A NEAR account id, 2–64 chars. Anything a wallet or API returns goes through this before use. */
export function isNearAccount(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && NEAR_ACCOUNT.test(id);
}
