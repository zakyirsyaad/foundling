/** The origin chains a visitor can use now, as a phrase: "Base", "Base or Ethereum", "Base, Arbitrum or Ethereum". */
export function enabledChainNames(chains: readonly { label: string; enabled: boolean }[]): string {
  const names = chains.filter((c) => c.enabled).map((c) => c.label);
  if (names.length === 0) return "another chain";
  if (names.length === 1) return names[0] ?? "another chain";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
