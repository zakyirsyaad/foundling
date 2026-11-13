# AGENTS.md

Baca `docs/PLAN.md`, lalu `docs/SPEC.md`. Keduanya sumber kebenaran proyek.

## Gambaran proyek

Foundling adalah vault USDC di NEAR: kontrak menegakkan cap, jalur keluar, dan peran; strategi trading berjalan tersegel di OutLayer TEE; setiap siklus dapat diverifikasi ulang. Monorepo Rust + TypeScript: kontrak `near-sdk`, strategi WASM (`wasm32-wasip2`), verifier Rust/Python, website Next.js 16, API Hono, indexer Drizzle/Postgres. Node >= 24; Rust 1.97.1 (`rust-toolchain.toml`); Python 3.9+ stdlib.

## Perintah

Prasyarat: Rust 1.97.1 + target wasm, cargo-near 0.22.0, Node 24, Python 3.9+. Install JS dari root: `npm ci --ignore-scripts`.

- Build kontrak: `cd contracts/vault && cargo near build non-reproducible-wasm` (untuk build yang diuji CI/sandbox pakai `make wasm`, yang menambahkan `--no-embed-abi`)
- Tes kontrak: `cd contracts/vault && cargo test`; versi CI: `cargo test --locked`; satu tes: tambah filter, mis. `cargo test --locked redeem`
- Audit impor WASM: `python3 tools/wasm_imports.py contracts/vault/target/near/foundling_vault.wasm tools/allowlist.txt`
- Tes semua kontrak + strategi: `make quick`; build kelima kontrak: `make wasm`
- Sandbox (build wasm dulu; unduh `neard` saat pertama): `make sandbox`; satu file tes: `cd sandbox && cargo test --locked --test deposits`
- Tes strategi: `cd strategy && cargo test --locked`; rehearsal: `cargo test --locked --features rehearsal`
- Build strategi (satu-satunya cara): `cd strategy && ./build.sh`; rehearsal: `./build.sh --features rehearsal`
- Tes verifier CLI: `cd cli && cargo test --locked`; jalankan: `cargo run --manifest-path cli/Cargo.toml -- check <proof.json>`
- Verifier offline: `make verify`; strict (SKIP gagal): `make verify-strict`; live baca-saja: `python3 verify_live.py --vault <id> --network testnet` (atau `mainnet`)
- Attack Lab: `make attack-lab-full` (build + 16 serangan); setelah wasm ada: `make attack-lab`; satu serangan: `python3 tools/attack.py run freeze-race`; strict: `python3 tools/attack.py run-all --strict`
- Bukti reproducible (Docker, menulis file yang di-commit): `make attack-proofs`
- README (dihasilkan): `make readme`; cek seperti CI: `python3 tools/readme.py --check`
- Web: `npm run -w web <script>` dengan `dev` (port 3100; butuh env, lihat `web/README.md`), `build`, `test`, `test:coverage`, `e2e`, `lint`, `typecheck`, `check:contract`, `depcruise`
- Satu tes web: `npm run -w web test -- tests/unit/foo.test.ts`; satu E2E: `npm run -w web e2e -- e2e/deposit.spec.ts`
- Backend tes: `npm run -w @foundling/db test`; `npm run -w @foundling/indexer test:coverage`; `npm run -w @foundling/api test:coverage`; `npm run -w @foundling/deploy test`. Typecheck: `npm run -w <workspace> typecheck` (deploy: `npx -w @foundling/deploy tsc --noEmit -p .`)
- DB: `npm run -w @foundling/db generate` setelah ubah schema; `npm run -w @foundling/db migrate` dengan `DATABASE_URL`
- API/worker lokal: `npx tsx api/src/main.ts`, `npx tsx indexer/src/main.ts` (assumed; tidak ada script dev), env dari `deploy/.env.example`
- Tes Python: `python3 -m unittest discover -s tests -t .` (assumed); satu modul: `python3 -m unittest tests.test_verify_offline`; CI menjalankan grup terpisah
- Format/lint Rust per crate: `cargo fmt` (perbaiki) / `cargo fmt --check` (CI), `cargo clippy --locked --all-targets -- -D warnings`; strategi juga `--target wasm32-wasip2` dan `--features rehearsal`. Web: `npm run -w web lint`; tidak ada formatter TS/Python.

## Peta arsitektur

- `contracts/vault/src/` — kontrak inti (`lib.rs` entry): deposit, redeem, cycle, swap, pricing, limits/policy, recovery, governance, reveal, selftest; tes unit di `src/tests/`. `contracts/mock-*` — oracle, Ref/Rhea, OutLayer, token untuk sandbox.
- `strategy/` — strategi + advisor NEAR AI, dibangun ke `wasm32-wasip2` lewat `build.sh`/`manifest.json`; entry `src/main.rs`.
- `cli/` — `foundling-verify check` (replay, attestation, signature AI); `sandbox/` — tes near-workspaces dan serangan.
- `tools/` — Python stdlib: `attack.py` + `attacks/`, `keeper/`, `fetch_proof.py`, `recheck_obs.py`, `wasm_imports.py`, `readme.py`; `verify.py`/`verify_live.py` di root; tes Python di `tests/`.
- `web/` — Next.js App Router (`app/`), fitur (`features/`), logika (`lib/`), config jaringan (`config/`), unit (`tests/unit/`), E2E (`e2e/`). `api/` Hono (`src/main.ts`), `indexer/` worker (`src/main.ts`), `packages/db/` Drizzle + migrasi, `deploy/` Compose/Docker/Caddy.
- `proofs/` — bukti ter-commit (`proofs/attack/reproducible/`); `proofs/attack/local/` diabaikan. `claims.json` — status klaim; `docs/` — PLAN, SPEC, RUNBOOK, WEBSITE, plans.

## Konvensi

- Sumber kebenaran: `docs/PLAN.md` (scope/pemilik fitur) dan `docs/SPEC.md` (desain). Kerjakan hanya fitur milikmu beserta tesnya.
- Rust edition 2021; selalu `--locked`; jangan edit `Cargo.lock` manual. `cargo fmt` + clippy `-D warnings` wajib seperti CI.
- WASM kontrak memakai `--no-embed-abi` dan stdin tertutup; vault reproducible lewat `cargo near build reproducible-wasm`. Strategi hanya lewat `strategy/build.sh` (path di-remap agar hash stabil).
- TypeScript strict + `noUncheckedIndexedAccess`; ESM, Node 24, npm workspaces, versi exact (`save-exact`). `dangerouslySetInnerHTML` dilarang (aturan ESLint); data on-chain/API ditampilkan sebagai teks.
- Halaman exit (`features/portfolio`, stuck panel, layout app) tidak boleh mengimpor `lib/history`; dijaga `depcruise`.
- Perubahan method/event/gas kontrak harus sinkron dengan web: jalankan `npm run -w web check:contract`.
- Tes: Rust unit di `src/tests/` atau modul `#[cfg(test)]`; integration di `sandbox/tests/`, `cli/tests/`; Python `tests/test_*.py`; web `tests/unit/*.test.ts(x)`, E2E `e2e/*.spec.ts`; backend `tests/*.test.ts`.
- `README.md` dihasilkan dari `claims.json` + `tools/readme_template.md`; jangan edit manual. Migrasi DB dihasilkan drizzle-kit; jangan edit `packages/db/migrations/` manual.
- Komentar kode berbahasa Inggris; dokumen proyek berbahasa Indonesia. Pesan commit bergaya Conventional Commits (`feat(web): ...`, `docs: ...`); commit dari sesi Claude Code memakai trailer `Claude-Session:`.

## Jebakan

- `README.md` jangan diedit tangan: ubah `claims.json`/template lalu `make readme`; CI gagal bila tidak sinkron.
- `cargo near` bisa menggantung menunggu stdin: tutup dengan `< /dev/null` (Makefile sudah begitu).
- `cargo test --locked` gagal pada lockfile basi, bukan memperbaruinya.
- `make attack-lab` tidak membangun wasm; setelah pindah branch jalankan `make wasm`. Run pertama mengunduh `neard` + build 5 kontrak (~15 menit). `freeze-race` ~4 menit dan bisa melewati batas 300 s di mesin sibuk → `ERROR` (timeout, bukan serangan lolos); jalankan sendiri.
- `npm ci --ignore-scripts` wajib; `.npmrc` `engine-strict` menolak Node < 24 dan `save-exact` mengunci versi.
- `NEXT_PUBLIC_*` di-inline saat build: ubah env berarti rebuild. `npm run -w web e2e` membangun dua app (3100/3101) + mock server 3199, jadi lambat. `FOUNDLING_*` dan `NEXT_PUBLIC_TEST_BUILD` hanya untuk tes/CI; jangan dipasang di deploy nyata. Build produksi menolak bila `claims.json` tidak ada, `content/terms.json` masih memuat `TBD`, atau (mainnet) `NEXT_PUBLIC_SITE_URL` kosong.
- Tes backend butuh Postgres 16 hidup; default `DATABASE_URL=postgres://localhost:55432/foundling_test`. Helper menolak database yang namanya bukan `foundling_test` karena tes menjalankan drop schema + migrasi sendiri.
- `verify.py` hanya stdlib dan tidak boleh membuka jaringan; fixture-nya sintetis. `--strict` membuat SKIP gagal.
- `docs/SPEC.md` §11 menyebut `make demo-offline` dan `make testnet-demo`; keduanya tidak ada di Makefile — pakai target yang ada (`make verify`, `make quick`).
- Direktori hasil build (`target/`, `.next*`, `node_modules/`, coverage, `proofs/attack/local/`) diabaikan; jangan commit. Jangan jalankan `make attack-proofs` tanpa maksud: ia menulis ulang bukti yang di-commit dan butuh Docker + checkout bersih.

## Aturan kerja

- Kerjakan hanya fitur pemilikmu di `docs/PLAN.md`, beserta tesnya.
- Kerja di cabang dan buka PR. Jangan push ke `main` dan jangan force-push.
- Jangan menandatangani transaksi mainnet, membelanjakan token, atau deploy ke mainnet.
- Testnet hanya dengan kunci burner.
- Jangan membaca, mencetak, atau commit kunci privat dan rahasia.
- Jangan mengirim submisi hackathon, memposting, atau membuat repo publik.
- Jangan mengubah atau menghapus tes supaya lolos.