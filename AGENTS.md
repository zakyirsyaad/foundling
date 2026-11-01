# AGENTS.md

Baca `docs/PLAN.md`, lalu `docs/SPEC.md`. Keduanya sumber kebenaran proyek.

## Perintah

- Build kontrak: `cd contracts/vault && cargo near build non-reproducible-wasm`
- Tes kontrak: `cd contracts/vault && cargo test`
- Audit impor WASM: `python3 tools/wasm_imports.py contracts/vault/target/near/foundling_vault.wasm tools/allowlist.txt`

## Aturan kerja

- Kerjakan hanya fitur pemilikmu di `docs/PLAN.md`, beserta tesnya.
- Kerja di cabang dan buka PR. Jangan push ke `main` dan jangan force-push.
- Jangan menandatangani transaksi mainnet, membelanjakan token, atau deploy ke mainnet.
- Testnet hanya dengan kunci burner.
- Jangan membaca, mencetak, atau commit kunci privat dan rahasia.
- Jangan mengirim submisi hackathon, memposting, atau membuat repo publik.
- Jangan mengubah atau menghapus tes supaya lolos.
