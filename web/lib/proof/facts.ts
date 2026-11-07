import type { Network } from "@/config/deployment";
import { safeHttpsUrl } from "@/lib/format/safeUrl";
import { shellQuote } from "@/lib/format/shell";
import type { LocalProof, SnapshotSource } from "./local";

export interface Fact {
  id: "keys" | "code" | "strategy" | "commitment";
  title: string;
  value: string;
  command: string;
  note?: string;
  /** An https link to the artifact itself, only when the URL is safe to link. */
  href?: string;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** NEAR prints `code_hash` in base58; `sha256sum` prints hex. Show both sides in hex. */
export function base58ToHex(text: string): string | null {
  let n = 0n;
  for (const ch of text) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const zeros = text.length - text.replace(/^1+/, "").length;
  const body = n === 0n ? "" : n.toString(16);
  return "00".repeat(zeros) + (body.length % 2 ? `0${body}` : body);
}

const TITLES: Record<Fact["id"], string> = {
  keys: "Access keys on the vault account",
  code: "Deployed contract code",
  strategy: "Strategy WASM the vault pins",
  commitment: "Sealed parameters",
};
const CODE_COMMAND = "cd contracts/vault && cargo near build reproducible-wasm && shasum -a 256 target/near/foundling_vault.wasm";
const CODE_NOTE = "The reproducible build runs in Docker, at the commit that built this vault.";
const STRATEGY_NOTE = "To rebuild it from source, run strategy/build.sh at the commit that built this binary.";
const COMMITMENT_COMMAND = "python3 verify.py commitment";
const UNREADABLE = "Not readable right now";

const keysCommand = (vaultId: string, network: Network) => `near account list-keys ${vaultId} network-config ${network} now`;

export function proofFacts(src: SnapshotSource, local: LocalProof, network: Network): Fact[] {
  const s = src.snapshot;
  const keys = s.accessKeys;
  const keyFact: Fact = {
    id: "keys",
    title: TITLES.keys,
    value: `${keys} access key${keys === 1 ? "" : "s"}`,
    command: keysCommand(s.vaultId, network),
  };
  if (keys !== 0 && src.kind === "sample") keyFact.note = "This rehearsal vault has keys. The final vault is born without them.";
  const codeHex = base58ToHex(s.account.codeHash);
  const wasmUrl = safeHttpsUrl(s.agent.wasmUrl);
  return [
    keyFact,
    {
      id: "code",
      title: TITLES.code,
      value: codeHex ? `sha256 ${codeHex}` : `code_hash ${s.account.codeHash}`,
      command: CODE_COMMAND,
      note: CODE_NOTE,
    },
    {
      id: "strategy",
      title: TITLES.strategy,
      value: `wasm_hash ${s.agent.wasmHash}`,
      command: wasmUrl ? `curl -sL ${shellQuote(wasmUrl)} | shasum -a 256` : "The pinned binary URL is not https, so no command is offered.",
      note: STRATEGY_NOTE,
      href: wasmUrl ?? undefined,
    },
    {
      id: "commitment",
      title: TITLES.commitment,
      value: `commitment ${s.agent.commitment}`,
      command: COMMITMENT_COMMAND,
      note: s.revealed ? undefined : local.synthetic ? "Sealed until reveal. The command checks the synthetic fixture in proofs/." : "Sealed until reveal.",
    },
  ];
}

/** The same four facts when the RPC read failed: no values, but every command still reads the chain itself. */
export function unreadableFacts(vaultId: string, network: Network): Fact[] {
  return [
    { id: "keys", title: TITLES.keys, value: UNREADABLE, command: keysCommand(vaultId, network) },
    { id: "code", title: TITLES.code, value: UNREADABLE, command: CODE_COMMAND, note: CODE_NOTE },
    {
      id: "strategy",
      title: TITLES.strategy,
      value: UNREADABLE,
      command: `near contract call-function as-read-only ${vaultId} agent json-args '{}' network-config ${network} now`,
      note: "This prints the pinned wasm_url and wasm_hash. Download the binary and compare its sha256.",
    },
    { id: "commitment", title: TITLES.commitment, value: UNREADABLE, command: COMMITMENT_COMMAND },
  ];
}
