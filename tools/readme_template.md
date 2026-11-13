# Foundling

> A USDC vault on NEAR that is designed to be born without keys, to trade only inside caps its contract enforces, and to let depositors leave without us.

Foundling is a USDC vault on NEAR. Its strategy runs sealed in an OutLayer TEE, and the vault contract, not the agent, enforces the spending caps, the exit path and the roles.
The problem: an autonomous trading agent asks depositors to trust its operator with both the funds and the rules. Foundling bounds what operator and agent can do on chain, and commits to the strategy parameters by hash so they can be revealed later and past decisions replayed.

**Do** `python3 verify.py` (offline, standard library only). **See** this last line; the fixtures are synthetic (the `NOTE` line of the full output says so), so it checks the verifier, not a real vault:
```
{{verify_last_line}}
```

{{claims_table}}

```
[Depositor] <-> [Vault contract] <-> [OutLayer TEE: sealed strategy + NEAR AI advisor];  [Keeper bot] -> [Vault contract]
```

- **Video:** not recorded yet. The video and a timestamped transcript will be added under docs/video.
- **Try to rob it:** `make attack-lab-full` builds the contracts and runs 16 attacks against a local sandbox with throwaway keys. The last line should be `PASS=16 FAIL=0 NOT_IMPLEMENTED=0 ERROR=0` (details below).

## Not proven yet

{{not_proven}}
- No third-party audit of the vault code has been done.
- {{mainnet_status}}
- The sandbox runs the vault against mocks of the price oracle, Rhea (the swap venue), OutLayer and the tokens (`contracts/mock-oracle`, `contracts/mock-ref`, `contracts/mock-outlayer`, `contracts/mock-token`). The Attack Lab results hold for the vault against these mocks, not against the real services.
- The fixtures behind `python3 verify.py` are synthetic.

## The vault on mainnet

- **Vault:** `vault.foundling.near`, live since 2026-11-13 with 4 USDC from the lead. **Website:** https://foundling.xyz
- **Do** `python3 verify.py --live --vault vault.foundling.near --network mainnet --expect-code-hash 9ab6b6d62d627f403f5aa8719cc420fea16dc67ceeffb250d21c09aee5aa5a8a` (read-only, public RPC, no key). **See** `PASS keys`, `PASS code_hash` and `PASS decision`. `commitment` is `SKIP` until the parameters are revealed after `reveal_after` (2026-11-13 12:00 UTC).
- Every transaction, from the keyless birth to a redeem while frozen, is listed in [`proofs/mainnet.json`](proofs/mainnet.json). The `init` arguments are in [`proofs/mainnet-init-args.json`](proofs/mainnet-init-args.json); their sha256 equals the `args_hash` in the vault's `initialized` event.

## Try the website

- **Do** open https://foundling.xyz/app (no wallet needed). **See** the vault's stage, its book in USDC and wNEAR, the limits the contract enforces, and the footer line `0 access keys · code hash 9ab6b6…`.
- **Do** open https://foundling.xyz/app/cycles and pick a cycle. **See** its timeline, the decision the strategy returned, the advisor's risk score with its one-sentence reason, and the transaction hashes.
- **Do** open https://foundling.xyz/proof. **See** four facts read from the chain (access keys, vault code hash, strategy WASM hash, commitment), each with a command that needs no key.
- The website only reads. It serves from Vercel, reads chain state from public RPC nodes, and reads cycle history from our indexer; deposits and redeems are signed in your own wallet.

## One cycle, end to end

Cycle 1 on mainnet, transaction `AoW2epeLpgbjjQa9p9bhiyhwHaCJvZUAvo6Vt49oYifW` (signer `keeper.foundling.near`, 2026-11-13 03:29 UTC):

1. The keeper calls `trigger_cycle`. The vault checks stage, cooldown and budget, mints the queued 5 USDC deposit into shares, and records nonce 1.
2. The vault, not the keeper, calls OutLayer with the strategy's URL and hash, its book (5 USDC, 0 wNEAR), its limits, and 0.05 NEAR attached from its own balance.
3. OutLayer runs the strategy WASM `b15a66b4…` in a TEE. The strategy opens the sealed parameters, reads the NEAR price from Rhea pool 4512 (3.3724 USD) and from Kraken (3.3747 USD, a gap of 0.07%), and asks a NEAR AI Cloud model for a risk score.
4. The model answers risk 15 of 100, confidence 85: "No direct NEAR/Rhea/USDC threat; only broad market dip and unrelated exchange/regulatory news".
5. The price rule reads risk-off and calls for a sell, but the vault holds no wNEAR, so the strategy returns `action: none`. The vault stores the full decision, with the commitment and a digest of the inputs, and emits `hold`. No funds move.
6. OutLayer charges 0.00163 NEAR for 5.8 seconds of compute and refunds 0.04837 NEAR to the vault.

As of 2026-11-13 07:46 UTC the keeper bot had run cycles 2 to 9 unattended, and every cycle ended in `Hold`: no swap has executed on mainnet yet. The swap path is exercised by unit tests ([`contracts/vault/src/tests/swap.rs`](contracts/vault/src/tests/swap.rs)), in the sandbox ([`sandbox/tests/recovery.rs`](sandbox/tests/recovery.rs)) and by the Attack Lab.

### A cycle where the model changed the trade

On the testnet rehearsal vault `vault.fdl-adv3-139b75.testnet` (the same vault build `9ab6b6d6…` and the same strategy WASM `b15a66b4…` as mainnet), cycle 3 ran on 2026-11-13 with 5 test USDC:

- The price rule read risk-on. The model answered risk 15 of 100: "Broad market jitters and BTC weakness, but no direct threat to NEAR Protocol, Rhea, or USDC on NEAR."
- The strategy cut the base buy of 0.05 USDC by that 15%, to 0.0425 USDC (`amount_in: 42500`), and the keeper executed it: 0.0425 USDC for 0.01206 wNEAR.
- On testnet the pool and the price oracle are our mocks. The prices the strategy read, the TEE run and the model's signed answer are real.
- Transactions on testnet: trigger `DUpsCut376WP4gQvGRBrbbFbCTc481UATAQVsMrdL8En`, execute `ApRB2E682ZjwCqny2sTQU8BxSq22EYbJroZ8PKQ34Hev`.
- **Do** `cargo run --manifest-path cli/Cargo.toml -- check cli/fixtures/testnet-risk-manager-proof.json`. **See** `PASS nonce 3 replay`, `PASS nonce 3 ai signer` and `SUMMARY pass=21 skip=0 fail=0`: the decision is reproduced from the revealed parameters, and the model's answer carries a signature from its TEE.

## Tracks

Keywords from the hackathon tracks are named only where this repository has code and evidence for them.

| Track | What is built | Evidence | Not claimed |
| --- | --- | --- | --- |
| `security` | AGENT SECURITY, FUNCTION CALL KEYS, TEE ATTESTATION. The contract enforces the caps, the vault account has no keys, the keeper and guardian sign with function-call keys limited to named vault methods, and the guardian can freeze trading. | `python3 verify.py --live …` above; `make attack-lab-full`; key state and transactions in [`proofs/mainnet.json`](proofs/mainnet.json) | A third-party audit. |
| `privacy` | PRIVATE AI, TEE, NEAR AI CLOUD. The strategy parameters are sealed in an OutLayer secret bound to the strategy's hash and to the vault account, with a salted commitment on chain. The advisor is a NEAR AI Cloud model whose signed answer is checked offline. | Commitment in [`proofs/mainnet.json`](proofs/mainnet.json); `cargo run --manifest-path cli/Cargo.toml -- check cli/fixtures/testnet-advisor-proof.json` | Reveal and replay on the mainnet vault, until it has run (see "Not proven yet"). |
| `defi` | TRADING. A vault that holds USDC and wNEAR, trades on Rhea inside on-chain caps, and pays redeems pro rata in kind. | Sandbox tests and the Attack Lab; redeem on mainnet in [`proofs/mainnet.json`](proofs/mainnet.json) | A swap on mainnet (none has executed yet), NEAR INTENTS (in testing), CHAIN SIGNATURES. |
| `agents` | AGENT COMMERCE, in one narrow sense: each cycle the vault pays for the agent's compute from an on-chain budget (`ops_budget`), with a receipt. | Step 6 above; `first_cycle` in [`proofs/mainnet.json`](proofs/mainnet.json) | Hiring other agents, revenue, NEAR INTENTS, CHAIN SIGNATURES. |

## Try to rob it

```
make attack-lab-full
```

- Needs the Rust toolchain pinned in `rust-toolchain.toml`, `cargo-near`, and network access once, to download the `neard` sandbox binary.
- It builds the five contracts, then runs the 16 core attacks listed in `tools/attack-registry.json` one at a time, each limited to 300 seconds. Allow about 15 minutes after the first build on a laptop.
- Exit 0 and the last line `PASS=16 FAIL=0 NOT_IMPLEMENTED=0 ERROR=0` mean every attack was refused or contained. `FAIL` means one got through; that is the result to report.
- `freeze-race` is the slowest, about 4 minutes on a quiet laptop. On a busy machine it can pass the 300-second limit and report `ERROR` (a timeout, not a failed attack); run it alone with `python3 tools/attack.py run freeze-race`.
- The sandbox is a node started on your machine for the run. The accounts it creates, and their keys, exist for that run only. No key is read from or written to this repository.
- Results are written to the git-ignored `proofs/attack/local/`. The files in `proofs/attack/reproducible/` come from the vault built reproducibly in a pinned image (`make attack-proofs`, needs Docker); an attack without a file there has only the local result.
- After a first build, `make attack-lab` runs the attacks again without building. If you switch branches first, run `make wasm` again, or every attack reports `ERROR`.

## Who holds which key

{{roles_text}}

## What you still have to trust

| Guarantee | Still trusted |
| --- | --- |
| Secrecy of the parameters | Intel TDX and NVIDIA hardware; the OutLayer operator, whose worker account holds full-access keys; NEAR AI Cloud, which sees the prompt inside its TEE; the creator of the OutLayer secrets entry. |
| Bounded loss | The vault code (tested by us, not audited by a third party); the price oracle `aggregate-oracle.near` and the DAOs that can upgrade or pause it; Rhea, with its owner and guardian; the lead's keys (governor and keeper) and the partner's guardian key, as described above. |
| Exit | The vault code; the USDC token contract and its issuer, who can blocklist, pause and upgrade; NEAR itself; Rhea only for funds that are mid-swap. Not the agent, the keeper, OutLayer or the governor. |
| Traceability | The open-source verifier; OutLayer's result for the pinned code hash; NEAR AI for the signature on its inference, with the inference image and model weights trusted to NEAR AI. |

The full threat model, with the worst case in numbers, is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) (English) and in [docs/SPEC.md](docs/SPEC.md) section 9 (Indonesian, the source).

## Disclaimer

Foundling is a technical demo made for the NEAR Hackathon. It has not been audited by a third party. It is not an invitation to deposit, and nothing here is financial advice: do not put in funds you cannot lose. The demo limits deposits (`tvl_cap`, `per_user_cap` and `min_deposit`, see [docs/SPEC.md](docs/SPEC.md) section 3.6) and takes no on-chain fee.

## Provenance

- This is a new project. Its git history starts on 2026-11-01. Everything made before that date is disclosed here as baseline: the design notes and the spike experiments that were run outside this repository (see [docs/SPEC.md](docs/SPEC.md) section 6). The hackathon FAQ (Q-001) counts code from the announcement on 2026-10-19 as inside the window; we list everything before 2026-11-01 as baseline anyway.
- The SP1a spike (a test of OutLayer WASM runs) is kept in `spikes/sp1a/` and `strategy/src/bin/sp1a_probe.rs`.
- Code, tests and documents were written with AI assistance. Commits made in Claude Code sessions (Anthropic) carry a `Claude-Session:` trailer in the commit message. At run time the strategy also calls a NEAR AI Cloud model as an advisor.
- Libraries, from the manifests: `near-sdk` (the vault and the mocks), `near-workspaces` (sandbox tests), `dcap-qvl` and `k256` (checking attestations and signatures), Next.js and React (the website), Hono (the API), Drizzle ORM and `pg` (the indexer). Services are named as text only: OutLayer, NEAR AI Cloud, Rhea, NEAR Intents (1Click) and an aggregate price oracle. The full list of dependencies, with licenses, is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Team

Foundling is built by two people: the lead (GitHub: zakyirsyaad) and the partner (GitHub: maziazi). The lead holds the governor and keeper roles; the partner holds the guardian role.

## Repository map

| Path | What it is |
| --- | --- |
| `contracts/vault/src/` | The vault contract: deposits, redeem, cycles, swaps, limits, recovery, roles, reveal. |
| `strategy/` | The strategy and the NEAR AI advisor, built to WASM for OutLayer. |
| `cli/` | `foundling-verify`: checks a cycle's proof bundle (attestation, AI signature, replay). |
| `verify.py`, `verify_live.py` | Standard-library verifiers: offline fixtures, and read-only checks of a live vault. |
| `sandbox/` | Tests against a local NEAR node with mock oracle, Rhea, OutLayer and tokens. |
| `tools/attacks/`, `tools/keeper/` | The Attack Lab and the keeper bot. |
| `web/`, `api/`, `indexer/`, `packages/db/`, `deploy/` | The website, its read-only API, the indexer and its database, and the server setup. |
| `proofs/` | Committed evidence: the mainnet record, Attack Lab results, verifier fixtures. |

Needed to build everything: Rust 1.97.1 with the wasm targets, `cargo-near` 0.22.0, Node 24 and Python 3.9 or newer. `python3 verify.py` needs Python only. The commands are in [AGENTS.md](AGENTS.md).

## More

- [docs/PLAN.md](docs/PLAN.md) and [docs/SPEC.md](docs/SPEC.md) are the sources of truth for scope and design; [AGENTS.md](AGENTS.md) lists the build commands and the working rules.
- License: MIT, see [LICENSE](LICENSE).
