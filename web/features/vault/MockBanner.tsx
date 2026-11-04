/** Every page of the testnet deployment says so (WEBSITE §4). */
export function MockBanner() {
  return (
    <div role="note" data-testid="mock-banner" className="border-b bg-muted px-4 py-1.5 text-center text-[12px] font-medium tracking-wide">
      MOCK · testnet rehearsal with mock tokens and a mock oracle. Not the final vault.
    </div>
  );
}
