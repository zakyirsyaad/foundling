/**
 * Fails when the website's call table or event list drifts from the vault's Rust source
 * (WEBSITE §8, Kesesuaian).  npm run -w web check:contract
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { KNOWN_EVENTS } from "@/lib/cycles/events";
import { CALLS } from "@/lib/wallet/calls";

/** Calls whose contract minimum is ENTRY_GAS + n·(FT_TRANSFER_GAS + ON_XFER_GAS) (`require_transfer_gas`). */
const TRANSFER_CALLS = { redeem: 2, cancel_deposit: 1, claim_bucket: 1, withdraw_claimable: 1 } as const;

function readSources(dir: string): string {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".rs"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

function gasConstants(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of src.matchAll(/const\s+([A-Z_]+)\s*:\s*Gas\s*=\s*Gas::from_tgas\((\d+)\)/g)) out.set(m[1]!, Number(m[2]));
  return out;
}

function eventNames(src: string): Set<string> {
  return new Set([...src.matchAll(/emit\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));
}

export function checkContract(srcDir: string): { ok: boolean; problems: string[] } {
  const src = readSources(srcDir);
  const gas = gasConstants(src);
  const problems: string[] = [];
  const need = (name: string): number | null => {
    const v = gas.get(name);
    if (v === undefined) problems.push(`${name} not found in the vault source`);
    return v ?? null;
  };
  const entry = need("ENTRY_GAS");
  const transfer = need("FT_TRANSFER_GAS");
  const onXfer = need("ON_XFER_GAS");
  const advance = need("MIN_ADVANCE_GAS");
  if (entry !== null && transfer !== null && onXfer !== null) {
    for (const [call, n] of Object.entries(TRANSFER_CALLS)) {
      const contract = entry + n * (transfer + onXfer);
      const site = CALLS[call as keyof typeof CALLS].minGasTgas;
      if (site !== contract) problems.push(`${call}: contract minimum is ${contract} TGas, the call table says ${site}`);
    }
  }
  if (advance !== null && CALLS.advance.minGasTgas !== advance) problems.push(`advance: contract minimum is ${advance} TGas, the call table says ${CALLS.advance.minGasTgas}`);
  const emitted = eventNames(src);
  const known = new Set(KNOWN_EVENTS);
  for (const e of emitted) if (!known.has(e)) problems.push(`event ${e} is emitted by the vault but missing from KNOWN_EVENTS`);
  for (const e of known) if (!emitted.has(e)) problems.push(`event ${e} is in KNOWN_EVENTS but the vault never emits it`);
  return { ok: problems.length === 0, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] ?? path.resolve(process.cwd(), "../contracts/vault/src");
  const result = checkContract(dir);
  for (const p of result.problems) console.error(p);
  console.log(result.ok ? "call table and events match the vault source" : `${result.problems.length} problem(s)`);
  process.exit(result.ok ? 0 : 1);
}
