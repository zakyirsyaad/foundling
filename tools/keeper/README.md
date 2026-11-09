# Bot keeper

Menjalankan siklus vault tanpa intervensi: `trigger_cycle`, `execute_decision`, dan `advance`, `abort_stale_cycle`, `expire_decision` bila perlu (SPEC §3.4). Python 3.9 atau lebih baru, stdlib saja. Penandatanganan lewat `near` (near-cli-rs) yang sudah terpasang, dengan pola `tools/lib.sh`.

## Menjalankan

```
export FOUNDLING_VAULT=vault.<akun>.testnet
export FOUNDLING_KEEPER_ACCOUNT=<akun keeper>
export FOUNDLING_KEEPER_KEY_FILE=<jalur keyfile function-call key milik lead>
python3 -m tools.keeper run
```

Dari root repo. Berhenti dengan Ctrl-C; state tersimpan, jadi menjalankan ulang melanjutkan siklus yang terbuka. Saat start, bot menolak jalan bila `roles().keeper` di vault bukan `FOUNDLING_KEEPER_ACCOUNT`.

| Variabel | Argumen | Keterangan |
|---|---|---|
| `FOUNDLING_VAULT` | `--vault` | Akun vault. Wajib. |
| `FOUNDLING_KEEPER_ACCOUNT` | `--keeper-account` | Akun penanda tangan (`sign-as`). Wajib. |
| `FOUNDLING_KEEPER_KEY_FILE` | `--key-file` | Jalur keyfile. Wajib. Hanya diserahkan ke near-cli; bot tidak pernah membukanya. |
| `FOUNDLING_NETWORK` | `--network` | `testnet` (bawaan). Jaringan lain apa pun (`mainnet`, `localnet`, …) ditolak tanpa `--allow-mainnet`. |
| `FOUNDLING_RPC_URLS` | `--rpc-urls` | Dipisah koma, minimal dua. Bawaan hanya untuk testnet. |
| `FOUNDLING_KEEPER_LOG` | `--log` | Log JSONL, bawaan `keeper-soak.jsonl`. |
| `FOUNDLING_KEEPER_STATE` | `--state` | State restart, bawaan `<log>.state.json`. |

Opsi lain: `--poll-interval` (5 s), `--retry-interval` (30 s), `--gas-trigger` (300), `--gas-execute` (300), `--gas-advance` (150) dalam TGas, `--max-call-failures` (12). Gas di bawah minimum kontrak (250, 240, 110; dari `cycle.rs`, `swap.rs`, `recovery.rs`) ditolak, dan sebuah tes menjaga angka itu sama dengan sumber Rust.

Gas dibeli di muka seharga 0,001 NEAR per TGas dan selisihnya dikembalikan (SPEC §3.1): satu `trigger_cycle` pada 300 TGas menahan 0,3 NEAR. Batasnya adalah allowance function-call key (bila ada) dan saldo akun keeper, jadi keduanya harus lebih dari itu dengan ruang untuk beberapa siklus. Panggilan yang gagal tetap membakar gas, itulah sebabnya kegagalan berulang dibatasi (di bawah).

## Cara kerja

Tiap tick membaca satu `block` final (tinggi dan waktu chain) dan `stage()`, lalu mengirim paling banyak satu panggilan.

| Tahap | Aksi |
|---|---|
| `Idle` | Menutup siklus yang terbuka (setelah satu tahap non-Idle terlihat, atau 30 detik sejak trigger, karena node yang tertinggal juga membaca Idle). Lalu bila cooldown dari `policy()` lewat, vault tidak beku/halt, `ops_spent() + outlayer_deposit` masih di bawah `ops_budget`, dan kedua feed harga non-null: `trigger_cycle`. Pengecekan yang gagal diulang tiap 15 detik, bukan tiap tick. |
| `AwaitingDecision`, `AwaitingPrice` | Menunggu. Bila `entered_block + abort_after_blocks` terlewati: `abort_stale_cycle`. |
| `DecisionReady` | Bila `expires_at` terlewati: `expire_decision`. Bila belum (dan vault tidak beku/halt): `execute_decision(nonce)`, tanpa pengecekan oracle di sisi bot. Feed null dijawab vault dengan `Rejected(PRICE_UNAVAILABLE)`, yang tercatat di chain dan mengembalikan tahap ini, jadi eksekusi diulang tiap `--retry-interval` tanpa `trigger_cycle` baru, sampai `expires_at`. |
| `Stuck`, atau `Depositing`/`Swapping`/`Withdrawing`/`Probing` lewat `stuck_after` | `advance(nonce)` tepat sekali per jendela `stuck_after`, per `(nonce, since)`. Probe yang gagal kembali ke `Stuck` dengan `attempt` naik tetapi `since` sama, jadi tetap jendela yang sama. |

Panggilan `trigger_cycle` yang ditolak `COOLDOWN` (trigger yang tidak terlihat bot) membuat bot menunggu satu cooldown penuh.

Kegagalan panggilan dibatasi supaya tidak menguras gas: tiap kegagalan beruntun pada method yang sama menggandakan jedanya (`--retry-interval`, 2×, 4×, … sampai 10 menit), dihitung dari akhir panggilan, dan jeda itu disimpan di state sehingga restart tidak menghapusnya. Setelah 3 kegagalan satu method, bot bertanya `roles()` ke vault; bila keepernya sudah bukan akun ini (rotasi), bot berhenti dengan kode 2. Setelah `--max-call-failures` kegagalan beruntun, bot berhenti dengan kode 1. Satu panggilan yang berhasil mengosongkan hitungannya.

Semua view dalam satu tick dipatok ke tinggi blok `block()` tick itu; node yang belum sampai ke blok itu memberi error dan dicoba di endpoint berikutnya. Blok yang lebih tua dari yang sudah terlihat membuat tick dilewati dan dicatat (`"kind":"error"`, `stale_block`); bila enam tick beruntun begitu, bacaan lama dianggap pencilan dan batas direset, supaya satu pembacaan blok yang keliru tidak menghentikan bot selamanya.

Pengecekan feed sebelum `trigger_cycle` memakai view yang sama dengan vault: `list_prices_no_older_than({price_ids, age: price_max_age})` pada akun `oracle()`.

## Log

Satu baris JSON per siklus selesai (`"kind":"cycle"`):

```
{"kind":"cycle","vault":"…","nonce":12,"final_stage":"Idle","result":"Hold","code":"NO_DECISION",
 "txs":[{"method":"trigger_cycle","hash":"…"}],"duration_s":14.0,"started_at":"…","ended_at":"…",
 "stages_seen":["AwaitingDecision"],"stuck":false,"price_retries":0,"failed_calls":0,"resumed":false,"trigger_hash_missing":false}
```

`result` dan `code` dibaca dari event `EVENT_JSON` pada transaksi siklus itu sendiri, hanya dari receipt yang dieksekusi akun vault (pohon transaksi juga memuat OutLayer, oracle, Ref, dan token, yang bisa mencetak baris berbentuk event vault); event cacat dilewati: `Hold`, `CycleFailed`, `Rejected`, `Executed`, `SwapReverted`, `CycleAborted`, atau `Unknown` bila event tidak ditemukan. `price_retries` menghitung `Rejected(PRICE_UNAVAILABLE)` yang diulang; `failed_calls` menghitung panggilan bot dalam siklus itu yang ditolak. `resumed: true` berarti bot mengambil alih siklus yang tidak dimulainya (dipicu pihak lain, atau jejaknya hilang bersama state), jadi `txs` kosong dan hasilnya `Unknown`. Hash trigger bot sendiri disimpan di state (`pending`) begitu `trigger_cycle` kembali dengan hash, sebelum bot menunggu nonce, jadi gangguan RPC atau node yang tertinggal tidak membuat siklus itu `Unknown`: tick berikutnya melanjutkannya dengan hash itu (nonce-nya `last_nonce` sebelum trigger + 1, apa pun yang terjadi sesudahnya), atau menutupnya bila siklusnya sudah selesai. `pending` dibuang bila nonce tidak bergerak sampai `nonce_wait` + 30 detik. Tanpa hash tidak ada yang bisa dikaitkan, jadi tidak ada `pending`. Trigger bot yang dinyatakan berhasil oleh near-cli tetapi tanpa hash tetap siklus bot sendiri (yang timeout tanpa hash mungkin tidak pernah sampai, jadi siklusnya diambil alih seperti siklus pihak lain): `resumed: false` dan `trigger_hash_missing: true`, jadi soak menilainya (hasilnya bisa `Unknown` bila tak ada tx lain dari bot di siklus itu, dan itu `FAIL`). Jumlahnya dicetak terpisah (`Cycles the bot triggered without a tx hash`). Siklus yang diakhiri pihak lain (siapa saja boleh memanggil `advance`, `abort_stale_cycle`, `expire_decision`) juga bisa `Unknown`, karena eventnya tidak ada di tx milik bot. State restart hanya dipakai bila ditulis untuk vault yang sama.

Baris lain di berkas yang sama, bukan siklus: `"kind":"skip"` (alasan tidak memicu: `price_null`, `frozen`, `halted`; dicatat saat alasan berubah atau tiap 10 menit), `"kind":"call_failed"` (panggilan ditolak, dengan teks kesalahan yang sudah dibersihkan dari kunci), `"kind":"error"` (RPC gagal).

## Ringkasan soak

```
python3 -m tools.keeper summary keeper-soak.jsonl [--min-cycles 1]
```

Keluar dengan kode 0 (`Soak: PASS`) atau 1 (`Soak: FAIL`); keluarannya berbahasa Inggris, seperti keluaran CLI lain. Yang diharapkan (SPEC §3.7): `Hold(NO_DECISION)`, `Rejected(PRICE_UNAVAILABLE)`, `Rejected(PRICE_WIDE)`, dan `CycleFailed(NULL_RESULT)`. `Executed` diizinkan. `Soak: FAIL` bila ada:

- siklus dengan hasil lain, termasuk `CycleFailed` selain `NULL_RESULT` (juga `EXPIRED`, kecuali siklus itu punya `price_retries` > 0 dan `failed_calls` = 0: feed null yang bertahan melewati `decision_ttl` ditolak `PRICE_UNAVAILABLE` berulang lalu berakhir di `EXPIRED`, dan itu dihitung sebagai `PRICE_UNAVAILABLE` yang diharapkan; panggilan yang gagal sendiri mencabut pengecualian itu), `SwapReverted`, `CycleAborted`, dan `Unknown` (kecuali siklus yang tidak dipicu bot, lihat di bawah);
- siklus yang pernah `Stuck`, walau akhirnya pulih;
- baris log rusak;
- siklus kurang dari `--min-cycles`.

Siklus `resumed: true` tanpa `txs` dan tanpa `failed_calls` (bot menemukannya sudah berjalan) tidak dihitung sebagai siklus dan tidak dinilai: jumlahnya dicetak terpisah (`Cycles the bot did not trigger`) dan tidak ikut `--min-cycles`. Yang pernah `Stuck` tetap `FAIL`. Jadi trigger manual selama soak tidak menggagalkannya, tetapi siklus itu juga tidak membuktikan apa pun tentang bot.

Baris `error` (RPC gagal) dan `call_failed` ditampilkan jumlahnya, dengan peringatan bila ada panggilan gagal, tetapi tidak menggagalkan soak. Keluarannya mendaftar nonce dan alasan tiap siklus tak terduga.

## Kunci

Bot hanya meneruskan jalur keyfile ke near-cli sebagai argumen. near-cli sendiri mencetak jalur itu pada kegagalan; sebelum disimpan atau ditampilkan, keluarannya dibersihkan dari pola kunci (`ed25519:…`, `secp256k1:…`), kolom `private_key`/`secret_key`/`seed_phrase`, jalur keyfile, dan kode warna. Banner awal hanya menampilkan host RPC. `.gitignore` mengabaikan `keeper-soak.jsonl*`.

## Tes

```
python3 -m unittest tests.test_keeper_rpc tests.test_keeper_near tests.test_keeper_bot \
  tests.test_keeper_soak tests.test_keeper_cli
```

Tanpa jaringan. Vault dan RPC dipalsukan oleh `tests/keeper_fakes.py` (model kecil tahap-tahap vault, termasuk `AwaitingPrice`, probe yang kembali ke `Stuck`, dan pembacaan basi; bukan kontrak sungguhan). Satu-satunya masukan dari program asli adalah `tests/fixtures/near-cli-missing-key-file.txt`, keluaran near-cli-rs 0.30.1 untuk keyfile yang tidak ada; ia menunjukkan bahwa near-cli mencetak ulang seluruh perintah termasuk jalur keyfile, itulah sebabnya keluarannya di-scrub.

## Belum dibuktikan

- Belum dijalankan terhadap vault testnet atau sandbox Rust; hanya model palsu dan pengecekan bahwa near-cli menerima urutan argumennya.
- Perilaku near-cli saat panggilan gagal on-chain (kode keluar, ada tidaknya `Transaction ID`) belum diamati. Bot memakai tahap vault, bukan hasil near-cli, sebagai kebenaran.
- Bahwa `EXPERIMENTAL_tx_status` memuat log callback OutLayer (yield/resume) di pohon receipt transaksi pemicu belum dibuktikan. Bila tidak, hasil siklus tercatat `Unknown` dan soak `FAIL` (aman, tetapi tidak informatif).
