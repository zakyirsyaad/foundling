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
| Cross-chain | Masuk cakupan, lewat 1Click API milik NEAR Intents di tepi: USDC dari Base, Arbitrum, atau Ethereum dikirim ke akun NEAR pengguna, lalu disetor dalam satu alur terpandu (§3). Setiap chain asal tampil hanya setelah lulus uji seperti SP4. Hanya mainnet, untuk siapa pun. Keluar tetap di NEAR |
| Tampilan | Monokrom penuh dari tema `neutral` shadcn/ui di Tailwind v4. Warna hanya untuk status, selalu dengan label teks. Inter untuk teks dan judul, Geist Mono untuk angka, hash, akun, dan perintah. Keduanya di-host sendiri, lisensinya (OFL) dicatat di `THIRD_PARTY_NOTICES.md`. Rincian di §4 Design system (keputusan lead 2026-11-04) |
| Struktur | Landing di `/`, `/proof`, `/trust`, dan `/terms` untuk pengunjung dan juri, tanpa tanda tangan. App di `/app`, `/app/cycles`, dan `/app/portfolio` untuk pemakai. Satu proyek Next.js, satu deploy per jaringan |
| Wallet | Semua wallet lewat manifest default `near-connect`. Jaringan mengikuti deployment: `mainnet` untuk publik, `testnet` untuk lead dan partner. Risikonya di §6 (keputusan lead 2026-11-04) |
| Juri | Diperlakukan sebagai pengguna biasa dengan wallet sendiri. Tidak ada mode tanpa wallet (keputusan lead 2026-11-04) |
| Kinerja | App menampilkan perubahan harga per share sejak awal, dengan periode dan jumlah siklus, tanpa disetahunkan. Landing tidak menampilkan angka kinerja |
| Bahasa website | Inggris |
| Sumber kebenaran | Chain. Database hanya untuk riwayat, grafik, dan hasil bukti |

## 2. Arsitektur

```
Vercel: UI Next.js di <domain>, tanpa kredensial dan tanpa rewrite
  ├─ status live ──────▶ RPC NEAR (FastNEAR, cadangan near.org)
  ├─ riwayat, grafik ──▶ api.<domain>, origin terpisah, JSON dan GET saja
  ├─ USDC chain lain ──▶ NEAR Intents 1Click API, langsung dari browser, mainnet saja
  └─ tanda tangan ─────▶ wallet pengguna (near-connect) ──▶ kontrak

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
3. Kalau VPS, API, atau database mati, `/app`, `/app/portfolio`, dan semua jalur keluar tetap jalan.
4. Setiap baris riwayat menaut ke transaksinya, jadi angkanya bisa dicek di chain. Hasil bukti yang tampil di website tetap harus dianggap klaim, dan jawabannya ada di perintah verifikasi.
5. Website dan VPS masuk peta kepercayaan. Website yang disusupi bisa mengecoh tanda tangan, dan VPS yang disusupi bisa memalsukan hasil bukti. Karena itu API tidak pernah berada di origin yang sama dengan halaman tanda tangan, dan perintah CLI setara selalu ditampilkan.
6. Landing membaca RPC di server Next.js dan menyimpan hasilnya 30 sampai 60 detik, supaya pengunjung tidak menghabiskan kuota RPC publik sendiri-sendiri. Batas RPC publik belum terukur: catatan reviewer di SPEC menyebut 429 pada sekitar tiga permintaan per menit tanpa kunci, sedangkan semburan 40 panggilan pernah lolos (§11). Setiap refresh punya anggaran panggilan, dan batasnya diukur di W4. App membaca RPC dari browser setiap 10 detik selama tab terlihat, dalam anggaran itu. Render server `/app` dan `/app/cycles` memakai cache yang sama, tapi umurnya paling lama 20 detik supaya halaman tidak terbuka dalam keadaan basi, dengan timeout API pendek. Bila API tidak menjawab, halaman jatuh ke render browser.

**Isi repo**

| Folder | Isi |
| --- | --- |
| `web/` | Next.js dan TypeScript |
| `api/` | Layanan HTTP baca-saja |
| `indexer/` | Worker |
| `packages/db/` | Schema dan migrasi Drizzle |

Semuanya npm workspaces. `npm ci --ignore-scripts` dipakai di semua tempat. `verify.py` dan `make quick` tetap tidak butuh Node.

## 3. Flow

Connect wallet ada di header semua halaman `/app`, karena panel macet di `/app` dan `/app/portfolio` juga butuh tanda tangan. Landing tidak meminta tanda tangan.

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

**Sebelum tombol Deposit.** Website mengecek saldo NEAR pengguna terhadap registrasi dan gas yang dilampirkan, lalu menulis kekurangannya sebagai angka pasti. Tombol tetap aktif dan menjelaskan kekurangan itu (§7). Form menampilkan ID kontrak `assets().usdc`. Bila akun hanya memegang USDC.e hasil bridge, form menjelaskan bahwa token itu tidak diterima. Sisa `per_user_cap` dihitung dari `net_deposit_of`. Sisa `tvl_cap` hanya perkiraan, karena `total_net` tidak punya view, jadi teksnya menyebut bahwa deposit dikembalikan utuh bila vault penuh. Di dekat tombol tertulis "Not audited. You can lose money." dengan tautan ke `/trust`.

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

`advance` adalah bagian jalur keluar, karena klaim swap yang macet menunggu swap selesai. Panel "Vault macet" hanya memakai RPC dan dipakai bersama di `/app` dan `/app/portfolio`. Panel menyatakan dua hal:

- Lewat `halt_after`, `advance` menyalakan `halted`, yang hanya bisa dicabut governor. Panel memberi peringatan sebelum tanda tangan.
- `advance` bisa kembali ke `Stuck`, jadi satu klik tidak menjamin klaim terbuka.

Hanya `advance` yang mengambil gaya tombol utama, dan selama itu `redeem` turun ke gaya biasa. `abort_stale_cycle` dan `expire_decision` tetap tombol biasa, karena keduanya tidak membuka dana siapa pun.

### Deposit dari chain lain (NEAR Intents)

Hanya di deployment mainnet, untuk siapa pun yang terhubung dengan wallet. NEAR Intents tidak punya testnet, jadi bagian ini tidak dirender di sana.

USDC selalu sampai di akun NEAR pengguna dulu, karena vault mencatat deposit atas nama pengirim. Bila 1Click menyetor langsung ke vault lewat `customRecipientMsg`, pengirimnya akun 1Click. Akun itu tidak terdaftar di vault, jadi depositnya ditolak dan kembali ke akun 1Click, bukan ke pengguna. Kalaupun terdaftar, antrean dan shares akan tercatat atas nama akun 1Click. Jadi `recipient` selalu akun pengguna, dan tidak ada dana masuk vault tanpa tanda tangan pengguna. Bagi pengguna, kedua langkah itu tampil sebagai satu alur di satu kartu "From another chain".

**Chain asal.** USDC di Base, Arbitrum, dan Ethereum (keputusan lead 2026-11-04). Ketiganya EVM, jadi validasi alamat refund sama. Setiap chain tampil hanya setelah lulus uji seperti SP4 (§10). `originAsset` per chain dipatok di konfigurasi dan dicocokkan dengan `/v0/tokens`. `destinationAsset` adalah `nep141:` ditambah `assets().usdc` dari vault. Chain non-EVM, misalnya Solana, ada di roadmap karena butuh validasi alamat dan uji sendiri. Stellar juga butuh mode memo yang tidak ada di desain ini.

**Alur terpandu**

1. *Connect.* Pengguna menghubungkan wallet NEAR. Tanpa wallet, kartu hanya berisi penjelasan dan tombol Connect. Alur diikat ke akun yang terhubung di langkah ini. Bila akun berganti sebelum alamat deposit tampil, kartu kembali ke langkah 2. Setelah alamat tampil, swap tetap milik akun itu.
2. *Quote.* Sebelum kuotasi, kartu menjalankan cek yang sama dengan langkah 2 flow Deposit: vault tidak beku atau halt, setup dan selftest selesai, NEAR vault di atas batas, deposit terbuka (`open_deposits` atau allowlist), dan perkiraan sisa `tvl_cap` sebagai peringatan, bukan penolakan. Bila cek vault gagal, kartu menjelaskan alasannya dan tidak meminta kuotasi; bila perkiraan TVL rendah, kuotasi tetap boleh dan kartu memperingatkan bahwa deposit bisa dikembalikan penuh. Pengguna memilih chain dan jumlah, lalu mengisi alamat refund di chain asal. Format alamat EVM divalidasi, dan kartu memperingatkan agar tidak memakai alamat exchange atau wallet kontrak yang belum tentu ada di chain EVM lain. Website memanggil `POST /v0/quote` dengan `originAsset`, `destinationAsset`, `amount` (string bilangan bulat dalam satuan terkecil token), `dry: true`, `swapType: FLEX_INPUT`, `slippageTolerance: 100`, `depositType: ORIGIN_CHAIN`, `refundType: ORIGIN_CHAIN`, `recipientType: DESTINATION_CHAIN`, `deadline` 20 menit dari sekarang (40 menit untuk Ethereum, karena konfirmasinya lebih lama), `recipient` akun pengguna yang terhubung, dan `refundTo`. Semua field ini wajib, dan tanpa salah satunya API menjawab HTTP 400. `FLEX_INPUT` dipilih karena kiriman manual jarang tepat, dan ia menerima sampai `minAmountIn`. Kartu menampilkan `amountOut`, `minAmountIn`, `minAmountOut`, `refundFee`, dan `withdrawFee` dari jawaban, bukan dari angka biaya tertulis. Kuotasi ditolak bila `minAmountOut` di bawah `min_deposit` atau melewati sisa `per_user_cap`, karena USDC yang tiba harus bisa disetor. Bila Ethereum dipilih, kartu menyebut bahwa biaya jaringan di sana bisa melebihi deposit kecil.
3. *Siapkan.* Sebelum uang bergerak, website mengecek `storage_balance_of` akun pengguna di vault dan di kontrak USDC NEAR, lalu meminta pendaftaran yang belum ada. Keduanya bisa disetujui sekali di wallet yang mendukung beberapa transaksi sekaligus. Registrasi vault diberi label "one-time, non-refundable". Saldo NEAR dicek terhadap registrasi ditambah gas yang dilampirkan, dan kekurangannya ditulis sebagai angka pasti beserta cara mendapatkan NEAR.
4. *Kirim.* Cek vault di langkah 2 diulang, dan `quoteProblems()` dijalankan lagi atas quote final sebelum alamat ditampilkan; perubahan `min_deposit`, sisa `per_user_cap`, status beku atau halt, atau swap lain yang muncul selama request membatalkan langkah alamat. Website memanggil `POST /v0/quote` dengan `dry: false` dan menampilkan angkanya untuk dikonfirmasi, karena harga bisa bergerak sejak kuotasi dry. Tanda tangan kuotasi diverifikasi dengan `verifyQuoteSignature` dari SDK resmi, dengan kunci yang dipatok di konfigurasi dan diberikan eksplisit, bukan kunci bawaan SDK. Seluruh request yang dikembalikan di jawaban dicocokkan dengan request yang dikirim: `originAsset`, `destinationAsset`, `amount`, `recipient`, `refundTo`, semua tipe, `swapType`, `dry`, dan `quoteRequest.deadline` buatan klien yang unik per request. `deadline` dibandingkan sebagai waktu sampai milidetik, bukan sebagai string, karena 1Click bisa menormalkan formatnya. Dengan begitu kuotasi lama yang sah tidak bisa dipakai ulang. Bila ada yang tidak cocok, alamat tidak ditampilkan dan kartu menyatakannya. Sebelum alamat tampil, satu baris menaut ke bagian deposit dari chain lain di `/terms`. Alamat tampil bersama nama chain asal, kontrak token USDC di chain itu dari `/v0/tokens`, `amountIn` yang harus dikirim, jumlah minimal `minAmountIn`, dan sisa waktu. Kartu memperingatkan bahwa USDC.e di Arbitrum dan USDbC di Base bukan token yang diminta. Alamat hanya tampil selama status `PENDING_DEPOSIT` atau `INCOMPLETE_DEPOSIT`, supaya pengguna yang kembali tidak mengirim dua kali. Sebelum `/v0/status` mengenali alamat (jawaban 404), tampilan pertama setelah kuotasi segar yang terverifikasi dianggap `PENDING_DEPOSIT`. Kartu juga menulis jam lokal "Send before" yang sudah dikurangi margin, karena alamat yang disalin tetap bisa dipakai terlambat.

   Sisa waktu dihitung dua cara terhadap `deadline` di jawaban: jam monotonik (`performance.now`) sejak jawaban tiba, dan `Date.now` yang dikoreksi dengan selisihnya terhadap `timestamp` jawaban saat jawaban tiba. Alamat hanya tampil selama keduanya masih di atas margin chain itu: dua menit untuk Base dan Arbitrum, lima menit untuk Ethereum. `performance.now` bisa berhenti saat perangkat tidur di Safari dan Firefox, jadi setiap kali tab kembali terlihat (`visibilitychange`, `pageshow`), alamat disembunyikan dulu. Website lalu meminta kuotasi dry dengan parameter yang sama, yang juga bertanda tangan, untuk mendapat `timestamp` segar. Bila tanda tangannya sah dan kedua jam masih membolehkan terhadap `deadline` swap itu: untuk `INCOMPLETE_DEPOSIT`, alamat yang sama tampil lagi supaya pengguna bisa menambah kiriman; untuk `PENDING_DEPOSIT`, kartu bertanya dulu "Already sent? Paste the tx hash", dan alamat baru tampil lagi setelah pengguna menyatakan belum mengirim apa pun. Setelah halaman dimuat ulang, alamat tidak tampil sebagai tujuan kirim; record yang sudah lewat deadline hanya bisa dibuka sebagai "Expired record" dengan label jangan kirim. Status swap yang sudah berjalan tetap tampil. Selama swap sebelumnya untuk akun itu masih `PENDING_DEPOSIT` dan belum lewat deadline, kuotasi baru diblokir kecuali pengguna menyatakan belum mengirim apa pun, supaya tidak terjadi kiriman kedua. Jawaban 404 dari `/v0/status` dihitung sebagai `PENDING_DEPOSIT` selama umur kuotasi, baik untuk blokir ini maupun untuk menampilkan ulang. Bila 1Click tidak terbaca, status swap dianggap tidak diketahui: alamat disembunyikan, swap tetap terdaftar, dan kuotasi baru tetap diblokir sampai deadline lewat. Setelah lewat margin, alamat diganti tulisan jangan kirim, karena menurut OpenAPI dana yang tiba setelah alamat tidak aktif bisa hilang. Pengguna mengirim USDC dari wallet chain asalnya sendiri. Website tidak menghubungkan wallet chain lain, jadi tidak ada dependensi wallet EVM. Pengguna boleh menempelkan tx hash asal, yang dikirim ke `/v0/deposit/submit` supaya lebih cepat diproses.
5. *Tunggu lalu setor.* Status dibaca dari `/v0/status`. Status akhir hanya `SUCCESS`, `REFUNDED`, dan `FAILED`. `INCOMPLETE_DEPOSIT` belum akhir: dengan `FLEX_INPUT`, alamat menunggu tambahan sampai `deadline`, lalu 1Click mengembalikan dana. Kartu menampilkan kekurangannya, dan alamat tetap tampil untuk tambahan selama aturan waktu di langkah 4 membolehkan. `REFUNDED` tampil bersama alamat refund, serta `refundedAmount` dan `refundReason` bila ada. `FAILED` tidak menjanjikan refund: kartu menampilkan isi status dan menyarankan menghubungi dukungan 1Click dengan tx hash asal dan kuotasi bertanda tangan. Setelah `SUCCESS`, kartu langsung menampilkan tombol Deposit. Jumlahnya nilai terkecil dari `swapDetails.amountOut` di status, saldo USDC pengguna, dan sisa `per_user_cap`. Kelebihannya disebutkan dan tetap di akun NEAR pengguna. Bila jumlah itu di bawah `min_deposit`, tombol diganti penjelasan, dan USDC tetap di akun pengguna. Bila akun yang terhubung bukan `recipient`, kartu meminta pengguna menghubungkan akun itu. Tanda tangan berikutnya mengikuti flow Deposit. Bila gagal, USDC tetap di akun NEAR pengguna dan tombolnya tetap tersedia.

**Penyimpanan swap.** `localStorage` menyimpan daftar swap per `depositAddress`, masing-masing dengan `recipient` dan `deadline`, jadi tab kedua tidak menimpa tab pertama. Tab disinkronkan lewat event `storage`. Swap yang berjalan tetap tampil walau wallet diputus atau akunnya bukan akun allowlist. Pengguna juga bisa menempelkan alamat deposit untuk mencari statusnya. Swap yang belum selesai tidak dihapus karena waktu: setelah `deadline` lewat, recordnya disimpan sebagai `expired · unresolved` supaya alamat dan tx hash masih bisa dicari untuk dukungan. Alamat itu tidak pernah ditampilkan sebagai tujuan kirim; ia hanya muncul di disclosure "Expired record" dengan label jangan kirim, dan pengguna bisa menghapus record itu. Swap yang selesai hanya disimpan sebagai catatan tx hash, sesuai ToS 4.1(e). Kartu menyediakan unduhan kuotasi bertanda tangan, karena OpenAPI meminta klien menyimpannya untuk sengketa. Berkas itu disimpan pengguna sendiri, bukan oleh website.

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

Setiap jaringan punya deployment sendiri. Deployment testnet hanya untuk lead dan partner, dan menampilkan banner `MOCK` di semua halaman.

Website punya dua bagian. Landing menjelaskan dan meyakinkan pengunjung serta juri, tanpa tanda tangan. App berisi fitur, dan semua aksinya butuh wallet.

**Landing**

| Halaman | Isi | Sumber |
| --- | --- | --- |
| `/` | Home, rinciannya di bawah | RPC dari server, `claims.json` |
| `/proof` | Komitmen, access key, `code_hash` vault, `wasm_hash` strategi, status `reveal`, empat fakta beserta perintah untuk mengeceknya, hasil Attack Lab berlabel sandbox, dan apa yang tidak bisa dibuktikan | RPC, `proofs/`, dan API |
| `/trust` | Tabel peran (siapa bisa apa dan siapa tidak bisa apa), tabel risiko per pihak termasuk 1Click dan kode wallet, skenario kerugian beserta masukannya, catatan eksploit Rhea, rotasi terjadwal | RPC, `verify`, dan konten statis |
| `/terms` | Ketentuan penggunaan, penafian demo teknis, dan bagian deposit dari chain lain yang diminta ToS 1Click | Konten statis |

Section Home, berurutan:

| # | Section | Isi |
| --- | --- | --- |
| 1 | Header | Nama Foundling sebagai teks, How it works, Proof, Trust, GitHub, tombol Open app |
| 2 | Hero | "A vault born without keys.", satu kalimat tentang apa produknya, tombol Open app dan Read the proof, lalu video 16:9 (motion loop atau video demo) dengan satu baris teks hasil `verify.py --live` di bawahnya |
| 3 | Built on | Nama mitra sebagai teks, tanpa logo dan tanpa kesan didukung, diambil dari `claims.json`. NEAR Intents baru tampil setelah ada dua tx hash lintas chain, dan NEAR AI baru setelah SP1b lulus. Sebelum itu barisnya memakai teks turun status |
| 4 | How it works | Decide: WASM strategi di enclave OutLayer memutuskan dengan parameter yang dienkripsi, dan NEAR AI hanya penasihat yang bisa menurunkan eksposur (kalimat ini dari `claims.json`, dan sebelum SP1b lulus memakai teks turun status). Check: kontrak memeriksa batas. Trade: pool 4512. Verify: sekarang attestation, input, dan batas; setelah `reveal`, replay aturan atas input yang direkam |
| 5 | Demo | Video yang sama dengan demo post |
| 6 | Guarantees | Lima kartu dari `claims.json`: lahir tanpa kunci, lalu G1 kerahasiaan, G2 kerugian terbatas, G3 jalur keluar, dan G4 keterlacakan dari SPEC. Setiap kartu menyebut batasnya |
| 7 | What we don't claim | Daftar "Yang tidak diklaim" di SPEC §1 |
| 8 | Penutup | Perintah `git clone` dan `python3 verify.py` yang bisa disalin |
| 9 | Footer | Proof, Trust, Terms, GitHub, pilihan tema, "Not audited · hackathon build" |

Hero tidak memakai terminal (keputusan lead 2026-11-04). Videonya muted, berulang, dengan caption, dan menampilkan frame poster pada `prefers-reduced-motion`. Baris teks verifier di bawahnya dirender di server, karena juri dan mesin penyaring (HACKATHON.md Q-017) membaca HTML, bukan video. Mode `--live` adalah Tier 1 di SPEC dan belum dibangun. Sampai mode itu ada, baris itu memakai data testnet m12 berlabel, bukan keluaran fixture sintetis. Penutup memberi perintah `git clone` dan `python3 verify.py` dalam kotak kode biasa, dengan keterangan bahwa fixture-nya sintetis.

**App**

Header berisi wordmark, nama vault, badge jaringan, dan Connect wallet. Di bawahnya tab Overview, Cycles, dan Portfolio. Di layar sempit tab bisa digeser dan tabel menjadi baris bertumpuk. `/app` dan `/app/cycles` dirender pertama kali di server, dari RPC dan API, supaya mesin penyaring juri (Q-017) melihat isi, bukan skeleton. Bila API mati, `/app/cycles` jatuh ke `published_decision` di browser.

| Halaman | Isi | Sumber |
| --- | --- | --- |
| `/app` | Badge tahap, status beku dan halt, jumlah access key. Buku, harga per share, perubahan harga per share sejak awal dengan periode dan jumlah siklus, dan dana yang sedang di-swap dari `inflight`. Grafik harga per share. Empat meter: jendela epoch, `ops_budget`, TVL terhadap `tvl_cap` sebagai perkiraan, dan eksposur wNEAR terhadap `max_risk_bps`. Daftar aturan per transaksi tanpa meter: batas per trade, slippage, cooldown, umur harga, dan batas jual. Siklus terakhir. Panel macet | RPC, grafik dari API |
| `/app/cycles` | Daftar siklus: nonce, waktu, hasil dengan kata dari tabel di §3, tally bukti, jumlah, dan tx. Saringan All, Executed, Hold, Other | API, cadangan `published_decision` berlabel sebagian |
| `/app/cycles/[nonce]` | Timeline, keputusan, `obs` dan hasil recheck, cek batas, transaksi, hasil bukti, status replay | API dan RPC |
| `/app/portfolio` | Antrean, shares, klaim, deposit, deposit dari chain lain, `redeem`, panel macet, perintah CLI per aksi | RPC saja, ditambah 1Click API untuk deposit dari chain lain |

Tidak dibuat: halaman admin, halaman dokumentasi, login selain wallet, dan aktivitas per akun.

`/proof` dirancang berlapis. Isi dari RPC dan berkas `proofs/` berdiri sendiri tanpa Postgres, dan bagian dari API ditambahkan di atasnya. Isi `proofs/` sekarang sintetis, jadi sebelum vault final `/proof` menampilkan data m12 testnet berlabel, bukan data sintetis.

Klaim di website diambil dari `claims.json`, sama seperti README, supaya klaim yang turun status ikut turun di website. Berkas itu belum ada di repo. Lead membuatnya sebelum W4, dan README partner memakai berkas yang sama.

### Design system

| Hal | Aturan |
| --- | --- |
| Warna | Tema `neutral` shadcn/ui (oklch, chroma 0) untuk light dan dark. Tema mengikuti sistem, dengan pilihan manual di footer. Tombol utama hitam di light dan putih di dark. Warna hanya untuk status, selalu dengan label teks, menurut tabel `Status` di bawah. Angka kinerja tidak diberi warna |
| Huruf | Inter untuk teks dan judul, dengan `font-optical-sizing: auto`. Judul semibold dengan tracking rapat. Geist Mono untuk angka, hash, akun, dan perintah. Kolom angka memakai `tnum`. Hero 56 sampai 64 px, teks landing 16 px, teks app 14 px |
| Bentuk | Border 1 px, hampir tanpa shadow. Radius 8 px untuk card, 6 px untuk tombol dan input. Grid garis tipis hanya di belakang hero |
| Komponen | Dari shadcn/ui: Button, Card, Badge, Table, Tabs, Dialog, Sheet, Input, Tooltip, Progress, Skeleton, Alert, Sonner, Chart. Rakitan sendiri: Video, Status, Stat, LimitMeter, Hash (mono, dipotong, dengan tombol salin), CycleSteps, StuckPanel, CrossChainCard |
| Logo | Belum ada logo (keputusan lead 2026-11-04). Nama `Foundling` ditulis sebagai teks Inter semibold, tanpa tanda apa pun |
| Copy | Inggris. Mengikuti "Yang tidak diklaim" di SPEC dan aturan teks di §6. Landing tidak mengajak menyetor |

Tabel `Status` adalah satu-satunya sumber kata dan warna status, supaya kata yang sama dipakai di semua halaman.

| Kelompok | Hijau | Kuning | Merah | Abu-abu |
| --- | --- | --- | --- | --- |
| Siklus | Executed | Reversed, Rejected, Stuck | Failed | Hold, Aborted, Running |
| Bukti | Pass | Skip | Fail, Failed to build | Checking, Sealed |
| Vault | Live | Stuck | Halted | Frozen, Not ready |
| 1Click | `SUCCESS` | `INCOMPLETE_DEPOSIT`, `REFUNDED` | `FAILED` | `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING` |

### State

Setiap halaman punya state memuat, kosong, tertunda, dan gagal. Vault yang sering `hold` menghasilkan grafik datar dan riwayat pendek, jadi state kosong harus layak tampil.

| Kelompok | State |
| --- | --- |
| Data | Memuat dengan skeleton seukuran isi. Basi, dengan "as of block #…" dan umurnya. Tidak terbaca, bila semua RPC gagal atau umur data app lewat 60 detik: tombol deposit diganti tulisan bahwa vault tidak terbaca beserta perintah CLI. Kartu chain lain tidak meminta kuotasi, termasuk kuotasi dry untuk menambatkan waktu, jadi alamat tetap tersembunyi. Tombol keluar (`redeem`, klaim, `cancel_deposit`, `withdraw_claimable`) tetap aktif dengan peringatan, karena hasil terburuknya revert atau dana yang masuk ke `claimable`. Tombol pemulihan (`advance`, `abort_stale_cycle`, `expire_decision`) baru aktif setelah satu pembacaan segar berhasil, karena `advance` yang sah setelah `halt_after` menyalakan `halted`, dan peringatan halt butuh waktu chain dan `stuck_since` yang segar. Peringatan itu muncul bila waktu chain dari pembacaan segar ditambah margin pendek sudah mencapai `stuck_since + halt_after`, karena transaksi bisa mendarat beberapa blok kemudian. Riwayat tertunda berlabel "Partial". Kosong yang tetap layak tampil. Sebelum vault final: data testnet m12 berlabel |
| Vault | Frozen: banner abu-abu, trade dan deposit baru berhenti, `redeem`, klaim, dan `cancel_deposit` tetap jalan, hanya governor yang membuka. Halted: banner merah, trade dan deposit baru berhenti, hanya governor yang mencabut, `redeem` tetap jalan. Stuck: panel macet dengan tombol pemulihan di §3. Belum siap: `is_setup_done` atau `selftest_passed` salah, deposit ditutup. NEAR vault di bawah batas: kontrak menolak deposit, jadi form ditutup dengan penjelasan. Keeper mati: "No cycle since …", deposit mengantre, `cancel_deposit` dan `redeem` tetap jalan |
| Posisi | Antrean ("shares mint at the next cycle" dan tombol batal), shares, klaim bucket, dan `claimable`, ditampilkan terpisah karena bisa ada bersamaan |
| Transaksi | Menunggu wallet. Terkirim, dengan tautan hash. Selesai. Selesai sebagian: bagian `redeem` menunggu `claim_bucket`, atau transfer gagal pindah ke `claimable`. Dibatalkan di wallet, form tetap terisi. Ditolak kontrak, dengan kalimat biasa lalu status dibaca ulang. Hasil tidak diketahui: niat dan hash yang ada tetap disimpan, tombol transaksi dikunci sampai pengguna memeriksa wallet dan menegaskan tidak ada yang terkirim. Dilanjutkan dari hash yang disimpan setelah wallet membuka tab atau app lain lalu kembali |
| Prasyarat | Wallet belum terhubung. Belum terdaftar. NEAR kurang, tombol tetap aktif dan menyebut jumlahnya. Hanya punya USDC.e. Di bawah `min_deposit` atau melewati `per_user_cap` |
| Bukti | Sedang dicek. Lulus. Gagal dibuat, tidak pernah tampil sebagai lulus. Replay tersegel sampai `reveal_after` |
| Chain lain | State setiap langkah alur terpandu di §3. Chain yang tidak tersedia ditandai per chain |

Waktu untuk tombol pemulihan diambil dari blok final (§3), bukan jam browser. Semua state dibuat sebagai varian komponen yang sama, bukan halaman terpisah.

**Isi `web/`**

| Modul | Tugas |
| --- | --- |
| `lib/chain/` | Klien view RPC dengan cadangan, refresh 10 detik hanya saat tab terlihat. Semua jumlah memakai `BigInt` |
| `lib/wallet/` | Pembungkus `near-connect` dengan manifest default dan jaringan dari konfigurasi deployment, tabel panggilan, dan pasangan penerima dan method yang diizinkan |
| `lib/history/` | Klien API. Bila gagal, hasilnya status tertunda |
| `features/` | `landing`, `vault`, `cycles`, `proof`, `portfolio`, `crosschain` |

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

- `near-connect` memakai manifest default, jadi semua wallet yang terdaftar di sana bisa dipakai (keputusan lead 2026-11-04). Kode executor wallet dimuat dari pihak ketiga saat runtime dan tidak dipatok, sehingga executor yang berubah bisa meminta wallet menandatangani transaksi apa pun yang bisa dilakukan kunci pengguna, termasuk transfer yang tidak ada hubungannya dengan vault. Pemeriksa terakhirnya layar konfirmasi wallet itu sendiri. Pasangan penerima dan method di `lib/wallet/` hanya membatasi apa yang diminta website, bukan apa yang bisa diminta executor. Dampak ini ditulis apa adanya di tabel risiko `/trust`. Perintah CLI setara selalu tampil, dan jalur wajib `redeem` tetap CLI menurut SPEC. CSP memakai `cspNonce`. Baris ancaman supply chain front-end di SPEC ikut diperbarui.
- `lib/wallet/` hanya mengizinkan pasangan penerima dan method yang persis dari konfigurasi deployment. USDC mainnet adalah akun implicit 64 hex, jadi tidak ada cek akhiran nama. Tes unit memuat konfigurasi mainnet.
- Data on-chain ditampilkan sebagai teks. Tanpa `dangerouslySetInnerHTML`, dan link `wasm_url` hanya `https`.
- 1Click adalah pihak tepercaya baru. Alamat deposit datang dari API-nya, jadi tanda tangan kuotasi diverifikasi dengan kunci yang dipatok dari SDK resmi sebelum alamat tampil. Website menampilkan alamat, jumlah, dan batas waktu dengan jelas, memperingatkan soal alamat exchange, dan membatasi CSP `connect-src` ke host 1Click. Masuk peta kepercayaan SPEC. Kunci publiknya diambil dari SDK resmi dan dipatok di konfigurasi, sesuai baris NEAR Intents di SPEC.
- ToS 1Click melarang menyimpan data API lebih dari 24 jam kecuali catatan transaksi statis. Worker dan database tidak menyimpannya. Sebagai pengecualian untuk keselamatan pengguna, `localStorage` menyimpan swap yang belum selesai melewati 24 jam agar transfer yang tertunda masih bisa dicari; alamatnya tidak dipakai sebagai tujuan kirim, hanya ada di disclosure "Expired record" dengan label jangan kirim, dan pengguna bisa menghapusnya. Bukti cross-chain tetap hanya berupa tx hash.
- ToS 1Click membebankan KYC dan screening sanksi pada integrator dan meminta ketentuan untuk pengguna akhir. Lead memutuskan (2026-11-03) deposit dari chain lain terbuka untuk publik dalam lingkup hackathon tanpa legal check; `/terms` tetap memuat ketentuan 1Click.
- Penandatanganan mainnet terjadi di profil browser terpisah yang hanya memegang kunci depositor khusus, sesuai keputusan di §1, supaya kode wallet luar tidak berjalan di samping kunci induk atau governor. SPEC §3.1 dan runbook dicatat ulang.
- Teks website mengikuti "Yang tidak diklaim" di SPEC: tanpa APY, tanpa janji hasil, tanpa logo NEAR AI. Kerugian kumulatif hanya dibatasi NAV, jadi website tidak menampilkan satu angka batas kerugian. Perubahan harga per share hanya tampil di app dengan label "Share price since start", periode, dan jumlah siklus, tanpa disetahunkan, karena return termasuk yang tidak diklaim.
- VPS: SSH hanya dengan kunci, tanpa login root, firewall, dan rahasia hanya di `.env` VPS. Postgres tidak terbuka ke internet.
- Vercel tidak memegang rahasia. Variabel `NEXT_PUBLIC_` hanya berisi konfigurasi publik.
- Mock wallet E2E hanya ada di build tes, dan CI memastikan tidak ikut ke build produksi.
- Produksi dipromosikan manual oleh lead, bukan otomatis dari `main`, supaya ruang kerja yang jatuh tidak bisa langsung mengirim UI tanda tangan yang berbahaya.
- Kunci SSH dan akun Vercel dipegang lead. Deploy publik perlu persetujuan lead.

## 7. Bila ada yang gagal

| Kejadian | Perilaku |
| --- | --- |
| Worker tertinggal | Riwayat diberi tanda tertunda, status live tetap jalan |
| VPS, API, atau database mati | Dashboard, deposit, `redeem`, dan panel macet tetap jalan. Riwayat bertanda tertunda, dan `/app/cycles` memakai cadangan `published_decision` |
| Keeper mati | Tidak ada siklus baru, deposit mengantre, `cancel_deposit` dan `redeem` tetap jalan |
| RPC utama gagal | Pindah ke cadangan |
| Semua RPC gagal, atau umur data app lewat 60 detik | Angka tampil dengan nomor blok terakhir. Tombol deposit dan kuotasi chain lain diganti tulisan bahwa vault tidak terbaca. Tombol keluar tetap aktif dengan peringatan, tombol pemulihan menunggu satu pembacaan segar, dan perintah CLI tetap tampil |
| Wallet menolak | Kembali ke form, tidak ada status yang berubah |
| Transaksi ditolak kontrak, misalnya `NOT_STUCK` atau `bucket not resolved` | Pesan kontrak diterjemahkan ke kalimat biasa, status dibaca ulang, dan tombol mengikuti status baru |
| Saldo NEAR pengguna tidak cukup untuk gas | Tombol tetap aktif dan menjelaskan berapa NEAR yang dibutuhkan, perintah CLI tetap tampil |
| 1Click tidak terbaca | Deposit dari chain lain ditandai tidak tersedia. Deposit USDC NEAR, `redeem`, dan klaim tidak terdampak. Swap yang sedang berjalan tampil sebagai status tidak diketahui, dengan alamat disembunyikan |
| Swap kurang bayar atau gagal | Status ditampilkan apa adanya. Kurang bayar dikembalikan 1Click ke `refundTo` setelah `deadline`, bukan oleh vault. `FAILED` tidak menjanjikan refund, dan kartu menyarankan menghubungi dukungan 1Click |
| Kiriman tiba setelah batas waktu | Tidak ada janji refund, karena OpenAPI menyebut dana bisa hilang. Itu sebabnya alamat disembunyikan sebelum `deadline`, dan halaman menyarankan menghubungi dukungan 1Click dengan tx hash asal |
| Vault beku, halt, atau macet | Banner penjelasan, `redeem` tetap aktif |
| Bukti gagal dibuat | Status akhir gagal dibuat, tidak pernah tampil sebagai lulus |
| Kuotasi 1Click tidak lolos verifikasi | Alamat deposit tidak ditampilkan, dan kartu menyatakan alasannya |
| Satu chain asal bermasalah | Hanya chain itu yang ditandai tidak tersedia |
| Jam perangkat meleset, perangkat tidur, atau halaman dimuat ulang | Alamat deposit hanya tampil selama dua sumber waktu sama-sama masih punya sisa, dan disembunyikan setelah tab kembali terlihat sampai kuotasi dry bertanda tangan menegaskan waktunya masih ada. Setelah reload, alamat tidak tampil sebagai tujuan kirim; record expired hanya ada di disclosure "Expired record" dengan label jangan kirim |

## 8. Tes dan CI

| Lapisan | Isi |
| --- | --- |
| Unit | Parser, status siklus, `recoveryAction` untuk setiap tahap termasuk `Withdrawing` hasil retry dengan `stuck_since` lama, `BigInt`, perkiraan `redeem`, konfigurasi wallet mainnet, verifikasi tanda tangan kuotasi, dan penyimpanan swap dua tab, aturan tampil alamat deposit (dua sumber waktu, margin per chain, sembunyi setelah tidur atau reload, status yang membolehkan), pencocokan seluruh request kuotasi, isian jumlah setoran, dan tabel `Status` |
| Kesesuaian | CI membaca sumber Rust dan gagal bila tabel panggilan atau nama event melenceng |
| Integrasi | Worker dan API dengan Postgres asli, fixture transaksi vault m5, m10, m12, termasuk receipt gagal. Jalur lulus recheck memakai `tools/fixtures/m10-obs.json` |
| E2E | Playwright dengan wallet tiruan, termasuk skenario API mati, dan API 1Click tiruan yang memakai respons asli dari SP4 untuk status yang benar-benar terjadi di tiap chain (sukses dan kurang bayar), ditambah respons berbentuk OpenAPI untuk status lainnya |
| Kontrak API 1Click | Satu tes mengirim pembuat permintaan yang sama ke kuotasi `dry: true` sungguhan. Dijalankan manual dan sebelum rilis, tidak di CI, karena bergantung jaringan luar |
| Manual | Tanda tangan sungguhan dengan beberapa wallet populer di testnet oleh lead dan partner, termasuk wallet yang membuka tab atau app lain |

Cakupan minimal 80% pada `lib/`, `features/`, `api/`, dan `indexer/`.

Dua aturan otomatis:

1. `dependency-cruiser` memastikan `/app/portfolio` dan panel macet tidak mengimpor `lib/history/`, juga secara tidak langsung. Keduanya dirender di browser, dan layout utama tidak mengambil data API.
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

| # | Selesai bila | Target |
| --- | --- | --- |
| W1 | `/proof` statis tampil dari `proofs/` dan RPC, tanpa Postgres. Workspace dan CI hijau | Selesai (#36) |
| W2 | Baris §11 yang bertanda W2 selesai. Schema siap. Vault uji hidup: build `rehearsal`, `mock-ref` terbaru, allowlist akun wallet lead dan partner, skrip keeper sementara | 7 Nov |
| W3 | Parser cocok dengan jumlah event m5, m10, m12. Worker hidup di vault uji dan restart tanpa dobel. API melayani riwayat | 7 Nov |
| W4 | shadcn/ui dengan tema `neutral`, Inter, dan Geist Mono yang di-host sendiri terpasang, dan `claims.json` ada. Semua halaman baca-saja tampil dari data testnet, dan `/app` tetap jalan saat API mati | 8 Nov |
| W5 | Lead dan partner menyelesaikan deposit, batal, `redeem`, klaim, dan `advance` lewat website | 8 Nov |
| W6 | Antrean bukti berjalan: bundel disimpan, `pass`, `skip`, `fail` tampil, dan verifikasi ulang setelah `reveal` lulus uji | 9 Nov |
| W7 | Deposit dari chain lain lulus di E2E dengan respons asli dari SP4 untuk setiap chain asal, dan tes kontrak API lulus terhadap kuotasi `dry: true` sungguhan | 10 Nov |
| W8 | Tampilan final, responsif, aksesibel, semua state ada, review keamanan selesai, dan kartu siklus menampilkan skor dan alasan AI Risk Manager | 13 Nov |
| W9 | Website publik membaca vault final di mainnet, alert dan runbook siap | VPS 11 Nov, website 12 Nov |

**SP4.** SP4 tidak butuh vault atau website, jadi dijalankan sebagai skrip terpisah segera setelah testnet selesai, sebelum vault final, atas persetujuan lead. Isinya deposit USDC Base ke akun NEAR dan satu kurang bayar di bawah `minAmountIn` yang dikembalikan, sekitar US$5 ditambah gas. Responsnya disimpan sebagai fixture W7. W7 bisa dibangun lebih dulu dengan respons tiruan, tapi baru selesai setelah fixture SP4 ada. Arbitrum dan Ethereum masing-masing butuh satu deposit kecil sekitar 1 sampai 2 USDC ditambah gas, dan gas Ethereum bisa beberapa dolar. Keduanya juga atas persetujuan lead, per chain. Chain yang belum lulus tidak tampil.

Pekerjaan chain di PLAN didahulukan bila bentrok, dan target kontrak beku tidak bergeser.

Target ditarik mundur dari tanggal di PLAN: kontrak beku 10 Nov, vault final 12 Nov, `reveal` 13 Nov, kirim 14 Nov (digeser oleh AI Risk Manager, keputusan lead 2026-11-11). W2 dan W3 lebih dulu karena W5 dan W6 butuh vault uji yang hidup. W7 jatuh di antara kontrak beku dan vault final, sesuai SP4 di atas. Worker sudah hidup di VPS sebelum siklus pertama vault final (§5), jadi bagian VPS di W9 jatuh pada hari vault final lahir. Target ini adalah tenggat per milestone, bukan jadwal harian.

**Lantai aman.** `/proof` statis dari W1 adalah pengganti halaman bukti yang pindah dari partner, jadi proyek tidak pernah sampai submit tanpa halaman bukti.

**Hero.** Baris verifier di bawah video hero memakai `verify.py --live` (Tier 1 SPEC), yang dipegang partner bersama `verify.py`. Sampai mode itu ada, baris itu memakai data testnet m12 berlabel. Videonya dibuat lead.

**Vault uji dan m12** (keputusan lead 2026-11-05). Worker dan API testnet mengindeks vault uji dari W2, bukan m12. Saat worker dijalankan dengan alat sungguhan atas m12, siklus 1 lulus penuh (14 PASS), tapi siklus 2–7 gagal di cek `replay`: aturan tidak memberi aksi, sedangkan vault mengeksekusi swap. Pengambilan bundel langsung tanpa worker memberi hasil yang sama, jadi ini sifat data m12. Vault uji dibangun dari kode sekarang, jadi punya view `revealed_salt`, dan agennya mengikuti aturan. Hanya di vault itu verifikasi ulang setelah `reveal` (W6) bisa diuji dengan benar. Snapshot m12 tetap dipakai untuk baris jumlah access key, karena isinya benar dan berlabel. Bila vault uji belum siap saat dibutuhkan, yang tampil hanya siklus 1 m12. Siklus 2–7 tidak disembunyikan diam-diam: bila tampil, tampil apa adanya dengan label FAIL `replay`.

**Gerbang.** Bila worker belum hidup saat vault final lahir, website rilis tanpa riwayat, memakai halaman yang hanya butuh RPC.

Bila waktu sempit, yang dipangkas berurutan: chain asal selain Base, recheck `obs` otomatis, grafik harga per share, lalu `/trust` versi statis. `/app/portfolio` dengan jalur keluarnya dan label `skip` yang jujur tidak dipangkas.

**Cross-chain.** Leg ini ditetapkan masuk, jadi tidak ada di daftar pangkas waktu. Satu-satunya alasan membatalkannya adalah SP4 gagal di mainnet. Bila itu terjadi, bagiannya dilepas dari website dan kata kunci NEAR INTENTS dicabut dari klaim, sesuai SPEC. Klaim itu baru sah setelah ada dua tx hash.

**Pembagian.** Lead mengerjakan `web/`, `api/`, `indexer/`, dan `packages/db/`, menggantikan halaman bukti di daftar partner. Partner tetap memegang bot keeper, Attack Lab, `verify.py`, README, dan video.

**Dokumen lain yang diperbarui di W1.** `docs/PLAN.md`: pembagian kerja, pilihan mainnet, dan UI web, karena PLAN berlaku di atas SPEC. `docs/SPEC.md`: arsitektur, peta kepercayaan termasuk VPS, website, dan 1Click, ancaman baru, jalur `near-connect`, serta leg 1Click dan SP4 yang tidak lagi opsional.

## 11. Belum terbukti

| Hal | Cara mengecek |
| --- | --- |
| Manifest default dan pemilihan jaringan di `near-connect` | Baca kode sumbernya di W2. Keduanya tidak terdokumentasi di README |
| Beberapa wallet populer dengan vault kita di testnet, termasuk yang membuka tab atau app lain | Tanda tangan sungguhan di W2 |
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
| 1Click untuk USDC Arbitrum dan Ethereum | Satu deposit kecil per chain di mainnet, seperti SP4 |
| `quoteRequest.deadline` di jawaban sama dengan yang diminta sampai milidetik, dan margin per chain cukup | Dicek di respons SP4 dan uji per chain. `timestamp` wajib menurut OpenAPI. Header `Date` tidak bisa dibaca browser karena CORS, jadi tidak dipakai |
| Executor manifest default di bawah CSP | Baca kode `near-connect` dan uji tiap wallet populer di W2 |
| Minimum 1Click untuk Arbitrum dan Ethereum | Kuotasi dry per chain saat W7 |
| Kapan 1Click menilai `deadline` di Ethereum: saat transaksi masuk blok atau saat terdeteksi setelah konfirmasi | Ditanyakan ke 1Click dan diuji saat uji Ethereum. Deadline 40 menit dan margin 5 menit adalah perkiraan |
| Kuotasi dry ulang bertanda tangan untuk menambatkan waktu | Dicek di respons SP4 |
| Nasib dana setelah `FAILED` | Tidak terdokumentasi. Ditanyakan ke dukungan 1Click, dan UI tidak menjanjikan apa pun |
| Dua registrasi dalam satu persetujuan | Dicek per wallet di W5. Bila wallet tidak mendukung, dua persetujuan |
| NEAR untuk biaya bagi pengguna yang belum punya NEAR | Roadmap. Belum diketahui apakah 1Click mengirim NEAR native atau wNEAR |
