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

export function proofFacts(src: SnapshotSource, local: LocalProof, network: Network): Fact[] {
  const s = src.snapshot;
  const keys = s.accessKeys;
  const keyFact: Fact = {
    id: "keys",
    title: "Access keys on the vault account",
    value: `${keys} access key${keys === 1 ? "" : "s"}`,
    command: `near account list-keys ${s.vaultId} network-config ${network} now`,
  };
  if (keys !== 0 && src.kind === "sample") keyFact.note = "This rehearsal vault has keys. The final vault is born without them.";
  const codeHex = base58ToHex(s.account.codeHash);
  const wasmUrl = safeHttpsUrl(s.agent.wasmUrl);
  return [
    keyFact,
    {
      id: "code",
      title: "Deployed contract code",
      value: codeHex ? `sha256 ${codeHex}` : `code_hash ${s.account.codeHash}`,
      command: "cd contracts/vault && cargo near build reproducible-wasm && shasum -a 256 target/near/foundling_vault.wasm",
      note: "The reproducible build runs in Docker, at the commit that built this vault.",
    },
    {
      id: "strategy",
      title: "Strategy WASM the vault pins",
      value: `wasm_hash ${s.agent.wasmHash}`,
      command: wasmUrl ? `curl -sL ${shellQuote(wasmUrl)} | shasum -a 256` : "The pinned binary URL is not https, so no command is offered.",
      note: "To rebuild it from source, run strategy/build.sh at the commit that built this binary.",
      href: wasmUrl ?? undefined,
    },
    {
      id: "commitment",
      title: "Sealed parameters",
      value: `commitment ${s.agent.commitment}`,
      command: "python3 verify.py commitment",
      note: s.revealed ? undefined : local.synthetic ? "Sealed until reveal. The command checks the synthetic fixture in proofs/." : "Sealed until reveal.",
    },
  ];
}
