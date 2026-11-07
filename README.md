# Foundling

> A USDC vault on NEAR that is designed to be born without keys, to trade only inside caps its contract enforces, and to let depositors leave without us.

Foundling is a USDC vault on NEAR. Its strategy runs sealed in an OutLayer TEE, and the vault contract, not the agent, enforces the spending caps, the exit path and the roles.
The problem: an autonomous trading agent asks depositors to trust its operator with both the funds and the rules. Foundling bounds what operator and agent can do on chain, and commits to the strategy parameters by hash so they can be revealed later and past decisions replayed.

**Do** `python3 verify.py` (offline, standard library only). **See** this last line; the fixtures are synthetic (the `NOTE` line of the full output says so), so it checks the verifier, not a real vault:
```
SUMMARY pass=2 skip=0 fail=0 mode=offline keys=none
```

| Claim (status from [claims.json](claims.json)) | Evidence | Command | Runs | Status |
| --- | --- | --- | --- | --- |
| Each trade stays inside caps the contract enforces. | [`proofs/attack/reproducible/over-cap.json`](proofs/attack/reproducible/over-cap.json) | `make attack-proofs` | 0b, sandbox | pass |
| You can redeem while trading is frozen, halted or stuck. | tests: [`contracts/vault/src/tests/recovery.rs`](contracts/vault/src/tests/recovery.rs)<br>[`contracts/vault/src/tests/flows.rs`](contracts/vault/src/tests/flows.rs) | `cargo test --manifest-path contracts/vault/Cargo.toml redeem` | 0b, offline | pass |
| Every cycle links to its transactions and its proof. | tests: [`cli/tests/check.rs`](cli/tests/check.rs) | `git checkout <verifier_commit> && python3 tools/fetch_proof.py --chain <network> --vault <vault> --collateral-bin COLLATERAL.bin --out proof.json <trigger_tx> && cargo run --manifest-path cli/Cargo.toml -- check proof.json` | 1, live | pass |
| A NEAR AI model in a TEE reads the latest crypto headlines and can only hold back a buy. Its signed answer is checked offline. | [`cli/fixtures/testnet-advisor-proof.json`](cli/fixtures/testnet-advisor-proof.json) | `cargo run --manifest-path cli/Cargo.toml -- check cli/fixtures/testnet-advisor-proof.json`<br>`cargo test --manifest-path strategy/Cargo.toml advisor` | 0b, offline<br>0b, offline | pass |

```
[Depositor] <-> [Vault contract] <-> [OutLayer TEE: sealed strategy + NEAR AI advisor];  [Keeper bot] -> [Vault contract]
```

- **Video:** not recorded yet. The video and a timestamped transcript will be added under docs/video.
- **Try to rob it:** `make attack-lab-full` builds the contracts and runs 15 attacks against a local sandbox with throwaway keys. The last line should be `PASS=15 FAIL=0 NOT_IMPLEMENTED=0 ERROR=0` (details below).

## Not proven yet

- `born-without-keys` (skip): The vault is meant to be born without keys. That check has not run on the final vault yet, and the testnet rehearsal vault still has one key.
- `g1-confidentiality` (skip): Sealing is designed. It is checked on this vault once the parameters are revealed and replayed.
- `near-intents` (skip): Cross-chain deposits through NEAR Intents are in testing.
- No third-party audit of the vault code has been done.
- No final mainnet vault is recorded in this repository yet (the file proofs/mainnet.json does not exist).
- The sandbox runs the vault against mocks of the price oracle, Rhea (the swap venue), OutLayer and the tokens (`contracts/mock-oracle`, `contracts/mock-ref`, `contracts/mock-outlayer`, `contracts/mock-token`). The Attack Lab results hold for the vault against these mocks, not against the real services.
- The fixtures behind `python3 verify.py` are synthetic.

## Try to rob it

```
make attack-lab-full
```

- Needs the Rust toolchain pinned in `rust-toolchain.toml`, `cargo-near`, and network access once, to download the `neard` sandbox binary.
- It builds the five contracts, then runs the 15 core attacks listed in `tools/attack-registry.json` one at a time, each limited to 300 seconds. Allow about 15 minutes after the first build on a laptop.
- Exit 0 and the last line `PASS=15 FAIL=0 NOT_IMPLEMENTED=0 ERROR=0` mean every attack was refused or contained. `FAIL` means one got through; that is the result to report.
- The sandbox is a node started on your machine for the run. The accounts it creates, and their keys, exist for that run only. No key is read from or written to this repository.
- Results are written to the git-ignored `proofs/attack/local/`. The files in `proofs/attack/reproducible/` come from the vault built reproducibly in a pinned image (`make attack-proofs`, needs Docker); an attack without a file there has only the local result.
- After a first build, `make attack-lab` runs the attacks again without building. If you switch branches first, run `make wasm` again, or every attack reports `ERROR`.

## Who holds which key

**Who holds which key.** Foundling is built by a team of two, so the roles below are split between two teammates, not between independent parties. The lead holds the governor and keeper roles and deployed the vault. The other teammate holds only the guardian role. On the vault, the guardian account can call only `freeze` and `cancel_keeper_change`; the contract enforces this. Its everyday key is a function-call key limited to those two methods, and its full-access key is kept offline. This split limits one leaked key. A leaked keeper key can run cycles inside the caps, and a leaked guardian key can stop trading but cannot move funds. It does not limit the lead: the governor can unfreeze at once and can replace the guardian after a 24-hour timelock that the guardian cannot cancel. Whoever holds these keys, the contract still enforces the caps, moves tokens only to share holders and Rhea, and keeps `redeem` open while frozen. Depositor accounts are ordinary accounts: anyone holding a depositor's key can redeem that depositor's shares.

## What you still have to trust

| Guarantee | Still trusted |
| --- | --- |
| Secrecy of the parameters | Intel TDX and NVIDIA hardware; the OutLayer operator, whose worker account holds full-access keys; NEAR AI Cloud, which sees the prompt inside its TEE; the creator of the OutLayer secrets entry. |
| Bounded loss | The vault code (tested by us, not audited by a third party); the price oracle `aggregate-oracle.near` and the DAOs that can upgrade or pause it; Rhea, with its owner and guardian; the lead's keys (governor and keeper) and the partner's guardian key, as described above. |
| Exit | The vault code; the USDC token contract and its issuer, who can blocklist, pause and upgrade; NEAR itself; Rhea only for funds that are mid-swap. Not the agent, the keeper, OutLayer or the governor. |
| Traceability | The open-source verifier; OutLayer's result for the pinned code hash; NEAR AI for the signature on its inference, with the inference image and model weights trusted to NEAR AI. |

The full threat model, with the worst case in numbers, is in [docs/SPEC.md](docs/SPEC.md) section 9.

## Disclaimer

Foundling is a technical demo made for the NEAR Hackathon. It has not been audited by a third party. It is not an invitation to deposit, and nothing here is financial advice: do not put in funds you cannot lose. The demo limits deposits (`tvl_cap`, `per_user_cap` and `min_deposit`, see [docs/SPEC.md](docs/SPEC.md) section 3.6) and takes no on-chain fee.

## Provenance

- This is a new project. Its git history starts on 2026-11-01. Everything made before that date is disclosed here as baseline: the design notes and the spike experiments that were run outside this repository (see [docs/SPEC.md](docs/SPEC.md) section 6). The hackathon FAQ (Q-001) counts code from the announcement on 2026-10-19 as inside the window; we list everything before 2026-11-01 as baseline anyway.
- The SP1a spike (a test of OutLayer WASM runs) is kept in `spikes/sp1a/` and `strategy/src/bin/sp1a_probe.rs`.
- Code, tests and documents were written with AI assistance. Commits made in Claude Code sessions (Anthropic) carry a `Claude-Session:` trailer in the commit message. At run time the strategy also calls a NEAR AI Cloud model as an advisor.
- Libraries, from the manifests: `near-sdk` (the vault and the mocks), `near-workspaces` (sandbox tests), `dcap-qvl` and `k256` (checking attestations and signatures), Next.js and React (the website), Hono (the API), Drizzle ORM and `pg` (the indexer). Services are named as text only: OutLayer, NEAR AI Cloud, Rhea, NEAR Intents (1Click) and an aggregate price oracle. The full list of dependencies, with licenses, is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Team

Foundling is built by two people: the lead (GitHub: zakyirsyaad) and the partner (GitHub: maziazi). The lead holds the governor and keeper roles; the partner holds the guardian role.

## More

- [docs/PLAN.md](docs/PLAN.md) and [docs/SPEC.md](docs/SPEC.md) are the sources of truth for scope and design; [AGENTS.md](AGENTS.md) lists the build commands and the working rules.
- License: MIT, see [LICENSE](LICENSE).
