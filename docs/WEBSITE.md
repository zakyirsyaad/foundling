# Foundling: arsitektur website

Desain website, API, dan worker. Kontrak dan jaminan ada di `docs/SPEC.md`, jadwal utama ada di `docs/PLAN.md`. Website tidak mengubah kontrak.

## 1. Keputusan

| Hal | Keputusan |
| --- | --- |
| Jaringan | Dikembangkan di testnet. Vault final di mainnet setelah testnet selesai |
| Pengguna testnet | Hanya lead dan partner. Deployment testnet tidak dipublikasikan |
| Pengguna mainnet | Semua orang bisa melihat dan deposit dengan wallet sendiri, dalam batas `per_user_cap` dan `tvl_cap`, sesuai §9.4 SPEC (keputusan lead 2026-11-03) |
| Tanda tangan mainnet | Pengguna menandatangani dengan wallet masing-masing. Akun depositor tim memakai profil browser terpisah yang hanya memegang kunci itu. Kunci induk dan governor tidak pernah dibuka di browser yang memuat kode wallet |
| Kontrak | Berubah di PR #29: flag `open_deposits` yang dipatok di `init` dan hanya bisa ditutup lewat `tighten_policy`, registrasi storage NEP-145 sebesar 0,015 NEAR, dan satu klaim bucket terbuka per akun. Vault testnet tetap ber-allowlist untuk lead dan partner |
| Cross-chain | Masuk cakupan, lewat 1Click API milik NEAR Intents di tepi: USDC dari chain lain dikirim ke akun NEAR pengguna, lalu disetor seperti biasa. Hanya mainnet, untuk siapa pun. Keluar tetap di NEAR |
| Tampilan | Design system Foundling, arah Foundling token. Young Serif, IBM Plex Sans, dan IBM Plex Mono di-host sendiri, lisensinya dicatat di `THIRD_PARTY_NOTICES.md` |
| Bahasa website | Inggris |
| Sumber kebenaran | Chain. Database hanya untuk riwayat, grafik, dan hasil bukti |

## 2. Arsitektur

```
Vercel: UI Next.js di <domain>, tanpa kredensial dan tanpa rewrite
  ├─ status live ──────▶ RPC NEAR (FastNEAR, cadangan near.org)
  ├─ riwayat, grafik ──▶ api.<domain>, origin terpisah, JSON dan GET saja
  ├─ USDC chain lain ──▶ NEAR Intents 1Click API, langsung dari browser, mainnet saja
  └─ tanda tangan ─────▶ Meteor ──▶ kontrak

VPS, Docker Compose, hanya 22, 80, 443 terbuka
  Caddy (TLS) ──▶ API baca-saja ──▶ Postgres (privat)
                  Worker ─────────▶ Postgres
                    ├─ FastNEAR Transactions API
                    ├─ RPC, cadangan RPC arsip
                    └─ antrean bukti: fetch_proof.py, foundling-verify, recheck_obs.py

Keeper: tidak di VPS, lokasinya mengikuti §3.1 SPEC
```

**Aturan**

1. Saldo, shares, tahap siklus, dan status beku selalu dibaca dari RPC.
2. Website dan API tidak pernah memegang kunci. Semua transaksi ditandatangani wallet pengguna.
3. Kalau VPS, API, atau database mati, `/vault`, `/portfolio`, dan semua jalur keluar tetap jalan.
4. Setiap baris riwayat menaut ke transaksinya, jadi angkanya bisa dicek di chain. Hasil bukti yang tampil di website tetap harus dianggap klaim, dan jawabannya ada di perintah verifikasi.
5. Website dan VPS masuk peta kepercayaan. Website yang disusupi bisa mengecoh tanda tangan, dan VPS yang disusupi bisa memalsukan hasil bukti. Karena itu API tidak pernah berada di origin yang sama dengan halaman tanda tangan, dan perintah CLI setara selalu ditampilkan.

**Isi repo**

| Folder | Isi |
| --- | --- |
| `web/` | Next.js dan TypeScript |
| `api/` | Layanan HTTP baca-saja |
| `indexer/` | Worker |
| `packages/db/` | Schema dan migrasi Drizzle |

Semuanya npm workspaces. `npm ci --ignore-scripts` dipakai di semua tempat. `verify.py` dan `make quick` tetap tidak butuh Node.

## 3. Flow

Connect wallet tersedia di semua halaman, karena panel macet di `/vault` juga butuh tanda tangan.

### Deposit

1. Connect wallet.
2. Baca `is_allowed`, `is_frozen`, `is_halted`, `is_setup_done`, `selftest_passed`, `policy`, `net_deposit_of`, dan saldo USDC. Saldo NEAR vault dicek terhadap stake storage ditambah `near_reserve`, memakai `amount` dan `storage_usage` dari `view_account`.
3. Form dirender bila vault terbuka atau `is_allowed` benar. Di vault ber-allowlist, akun lain melihat penjelasan bahwa vault tertutup, tanpa ajakan menyetor.
4. Bila akun belum terdaftar di vault (`storage_balance_of`), pengguna menandatangani `storage_deposit` dengan lampiran tepat `storage_balance_bounds().min` (0,015 NEAR). Biaya ini dibayar sekali dan tidak bisa ditarik, karena menanggung entri yang mungkin masih dipegang vault untuk akun itu. Lampiran lain gagal dan kembali utuh, jadi website selalu memakai angka dari view itu.
5. Pengguna menandatangani `ft_transfer_call(vault, jumlah, "deposit")` di kontrak USDC.
6. Bagian Antrean membaca `pending_of`. Bila ditolak, kontrak mengembalikan seluruh dana tanpa event, jadi website hanya menulis dana dikembalikan utuh. `tvl_cap` tidak bisa dicek persis karena `total_net` tidak punya view.
7. Shares dicetak pada `trigger_cycle` berikutnya saat vault datar. UI menjelaskan alasannya: deposit tidak butuh harga, jadi harga yang salah tidak bisa mendilusi pemegang lama.
8. `cancel_deposit` tersedia selama ada antrean. Ini juga jalan keluar bila keeper mati dan shares tidak pernah dicetak.

Antrean, shares, dan klaim bisa ada bersamaan, jadi ditampilkan terpisah, bukan sebagai satu status. Klaim bucket lama pindah ke `claimable` saat akun `redeem` lagi di tengah swap berikutnya (event `claim_folded`), jadi panel klaim membaca `bucket_claim` dan `claimable_of` sekaligus.

### Redeem

1. Tombol keluar mengikuti posisi pengguna, bukan allowlist.
2. Perkiraan dihitung dengan `book × shares / total_shares`, dibulatkan ke bawah, untuk USDC dan wNEAR. Tombol dimatikan bila keduanya nol, karena kontrak menolaknya.
3. Website mengecek pendaftaran akun di kedua token dengan `storage_balance_of`. Bila belum, pengguna mendaftar lewat `storage_deposit` sebelum `redeem`, supaya wNEAR tidak jatuh ke `claimable` dan tertahan di sana.
4. Website mengecek saldo NEAR pengguna cukup untuk gas yang dilampirkan, dihitung dari harga gas saat itu.
5. Pengguna menandatangani `redeem(shares)`. Kontrak mengizinkannya saat beku, halt, dan macet. Teks UI memakai kualifikasi G3: keluar tetap bergantung pada kontrak USDC dan wNEAR.
6. Bila ada swap berjalan, sebagian hak menjadi klaim. Setelah swap selesai, `claim_bucket(nonce)` tersedia.
7. Nonce klaim ditemukan lewat `bucket_claim(nonce, akun)` di RPC, mundur dari `last_nonce`: 16 nonce terakhir otomatis, sisanya lewat tombol.
8. Transfer gagal tercatat di `claimable_of` dan ditarik dengan `withdraw_claimable`, setelah pendaftaran token di langkah 3.
9. Hasil `redeem` berupa wNEAR dan USDC, jadi UI menjelaskan cara unwrap wNEAR.

### Siklus

Dijalankan keeper, dipantau website. Tabel transisi lengkap ada di "Mesin status siklus" §3.4 SPEC, dan website mengikutinya.

Satu siklus dianggap selesai hanya oleh event berikut:

| Event | Kata di website |
| --- | --- |
| `executed` | Executed |
| `swap_reverted` | Reversed |
| `hold` | Hold |
| `rejected`, selain `PRICE_UNAVAILABLE` | Rejected |
| `cycle_failed` | Failed |
| `cycle_aborted` | Aborted |

`rejected` dengan `PRICE_UNAVAILABLE` tidak menyelesaikan siklus, karena tahapnya kembali ke `DecisionReady` dan keeper bisa mencoba lagi. `stuck` dan `probing` juga tidak menyelesaikan siklus. Selama belum selesai, katanya Running atau Stuck. Semua kata dan kelasnya mengikuti tabel di komponen `Status` design system.

### Pemulihan

Fungsi `recoveryAction(stage, inflight, policy, chainTime, height)` menentukan tombol yang aktif. Waktu diambil dari blok final, bukan jam browser. Jam halt dihitung dari `inflight.stuck_since` bila ada, seperti kontrak, bukan dari `entered_at` tahap, karena retry memulai ulang `entered_at` tapi tidak memulai ulang jam halt.

| Tombol | Syarat |
| --- | --- |
| `advance(nonce)` | `Stuck`, atau `Depositing`, `Swapping`, `Withdrawing`, `Probing` yang lewat `stuck_after` |
| `abort_stale_cycle` | `AwaitingDecision` atau `AwaitingPrice` lewat `abort_after_blocks` |
| `expire_decision` | `DecisionReady` lewat `expires_at` |

`advance` adalah bagian jalur keluar, karena klaim swap yang macet menunggu swap selesai. Panel "Vault macet" hanya memakai RPC dan dipakai bersama di `/vault` dan `/portfolio`. Panel menyatakan dua hal:

- Lewat `halt_after`, `advance` menyalakan `halted`, yang hanya bisa dicabut governor. Panel memberi peringatan sebelum tanda tangan.
- `advance` bisa kembali ke `Stuck`, jadi satu klik tidak menjamin klaim terbuka.

Hanya `advance` yang mengambil gaya tombol utama, dan selama itu `redeem` turun ke gaya biasa. `abort_stale_cycle` dan `expire_decision` tetap tombol biasa, karena keduanya tidak membuka dana siapa pun.

### Deposit dari chain lain (NEAR Intents)

Hanya di deployment mainnet, untuk siapa pun. Pengunjung tanpa wallet tetap bisa mencoba kuotasi (lihat Kuotasi tanpa dana di bawah). NEAR Intents tidak punya testnet, jadi bagian ini tidak dirender di sana.

Alurnya dua langkah, karena vault mencatat deposit atas nama pengirim. Bila 1Click menyetor langsung ke vault lewat `customRecipientMsg`, pengirimnya akun 1Click: vault ber-allowlist menolaknya, dan vault terbuka mencatat antrean dan shares atas nama akun 1Click, bukan pengguna. Jadi `recipient` selalu akun pengguna, dan tidak ada dana masuk vault tanpa tanda tangan pengguna.

1. Asal hanya USDC di Base, karena itu satu-satunya rute yang diuji SP4. `originAsset` dipatok di konfigurasi dan dicocokkan dengan `/v0/tokens`. `destinationAsset` adalah `nep141:` ditambah `assets().usdc` dari vault. Chain lain ditambahkan hanya setelah diuji dengan cara yang sama. Stellar, misalnya, butuh mode memo yang tidak ada di desain ini.
2. Cek pengguna terdaftar di USDC NEAR dengan `storage_balance_of`, dan minta pendaftaran bila belum. 1Click bisa mendaftarkan sendiri dengan biaya, tapi langkah deposit berikutnya tetap butuh pendaftaran itu.
3. Pengguna mengisi jumlah dan alamat refund di Base. Format alamat EVM divalidasi.
4. `POST /v0/quote` dengan `dry: true`, `swapType: FLEX_INPUT`, `slippageTolerance: 100`, `depositType: ORIGIN_CHAIN`, `refundType: ORIGIN_CHAIN`, `recipientType: DESTINATION_CHAIN`, `deadline` 20 menit dari sekarang, `recipient` akun pengguna yang terhubung, dan `refundTo`. Semua field ini wajib, dan tanpa salah satunya API menjawab HTTP 400. `FLEX_INPUT` dipilih karena kiriman manual jarang tepat, dan ia menerima sampai `minAmountIn`.
5. Website menampilkan `amountOut`, `minAmountIn`, `minAmountOut`, `refundFee`, dan `withdrawFee` dari jawaban kuotasi, bukan dari angka biaya tertulis. Kuotasi ditolak bila `minAmountOut` di bawah `min_deposit` atau melewati sisa `per_user_cap`, karena USDC yang tiba harus bisa disetor.
6. Setelah pengguna menyetujui, `POST /v0/quote` dengan `dry: false`. Tanda tangan kuotasi diverifikasi dengan `verifyQuoteSignature` dari SDK resmi dan kunci yang dipatok di konfigurasi. `recipient`, `destinationAsset`, dan `refundTo` di jawaban dicocokkan dengan permintaan. Bila ada yang tidak cocok, alamat tidak ditampilkan.
7. Alamat deposit tampil bersama jumlah dan batas waktunya. Dua menit sebelum `deadline` alamat disembunyikan dan diganti tulisan jangan kirim, karena menurut OpenAPI dana yang tiba setelah alamat tidak aktif bisa hilang.
8. Pengguna mengirim USDC dari wallet-nya sendiri. Website tidak menghubungkan wallet chain lain, jadi tidak ada dependensi wallet EVM. Pengguna boleh menempelkan tx hash asalnya, yang dikirim ke `/v0/deposit/submit` supaya lebih cepat diproses.
9. Status dibaca dari `/v0/status`. Status akhir hanya `SUCCESS`, `REFUNDED`, dan `FAILED`. `INCOMPLETE_DEPOSIT` belum akhir, karena refund kekurangan masih berjalan. Kata yang tampil mengikuti tabel 1Click di komponen `Status` design system.
10. Setelah `SUCCESS`, USDC ada di akun NEAR pengguna, dan pengguna melanjutkan lewat flow Deposit.

**Kuotasi tanpa dana.** Pengunjung tanpa wallet tetap bisa menjalankan langkah 4 dan 5 dengan kuotasi `dry: true` asli dari mainnet, supaya juri bisa mencoba rute ini tanpa dana. `recipient` dan `refundTo` memakai akun dan alamat contoh milik tim yang ditampilkan di layar. Kuotasi `dry: true` tidak menghasilkan alamat deposit, jadi tidak ada yang bisa dikirim, dan hasilnya tidak disimpan. Bahwa API menerima akun dan alamat contoh itu diuji di W7 lewat tes kontrak API 1Click.

**Penyimpanan swap.** `localStorage` menyimpan daftar swap per `depositAddress`, masing-masing dengan `recipient` dan `deadline`, jadi tab kedua tidak menimpa tab pertama. Tab disinkronkan lewat event `storage`. Swap yang berjalan tetap tampil walau wallet diputus atau akunnya bukan akun allowlist. Pengguna juga bisa menempelkan alamat deposit untuk mencari statusnya. Swap yang belum selesai dihapus 24 jam setelah `deadline`, dan swap yang selesai hanya disimpan sebagai catatan tx hash, sesuai ToS 4.1(e).

Browser memanggil 1Click langsung tanpa API key. Kunci tidak bisa disimpan di browser, dan proxy lewat VPS akan membuat flow ini bergantung pada VPS. `redeem` tetap menghasilkan token di NEAR. Memindahkannya ke chain lain adalah urusan pengguna, di luar website.

### Governance

Website hanya menampilkan peran, status beku dan halt, serta rotasi terjadwal. `freeze`, `unfreeze`, `add_depositor`, dan rotasi tetap lewat CLI, supaya kunci guardian dan governor tidak menyentuh website.

### Bukti

1. Tiap siklus punya halaman: keputusan, `obs`, transaksi, attestation, replay, dan recheck `obs`.
2. Hasil verifier dan hasil recheck `obs` ditampilkan sebagai dua tally terpisah, masing-masing `pass`, `skip`, dan `fail`. Kata Pass hanya dipakai bila keduanya sudah berjalan dan tidak ada `skip` atau `fail` di salah satunya.
3. Sebelum `reveal`, replay selalu `skip`. Setelah `reveal`, website menampilkan hasil verifikasi ulang.
4. Tanda tangan NEAR AI dihitung satu `skip` berlabel "belum dicakup" sampai verifier menanganinya, jadi tidak ada siklus yang tampil Pass selama itu. Worker tidak memegang kunci NEAR AI.
5. Siklus tanpa `decision` ditampilkan "tidak ada keputusan untuk diverifikasi".
6. Vault uji rehearsal menampilkan recheck `obs` sebagai `skip`, karena harganya berasal dari rahasia, bukan pasar.
7. Perintah verifikasi bisa disalin.

## 4. Halaman

Setiap jaringan punya deployment sendiri. Deployment testnet menampilkan banner `MOCK` di semua halaman.

| Halaman | Isi | Sumber |
| --- | --- | --- |
| `/` | Apa itu Foundling, empat jaminan, jumlah access key, `wasm_hash`, komitmen, tahap saat ini, yang tidak diklaim, penafian | RPC |
| `/vault` | Tahap live, buku, dana sedang di-swap dari `inflight`, pemakaian `window_used` dan `ops_spent`, status beku, panel macet, grafik harga per share | RPC, grafik dari API |
| `/cycles` | Daftar siklus | API, cadangan `published_decision` berlabel sebagian |
| `/cycles/[nonce]` | Timeline, keputusan, `obs`, transaksi, hasil bukti | API dan RPC |
| `/proof` | Komitmen, access key, `code_hash` vault, `wasm_hash` strategi, status `reveal`, perintah verifikasi, hasil Attack Lab berlabel sandbox | RPC, `proofs/`, dan API |
| `/trust` | Peta kepercayaan, tabel skenario kerugian beserta masukannya, peran, rotasi terjadwal | RPC, `verify`, dan konten statis |
| `/portfolio` | Antrean, shares, klaim, deposit, deposit dari chain lain di mainnet (kuotasi tanpa dana tampil tanpa wallet), `redeem`, panel macet, perintah CLI | RPC saja, ditambah 1Click API milik NEAR Intents untuk deposit dari chain lain |
| `/terms` | Ketentuan penggunaan, penafian demo teknis, dan bagian deposit dari chain lain yang diminta ToS 1Click | Konten statis |

Tidak dibuat: halaman admin, halaman dokumentasi, login selain wallet, dan aktivitas per akun.

`/proof` dirancang berlapis. Isi dari RPC dan berkas `proofs/` berdiri sendiri tanpa Postgres, dan bagian dari API ditambahkan di atasnya. Isi `proofs/` sekarang sintetis, jadi sebelum vault final `/proof` menampilkan data m12 testnet berlabel, bukan data sintetis.

Klaim di website diambil dari `claims.json`, sama seperti README, supaya klaim yang turun status ikut turun di website. Berkas itu belum ada di repo. Lead membuatnya sebelum W4, dan README partner memakai berkas yang sama.

Setiap halaman punya state memuat, kosong, tertunda, dan gagal. Vault yang sering `hold` menghasilkan grafik datar dan riwayat pendek, jadi state kosong harus layak tampil.

**Isi `web/`**

| Modul | Tugas |
| --- | --- |
| `lib/chain/` | Klien view RPC dengan cadangan, refresh 10 detik hanya saat tab terlihat. Semua jumlah memakai `BigInt` |
| `lib/wallet/` | Pembungkus `near-connect`, tabel panggilan, dan pasangan penerima dan method yang diizinkan |
| `lib/history/` | Klien API. Bila gagal, hasilnya status tertunda |
| `features/` | `vault`, `cycles`, `proof`, `portfolio` |

**Tabel panggilan wallet**

| Method | Gas minimum kontrak | Deposit |
| --- | --- | --- |
| `redeem` | 95 TGas | 1 yocto |
| `cancel_deposit`, `claim_bucket`, `withdraw_claimable` | 55 TGas | 1 yocto |
| `advance` | 110 TGas | Tanpa |
| `abort_stale_cycle`, `expire_decision` | Tanpa minimum | Tanpa |
| `ft_transfer_call` ke vault | Diukur di W5 | 1 yocto |
| `storage_deposit` di USDC dan wNEAR | Diukur di W5 | Nilai `min` dari `storage_balance_bounds` |

Daftar pasangan penerima dan method di `lib/wallet/` memuat semua baris tabel ini, termasuk `storage_deposit` di kedua token. Website menambahkan margin di atas minimum. Nilai akhirnya diuji pada gas yang benar-benar dikirim, karena sandbox selama ini memakai gas maksimum.

## 5. Data, worker, dan API

### Tabel Postgres

| Tabel | Isi | Kunci |
| --- | --- | --- |
| `sync_state` | Posisi terakhir, tip chain, heartbeat, error terakhir | `vault_id` |
| `events` | `tx_hash`, tinggi blok receipt, waktu, nama, nonce, akun, data JSON | `vault_id, receipt_id, log_index` |
| `cycles` | Status, aksi, jumlah, keputusan, transaksi | `vault_id, nonce` |
| `nav_points` | `book`, `total_shares`, harga oracle mentah. Harga per share dihitung saat dibaca | `vault_id, nonce` |
| `proofs` | Bundel mentah, tally verifier, tally recheck `obs`, status antrean masing-masing, commit verifier | `vault_id, nonce` |

Kunci memakai `vault_id` karena setiap uji melahirkan vault baru dan nonce mulai dari 1 lagi. API melayani satu vault lewat `ACTIVE_VAULT_ID`.

`events` hanya ditambah. `cycles` diturunkan darinya dan bisa dibangun ulang. Jumlah token disimpan sebagai `numeric(78,0)` dan dikirim sebagai string. Database tidak menyimpan rahasia, cookie, atau analytics.

### Worker: putaran indeks, tiap 30 detik

Saat start, worker mengambil `pg_advisory_lock` per vault, supaya saat redeploy hanya satu instance berjalan.

1. Tulis heartbeat dan tip chain ke `sync_state`.
2. Panggil `/v0/account` dengan `from_tx_block_height` sama dengan posisi dikurangi satu jam, `is_receiver: true`, dan `desc` yang ditulis eksplisit, ikuti `resume_token`.
3. Panggil `/v0/transactions` per 20 hash.
4. Terima log hanya bila `executor_id` sama dengan vault, receipt sukses, dan standar `foundling`. Status transaksi tidak dipakai, karena transaksi yang gagal sebagian tetap punya event sah. Parser menerima `data: []`.
5. Urutkan dengan `block_height`, `index`, dan urutan log dari outcome receipt, bukan tinggi blok transaksi.
6. Simpan event dan posisi dalam satu transaksi database, lalu turunkan ulang siklus yang tersentuh.
7. Untuk siklus yang selesai, baca `book`, `total_shares`, dan harga oracle pada blok event terakhir, dengan cadangan RPC arsip.
8. Masukkan siklus ke antrean bukti saat event `decision`-nya pertama kali tersimpan, tidak menunggu siklus selesai, supaya bundel diambil sebelum log RPC hilang.

Jendela satu jam diperlukan karena `decision` bisa tiba belakangan lewat yield. Kunci unik mencegah dobel.

### Worker: antrean bukti

Antrean berjalan terpisah dari putaran indeks, dengan backoff dan status akhir, supaya bukti yang lambat tidak menahan indeks atau heartbeat.

1. Siklus dengan `decision` diambil dengan `fetch_proof.py` satu per satu. Bundel mentah dan satu salinan `approved_measurements` disimpan, karena RPC biasa hanya menyimpan 17 sampai 20 jam dan daftar pengukuran bisa berubah.
2. `foundling-verify check` dijalankan pada bundel itu. Hasilnya dibaca dari baris `SUMMARY`, karena exit code tetap 0 walau ada `skip`.
3. `recheck_obs.py` dijalankan per siklus dan hasilnya disimpan sebagai tally sendiri. Exit 2 berarti sumber tidak terbaca, jadi dicoba lagi dengan backoff sampai 24 jam sebelum dicatat `skip`. Vault dengan `obs_source = rehearsal` mencatat `skip` tanpa memanggilnya. `obs_source` adalah konfigurasi deployment per `vault_id`.
4. Saat event `revealed` tiba, parameter dan salt dibaca dari view `revealed` dan `revealed_salt`, digabung ke bundel tersimpan sebagai `opening`, lalu hanya `foundling-verify` yang dijalankan ulang dan hanya tally verifier yang ditimpa. Tidak ada `fetch_proof.py` ulang, dan tally recheck `obs` tetap, karena `obs` tidak berubah.
5. Siklus tanpa `decision` langsung mendapat status akhir.

`foundling-verify` mengompilasi aturan strategi, jadi biner di image dipatok ke commit yang membangun `wasm_hash` vault itu, dengan `--features fetch`.

Worker harus hidup sebelum siklus pertama vault final. Backlog di atas 17 jam ditangani opsi RPC arsip di `fetch_proof.py`.

Bundel adalah satu-satunya data yang tidak bisa dibangun ulang dari chain. Job GitHub Actions membacanya dari API publik dan menyimpannya ke cabang `live-proofs`, tanpa rahasia di VPS.

**Perubahan alat yang dibutuhkan:** opsi RPC arsip di `fetch_proof.py`, pembacaan `opening` dari view, dan cara menggabungkannya ke bundel.

### API

Dilayani di `api.<domain>` dengan CORS terbatas pada origin website dan method GET.

| Endpoint | Isi |
| --- | --- |
| `GET /v1/status` | Posisi, heartbeat, dan selisih terhadap tip chain dari worker |
| `GET /v1/cycles` | Daftar siklus, keyset |
| `GET /v1/cycles/:nonce` | Detail siklus dan event |
| `GET /v1/nav` | Titik harga dalam rentang waktu |
| `GET /v1/events` | Aktivitas vault, keyset, saring per nama |
| `GET /v1/proofs/:nonce` | Hasil dan bundel bukti |

Respons berbentuk `success`, `data`, `error`, `meta`, dengan `Content-Type: application/json` dan `X-Content-Type-Options: nosniff`. Parameter divalidasi dengan schema dan satu halaman paling banyak 100 baris.

API memakai role database baca-saja, worker memakai role tulis. Rate limit per IP klien, dibaca dari header yang diisi Caddy dan hanya dipercaya dari jaringan internal Compose, karena IP soket API selalu Caddy. Ditambah batas konkurensi global, `statement_timeout` di Postgres, dan batas memori serta CPU di Compose, supaya banjir permintaan tidak menghentikan worker.

`/v1/events` tidak lengkap sebagai riwayat, karena `cancel_deposit` dan `withdraw_claimable` tidak mengeluarkan event. UI menyatakannya.

## 6. Keamanan

- `near-connect` memuat kode wallet dari luar saat runtime. Manifest sendiri berisi Meteor dengan executor di-vendor dan dicek hash, CSP dengan `cspNonce`, sesuai ancaman di SPEC.
- `lib/wallet/` hanya mengizinkan pasangan penerima dan method yang persis dari konfigurasi deployment. USDC mainnet adalah akun implicit 64 hex, jadi tidak ada cek akhiran nama. Tes unit memuat konfigurasi mainnet.
- Data on-chain ditampilkan sebagai teks. Tanpa `dangerouslySetInnerHTML`, dan link `wasm_url` hanya `https`.
- 1Click adalah pihak tepercaya baru. Alamat deposit datang dari API-nya, jadi tanda tangan kuotasi diverifikasi dengan kunci yang dipatok dari SDK resmi sebelum alamat tampil. Website menampilkan alamat, jumlah, dan batas waktu dengan jelas, memperingatkan soal alamat exchange, dan membatasi CSP `connect-src` ke host 1Click. Masuk peta kepercayaan SPEC, dan `SPEC.md` diperbaiki karena masih menulis kuncinya tidak terdokumentasi.
- ToS 1Click melarang menyimpan data API lebih dari 24 jam kecuali catatan transaksi statis. Worker dan database tidak menyimpannya. `localStorage` mengikuti aturan penyimpanan swap di §3, dan bukti cross-chain hanya berupa tx hash.
- ToS 1Click membebankan KYC dan screening sanksi pada integrator dan meminta ketentuan untuk pengguna akhir. Lead memutuskan (2026-11-03) deposit dari chain lain terbuka untuk publik dalam lingkup hackathon tanpa legal check; `/terms` tetap memuat ketentuan 1Click.
- Penandatanganan mainnet terjadi di profil browser terpisah yang hanya memegang kunci depositor khusus, sesuai keputusan di §1, supaya kode wallet luar tidak berjalan di samping kunci induk atau governor. SPEC §3.1 dan runbook dicatat ulang.
- Teks website mengikuti "Yang tidak diklaim" di SPEC: tanpa APY, tanpa janji hasil, tanpa logo NEAR AI. Kerugian kumulatif hanya dibatasi NAV, jadi website tidak menampilkan satu angka batas kerugian.
- VPS: SSH hanya dengan kunci, tanpa login root, firewall, dan rahasia hanya di `.env` VPS. Postgres tidak terbuka ke internet.
- Vercel tidak memegang rahasia. Variabel `NEXT_PUBLIC_` hanya berisi konfigurasi publik.
- Mock wallet E2E hanya ada di build tes, dan CI memastikan tidak ikut ke build produksi.
- Produksi dipromosikan manual oleh lead, bukan otomatis dari `main`, supaya ruang kerja yang jatuh tidak bisa langsung mengirim UI tanda tangan yang berbahaya.
- Kunci SSH dan akun Vercel dipegang lead. Deploy publik perlu persetujuan lead.

## 7. Bila ada yang gagal

| Kejadian | Perilaku |
| --- | --- |
| Worker tertinggal | Riwayat diberi tanda tertunda, status live tetap jalan |
| VPS, API, atau database mati | Dashboard, deposit, `redeem`, dan panel macet tetap jalan. Riwayat bertanda tertunda, dan `/cycles` memakai cadangan `published_decision` |
| Keeper mati | Tidak ada siklus baru, deposit mengantre, `cancel_deposit` dan `redeem` tetap jalan |
| RPC utama gagal | Pindah ke cadangan |
| Semua RPC gagal | Status ditandai tidak terbaca, perintah CLI tetap tampil |
| Wallet menolak | Kembali ke form, tidak ada status yang berubah |
| Transaksi ditolak kontrak, misalnya `NOT_STUCK` atau `bucket not resolved` | Pesan kontrak diterjemahkan ke kalimat biasa, status dibaca ulang, dan tombol mengikuti status baru |
| Saldo NEAR pengguna tidak cukup untuk gas | Tombol tetap aktif dan menjelaskan berapa NEAR yang dibutuhkan, perintah CLI tetap tampil |
| 1Click tidak terbaca | Deposit dari chain lain ditandai tidak tersedia. Deposit USDC NEAR, `redeem`, dan klaim tidak terdampak |
| Swap kurang bayar atau gagal | Status ditampilkan apa adanya beserta alamat refund. Refund dilakukan 1Click ke `refundTo`, bukan oleh vault |
| Kiriman tiba setelah batas waktu | Tidak ada janji refund, karena OpenAPI menyebut dana bisa hilang. Itu sebabnya alamat disembunyikan sebelum `deadline`, dan halaman menyarankan menghubungi dukungan 1Click dengan tx hash asal |
| Vault beku, halt, atau macet | Banner penjelasan, `redeem` tetap aktif |
| Bukti gagal dibuat | Status akhir gagal dibuat, tidak pernah tampil sebagai lulus |

## 8. Tes dan CI

| Lapisan | Isi |
| --- | --- |
| Unit | Parser, status siklus, `recoveryAction` untuk setiap tahap termasuk `Withdrawing` hasil retry dengan `stuck_since` lama, `BigInt`, perkiraan `redeem`, konfigurasi wallet mainnet, verifikasi tanda tangan kuotasi, dan penyimpanan swap dua tab |
| Kesesuaian | CI membaca sumber Rust dan gagal bila tabel panggilan atau nama event melenceng |
| Integrasi | Worker dan API dengan Postgres asli, fixture transaksi vault m5, m10, m12, termasuk receipt gagal. Jalur lulus recheck memakai `tools/fixtures/m10-obs.json` |
| E2E | Playwright dengan wallet tiruan, termasuk skenario API mati, dan API 1Click tiruan yang memakai respons asli dari SP4 untuk semua status swap |
| Kontrak API 1Click | Satu tes mengirim pembuat permintaan yang sama ke kuotasi `dry: true` sungguhan. Dijalankan manual dan sebelum rilis, tidak di CI, karena bergantung jaringan luar |
| Manual | Meteor sungguhan di testnet oleh lead dan partner |

Cakupan minimal 80% pada `lib/`, `features/`, `api/`, dan `indexer/`.

Dua aturan otomatis:

1. `dependency-cruiser` memastikan `/portfolio` dan panel macet tidak mengimpor `lib/history/`, juga secara tidak langsung. Keduanya dirender di browser, dan layout utama tidak mengambil data API.
2. Cek kata terlarang berjalan di semua teks, kecuali satu blok "yang tidak diklaim" yang dikecualikan secara eksplisit.

Job CI baru: `Web`, `Backend`, `Backend image`. Parameter image memuat commit verifier per vault. `npm audit` memakai level tinggi. Action dipatok ke SHA seperti `ci.yml`. Required check hanya berubah atas permintaan lead.

## 9. Hosting dan operasi

| Komponen | Tempat |
| --- | --- |
| UI | Vercel Hobby, satu proyek per jaringan, produksi dipromosikan manual |
| Caddy, API, worker, Postgres | VPS milik lead, Docker Compose, image dari CI |
| Keeper | Tidak di VPS, mengikuti §3.1 SPEC |

Pengembangan lokal tanpa Docker: Node dan Postgres Homebrew. Image hanya diuji di CI.

Selama testnet, UI berjalan lokal atau di preview terlindungi. Domain dibutuhkan saat UI di Vercel pertama kali memanggil API di VPS. Semua layanan dijaga hidup sampai 18 Nov, idealnya 25 Nov.

Satu alert dari luar VPS memantau heartbeat worker dan saldo keeper, karena 16 sampai 18 Nov tidak dijaga. Runbook mencatat apa yang bisa dilakukan partner bila lead tidak terjangkau.

## 10. Urutan kerja

| # | Selesai bila |
| --- | --- |
| W1 | `/proof` statis tampil dari `proofs/` dan RPC, tanpa Postgres. Workspace dan CI hijau |
| W2 | Baris §11 yang bertanda W2 selesai. Schema siap. Vault uji hidup: build `rehearsal`, `mock-ref` terbaru, allowlist akun Meteor lead dan partner, skrip keeper sementara |
| W3 | Parser cocok dengan jumlah event m5, m10, m12. Worker hidup di vault uji dan restart tanpa dobel. API melayani riwayat |
| W4 | Token dan CSS design system terpasang dengan font self-hosted, dan `claims.json` ada. Semua halaman baca-saja tampil dari data testnet, dan `/vault` tetap jalan saat API mati |
| W5 | Lead dan partner menyelesaikan deposit, batal, `redeem`, klaim, dan `advance` lewat website |
| W6 | Antrean bukti berjalan: bundel disimpan, `pass`, `skip`, `fail` tampil, dan verifikasi ulang setelah `reveal` lulus uji |
| W7 | Deposit dari chain lain lulus di E2E dengan respons asli dari SP4, dan tes kontrak API lulus terhadap kuotasi `dry: true` sungguhan |
| W8 | Tampilan final, responsif, aksesibel, semua state ada, dan review keamanan selesai |
| W9 | Website publik membaca vault final di mainnet, alert dan runbook siap |

**SP4.** SP4 tidak butuh vault atau website, jadi dijalankan sebagai skrip terpisah segera setelah testnet selesai, sebelum vault final, atas persetujuan lead. Isinya deposit USDC Base ke akun NEAR dan satu kurang bayar di bawah `minAmountIn` yang dikembalikan, sekitar US$5 ditambah gas. Responsnya disimpan sebagai fixture W7. W7 bisa dibangun lebih dulu dengan respons tiruan, tapi baru selesai setelah fixture SP4 ada.

Pekerjaan chain di PLAN didahulukan bila bentrok, dan target kontrak beku tidak bergeser.

**Lantai aman.** `/proof` statis dari W1 adalah pengganti halaman bukti yang pindah dari partner, jadi proyek tidak pernah sampai submit tanpa halaman bukti.

**Gerbang.** Bila worker belum hidup saat vault final lahir, website rilis tanpa riwayat, memakai halaman yang hanya butuh RPC.

Bila waktu sempit, yang dipangkas berurutan: recheck `obs` otomatis, grafik harga per share, lalu `/trust` versi statis. `/portfolio` dengan jalur keluarnya dan label `skip` yang jujur tidak dipangkas.

**Cross-chain.** Leg ini ditetapkan masuk, jadi tidak ada di daftar pangkas waktu. Satu-satunya alasan membatalkannya adalah SP4 gagal di mainnet. Bila itu terjadi, bagiannya dilepas dari website dan kata kunci NEAR INTENTS dicabut dari klaim, sesuai SPEC. Klaim itu baru sah setelah ada dua tx hash.

**Pembagian.** Lead mengerjakan `web/`, `api/`, `indexer/`, dan `packages/db/`, menggantikan halaman bukti di daftar partner. Partner tetap memegang bot keeper, Attack Lab, `verify.py`, README, dan video.

**Dokumen lain yang diperbarui di W1.** `docs/PLAN.md`: pembagian kerja, pilihan mainnet, dan UI web, karena PLAN berlaku di atas SPEC. `docs/SPEC.md`: arsitektur, peta kepercayaan termasuk VPS, website, dan 1Click, ancaman baru, jalur `near-connect`, serta leg 1Click dan SP4 yang tidak lagi opsional.

## 11. Belum terbukti

| Hal | Cara mengecek |
| --- | --- |
| Manifest sendiri dan pemilihan jaringan di `near-connect` | Baca kode sumbernya di W2. Keduanya tidak terdokumentasi di README |
| Meteor dengan vault kita di testnet | Tanda tangan sungguhan di W2 |
| Kecepatan transaksi berjalan muncul di Transactions API | Ukur pada siklus nyata. Jendela satu jam adalah angka aman, bukan hasil ukur |
| Kebutuhan API key FastNEAR | Dokumentasi memintanya, walau sekarang jalan tanpa kunci. Siapkan sebagai env opsional |
| Log pada receipt gagal | Delapan receipt gagal yang diperiksa tidak punya log, jadi filter sukses adalah pencegahan |
| Batas RPC untuk pemakaian terus-menerus | Ukur saat W4. Semburan 40 panggilan lolos di FastNEAR |
| `api.kraken.com` dari VPS dan kebutuhan RAM | Ukur di VPS saat W2. RAM 2 GB adalah perkiraan |
| Preview terlindungi di Vercel Hobby | Cek saat proyek Vercel dibuat |
| Promosi manual produksi di Vercel Hobby | Cek saat proyek Vercel dibuat |
| 1Click dengan `recipient` akun NEAR | SP4 di mainnet |
| Pendaftaran storage oleh 1Click | Kuotasi `dry: true` ke penerima yang belum terdaftar memberi `withdrawFee`, tanda 1Click mungkin mendaftarkan sendiri. SP4 memastikannya |
| Perilaku kurang bayar dan refund 1Click | SP4 di mainnet |
| Batas minimum dan rate limit 1Click tanpa API key | Kuotasi `dry: true` memberi minimum Base 0,15 USDC. Rate limit diukur saat W7 |
| Verifikasi tanda tangan kuotasi | Reviewer berhasil memverifikasi satu kuotasi dengan SDK resmi. Kuncinya dipatok dan diuji di W7 |
