# Sandbox: harness near-workspaces

Harness tes integrasi untuk vault Foundling. Ia menjalankan node sandbox lokal, men-deploy vault dan mock-nya, lalu memberi helper untuk memanggil dan memeriksa vault. Dipakai tes sandbox, Attack Lab (T7-T9), dan tes bot keeper.

## Menjalankan

```
make quick     # unit test semua kontrak dan strategy, tanpa sandbox dan tanpa build wasm
make sandbox   # build wasm semua kontrak, lalu cargo test di sandbox/
```

- Run pertama mengunduh biner neard (versi dari `near-sandbox`), jadi butuh jaringan.
- Semua `cargo test` memakai `--locked`, seperti CI: `Cargo.lock` yang usang membuat tes gagal, bukan diam-diam ditulis ulang.
- `make wasm` memakai `--no-embed-abi`, sama dengan build vault yang diaudit CI, jadi sandbox menguji biner yang sama.
- `make wasm` menutup stdin untuk `cargo near build`, karena cargo-near bisa menggantung tanpa terminal.
- `cargo test` langsung di `sandbox/` hanya aman bila wasm sudah dibangun. Bila belum, `wasm()` berhenti dengan pesan yang menyebut `make sandbox`.

## Yang dibuat `Foundling::start()`

Satu sandbox per tes, dengan:

- akun `owner` (parent vault dan pemilik semua mock), `governor`, `keeper`, `guardian`, `alice` (masuk allowlist), `stranger`;
- mock `usdc` dan `wnear` (`mock-token`), `rhea` (`mock-ref`), `oracle` (`mock-oracle`, harga sudah diisi), `outlayer` (`mock-outlayer`);
- `vault.owner.test.near`, dibuat dalam satu transaksi dari `owner`: CreateAccount, Transfer, DeployContract, `init`, tanpa AddKey. Jadi vault lahir tanpa access key.

`start()` gagal bila `init` gagal. `start_with(Setup { .. })` mengubah dunia di sekitar vault, misalnya fee pool di Ref yang berbeda dari konfigurasi vault. `launch(Setup { .. })` sama, tetapi tidak memeriksa `init`, untuk tes yang ingin melihat `init` gagal lewat `env.init_result`.

## Helper

| Helper | Fungsi |
|---|---|
| `env.ready()` | `setup_storage` empat target lalu `selftest`, supaya deposit diterima |
| `env.call_vault(&akun, "metode", json!({..}))` | panggil vault dengan semua gas, kembalikan hasil eksekusi |
| `env.view_vault::<T>("metode", json!({..}))` | view call ke vault |
| `env.view_contract::<T>(&kontrak, ..)` | view call ke kontrak lain |
| `env.mint(&token, &akun, jumlah)` | cetak token mock ke akun, sekaligus mendaftarkannya |
| `env.set_next(json!(..))` | antrekan jawaban mock OutLayer untuk `request_execution` berikutnya |
| `env.trigger_cycle()` | `trigger_cycle` dari keeper |
| `events(&hasil)`, `event_data(&hasil, "nama")` | event NEP-297 dari log |
| `failures(&hasil)` | teks kegagalan, untuk mencari kode alasan seperti `NOT_KEEPER` |

## Mock OutLayer

`mock-outlayer` menerima `request_execution` dengan bentuk argumen asli dan menjawab dari antrean. Antrean kosong menjawab `null`. Bentuk argumen `set_next`:

```
json!("Null")                                          // eksekusi gagal atau timeout: OutLayer menjawab null
json!("Failed")                                        // request gagal: callback vault melihat hasil gagal, deposit kembali penuh
json!({"Raw": {"payload": "..."}})                     // byte apa adanya: JSON rusak, bentuk salah, atau >1024 byte
json!({"Decision": {"template": {                      // Decision v1 yang terikat ke vault dan nonce peminta
    "chain": CHAIN, "commitment": COMMITMENT, "wasm_hash": WASM_HASH,
    "action": "buy_risk", "amount_in": "7000000", "ref_price": "450000000",
    "nonce": null, "vault": null }}})
```

`nonce` dan `vault` di template, bila diisi, menimpa nilai dari `input_data`. Pakai itu untuk mementaskan replay atau Decision dari vault lain. Bila template tidak mengisinya dan `input_data` juga tidak memuatnya, mock gagal dengan pesan yang jelas, supaya bentuk `input_data` yang berubah tidak tampak sebagai serangan replay. View `last_request`, `request_count`, `queued`, dan `run_fee` membaca keadaan mock.

Perilaku yang perlu diketahui:

- `Failed` tidak panik di dalam `request_execution`, karena panik membatalkan pengambilan entri dari antrean dan entri yang sama akan muncul di setiap request berikutnya. Mock mengembalikan promise ke method yang panik, jadi antrean tetap berkurang dan antrean `[Failed, Raw]` berjalan berurutan.
- Mock menahan biaya tetap `run_fee` (0,002 NEAR, di dalam kisaran 0,0012-0,0025 di SPEC) dan mengembalikan sisa deposit ke `payer_account_id`, seperti OutLayer asli. Saldo vault turun sekitar biaya itu per siklus, bukan sebesar `outlayer_deposit`. Deposit di bawah `run_fee` gagal seperti `Failed`.
- Mock menjawab di transaksi yang sama, bukan lewat yield. Timeout 200 blok, resolve di blok 199, dan callback terlambat belum bisa dipentaskan.
- Jawaban di atas `MAX_DECISION_BYTES` (1024) hanya ditandai (`oversize`, plus log). Yang menolaknya adalah vault, dengan `cycle_failed` kode `OVERSIZE`. Batas itu milik vault, dan `vault_decision_limit_is_1024` mengunci konstanta `MAX_DECISION_BYTES` di harness ke perilaku vault pada 1024 dan 1025 byte.

## Mock token

`mock-token` berlabel "MOCK TESTNET TOKEN". `mint` hanya untuk owner dan otomatis mendaftarkan akun, tidak seperti token asli. `ft_transfer_call` mengembalikan jumlah yang tidak dipakai receiver, termasuk bila receiver panik.

## Menambah tes

```rust
use foundling_sandbox::{event_data, failures, Foundling};
use serde_json::json;

#[tokio::test]
async fn contoh() -> anyhow::Result<()> {
    let env = Foundling::start().await?;
    env.set_next(json!("Null")).await?;

    let hasil = env.trigger_cycle().await?;

    assert!(hasil.is_success(), "{}", failures(&hasil));
    assert_eq!(event_data(&hasil, "cycle_failed").unwrap()["code"], "NULL_RESULT");
    Ok(())
}
```

## Tes serangan (Attack Lab)

`tests/attacks_batch1.rs` memuat `over_cap`, `drip`, `replay`, `bad_route`, dan `stale_price`. Tiap tes menyerang vault sandbox, menulis `proofs/attack/<nama>.json`, lalu baru berasersi. `tools/attacks/<nama>` menjalankan `cargo test --test attacks_batch1 <nama> -- --exact --include-ignored` dan membaca proof itu:

| Proof | Exit |
|---|---|
| `verdict` `held` dan cargo lulus | 0 (sistem bertahan) |
| `verdict` `breached` | 1 (serangan berhasil atau kode alasan berbeda) |
| tanpa proof, proof usang, WASM belum dibangun, atau `expected_codes` berbeda dari registry | 2 (galat alat) |

```
make attack-lab-full                 # build WASM + kompilasi tes, lalu semua serangan
python3 tools/attack.py run drip     # satu serangan; butuh `make wasm` lebih dulu
```

- Proof memuat langkah, kode alasan yang teramati, dan buku sebelum dan sesudah (`book`, `rhea_book`, saham, dompet vault). Waktu di proof berupa detik sejak transaksi pertama serangan, jadi isinya sama di setiap run.
- `Setup { policy: json!({..}) }` menimpa field policy. Serangan yang bergantung pada jam memakai profil testnet SPEC 3.6 (`epoch_len` 600, `cooldown` 60), karena `fast_forward` hanya ±116 blok per detik dan satu blok 0,3 detik: satu `epoch_len` produksi (21.600 detik) butuh ±10 menit, melewati batas 300 detik per serangan.
- `drip` membaca view `window_used` blok demi blok di sekitar batas dan membuktikan entri keluar tepat pada `at + epoch_len`. Transaksi sendiri mendarat 1-3 blok setelah dikirim, jadi tes transaksi di batas memakai margin 20 detik, dan ketepatan detiknya dibuktikan lewat view.
- `bad_route` ditandai `#[ignore]` dan dijalankan runner dengan `--include-ignored`: vault tidak pernah memancarkan `ROUTE_NOT_ALLOWED` (Decision v1 tak punya field rute), jadi serangan ini FAIL sampai kontrak atau SPEC berubah. Hapus `#[ignore]` saat itu terjadi.
- `PRICE_STALE` tidak bisa dipentaskan dengan mock oracle: ia menahan feed (hasil `null`) begitu lag melewati `age`, dan memberi `publish_time = now - lag` bagi yang lolos.

## Hal yang perlu diingat

- Harness menyimpan salinan JSON `InitConfig` dan `Policy` (`vault_config` di `src/lib.rs`). Bila lead mengubah bentuknya di `contracts/vault`, ubah juga di sini. `start()` akan gagal dengan pesan yang menunjuk ke sana.
- Tes memakai `reveal_after` = jam sistem + 30 hari. Tes yang memaju-cepatkan blok lebih dari itu harus mengaturnya sendiri.
