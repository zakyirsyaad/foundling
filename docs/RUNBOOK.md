# Runbook backend

Panduan menjalankan worker, API, dan Postgres di VPS (WEBSITE §5 dan §9). Semua perintah SQL dan CLI di bawah sudah dijalankan sekali terhadap Postgres lokal (`foundling_test`), dan keluarannya dicocokkan pada 2026-11-05. Perintah yang hanya berlaku di VPS ditandai **[VPS]**.

Kunci vault, kunci keeper, dan kunci governor tidak pernah ada di VPS. VPS hanya membaca chain dan menyajikan riwayat.

## 1. Menyiapkan VPS

Perkiraan RAM 2 GB. Batas memori di Compose berjumlah sekitar 1,5 GB: Caddy 128 MB, API 256 MB, worker 512 MB, Postgres 512 MB, dan migrate 128 MB yang hanya hidup sebentar. Ukuran sebenarnya dicatat di §9.

**[VPS]** Sebagai root, satu kali saja:

```bash
adduser --disabled-password --gecos "" ops
mkdir -p /home/ops/.ssh && cp ~/.ssh/authorized_keys /home/ops/.ssh/ && chown -R ops:ops /home/ops/.ssh && chmod 700 /home/ops/.ssh
```

Masuk sebagai `ops` di terminal lain dan pastikan berhasil sebelum menutup akses root. Lalu, di `/etc/ssh/sshd_config`:

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

```bash
systemctl restart ssh
ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

Pasang Docker Engine dan plugin Compose dari repo resmi Docker, lalu masukkan `ops` ke grup `docker`. Perlu diingat, grup `docker` setara root, jadi grup ini hanya untuk lead.

DNS: arahkan `api.<domain>` (record A) ke IP VPS. Caddy mengambil sertifikat TLS sendiri saat start pertama.

## 2. `.env`

**[VPS]**

```bash
git clone https://github.com/zakyirsyaad/foundling /srv/foundling && cd /srv/foundling
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
```

Isi setiap baris. Password dibuat acak, misalnya dengan `openssl rand -hex 24`, dan tidak ditulis di tempat lain.

- `POSTGRES_PASSWORD`: hanya dipakai layanan `migrate`.
- `DATABASE_URL_READER=postgres://foundling_reader:<pw-reader>@postgres:5432/foundling`
- `DATABASE_URL_WRITER=postgres://foundling_writer:<pw-writer>@postgres:5432/foundling`. Password role diambil `migrate` dari dua URL ini, jadi setiap password cukup ditulis sekali. Karakter di luar huruf dan angka ditulis dalam bentuk %-encoded.
- `ACTIVE_VAULT_ID`, `CHAIN`, `OBS_SOURCE` (`live` untuk mainnet, `rehearsal` untuk vault testnet dengan harga tiruan).
- `ARCHIVAL_RPC_URLS`: setidaknya satu node arsip, misalnya `https://archival-rpc.mainnet.fastnear.com`. Node ini juga diteruskan ke `fetch_proof.py` sebagai `--rpc`, karena node biasa hanya menyimpan sekitar 17–20 jam.
- `WEB_ORIGIN`: origin website persis, misalnya `https://foundling.xyz`, tanpa garis miring di akhir.
- `VERIFIER_COMMIT`: commit yang membangun `wasm_hash` vault aktif, ditulis sebagai SHA penuh 40 karakter, karena git context BuildKit tidak menerima SHA pendek. Commit ini harus sudah ada di GitHub, karena image worker mengambil `cli/` dan `strategy/` dari sana.

## 3. Menyalakan stack, migrasi, dan role

**[VPS]**

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/compose.yml --env-file deploy/.env ps
docker compose -f deploy/compose.yml --env-file deploy/.env logs migrate
```

Urutannya diatur Compose. `postgres` sehat lebih dulu, lalu `migrate` menjalankan migrasi dan `roles.sql` sebagai owner, memberi password, dan menyalakan LOGIN untuk `foundling_reader` dan `foundling_writer`. Setelah itu `migrate` keluar dengan kode 0, baru kemudian `api` dan `worker` start. Log `migrate` diakhiri baris `migrations and roles applied`.

Cek role. Di lokal jalankan dengan `psql -p 55432 -d foundling_test`; di VPS dengan `docker compose ... exec postgres psql -U postgres -d foundling`:

```sql
select rolname, rolcanlogin from pg_roles where rolname like 'foundling_%' order by 1;
```

Hasil yang benar: `foundling_reader | t` dan `foundling_writer | t`. Role reader hanya bisa SELECT, dengan `statement_timeout` 2 detik. Role writer bisa SELECT, INSERT, dan UPDATE, ditambah DELETE pada `cycles` dan `nav_points`.

Untuk mengganti password, ubah URL di `.env`, lalu jalankan `docker compose ... run --rm migrate` dan `docker compose ... up -d api worker`.

## 4. Membaca `sync_state`: heartbeat dan galat terakhir

```sql
select vault_id, position, tip, tip - scanned_tip as lag_blocks,
       date_trunc('second', now() - heartbeat_at) as heartbeat_age,
       date_trunc('second', now() - indexed_at) as last_success_age, last_error
from sync_state;
```

- `heartbeat_age` di bawah 1 menit berarti proses worker hidup, karena putaran indeks berjalan tiap 30 detik. Heartbeat ditulis di awal setiap putaran, termasuk putaran yang kemudian gagal.
- `last_success_age` di bawah 1 menit berarti putaran terakhir selesai. Bila heartbeat segar tapi umur ini terus naik, setiap putaran gagal, dan alasannya ada di `last_error`.
- `last_error` kosong berarti putaran terakhir berhasil. Galat pada satu putaran tidak memajukan `position`, dan putaran berikutnya mencoba lagi. Pesan `nav for cycle N` berarti titik NAV satu siklus belum terbaca; siklus lain tetap jalan, dan pembacaannya dicoba lagi setiap putaran.
- `lag_blocks` adalah jarak tip chain sekarang dari tip yang dipindai putaran sukses terakhir. Angkanya tetap kecil walau vault sedang sepi.
- Transaksi vault yang bentuknya tidak dikenali parser menghentikan putaran sampai parser diperbaiki. Ini disengaja (gagal tertutup), supaya event tidak terlewat diam-diam.

Antrean bukti:

```sql
select verifier_state, obs_state, replay, count(*) from proofs group by 1, 2, 3 order by 1, 2, 3;
select nonce, attempts, next_attempt_at, left(last_error, 80) as last_error
from proofs where last_error is not null order by nonce;
```

Status akhir verifier adalah `done` atau `failed_to_build`, dan obs selesai bila `done`. Sumber yang tidak terbaca dicoba lagi setelah 5, 15, 60, 180, lalu 360 menit. Setelah 24 jam, bukti dicatat `failed_to_build` dan obs dicatat `skip`. Siklus yang tertutup tanpa `decision` langsung mendapat status akhir `skip`, karena tidak ada yang bisa dibuktikan.

Untuk mencoba lagi sekarang, termasuk bukti yang sudah menyerah, mulai antrean siklus itu dari awal:

```sql
update proofs set verifier_state = 'queued', obs_state = 'queued', obs_recheck = null,
       next_attempt_at = now(), attempts = 0, first_attempt_at = null, last_error = null
where nonce = 3;  -- atau: where verifier_state = 'failed_to_build'
```

Bundel yang sudah tersimpan tidak diambil ulang, jadi hanya verifier dan recheck obs yang dijalankan lagi.

Lewat API publik: `curl -s https://api.<domain>/v1/status`.

## 5. Membangun ulang `cycles` dari `events`

`events` hanya ditambah, sedangkan `cycles` adalah turunan. Bila aturan turunan berubah atau baris `cycles` rusak:

**[VPS]**

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env stop worker
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm worker /app/node_modules/.bin/tsx indexer/src/rederive-cli.ts
docker compose -f deploy/compose.yml --env-file deploy/.env start worker
```

Di lokal, dari `indexer/`:

```bash
ACTIVE_VAULT_ID=vault.fdl-m12-0d1276.testnet CHAIN=testnet DATABASE_URL_WRITER=postgres://localhost:55432/foundling_test npx tsx src/rederive-cli.ts
```

Keluaran: `vault.fdl-m12-0d1276.testnet: 7 cycles rebuilt from events`. Baris `proofs` yang hilang untuk siklus dengan `decision` ikut diantrekan ulang. Titik NAV untuk siklus tertutup yang belum punya baris diisi oleh putaran indeks berikutnya.

## 6. Mengganti `ACTIVE_VAULT_ID` untuk vault final

1. Isi `.env`: `ACTIVE_VAULT_ID` dengan vault final, `CHAIN=mainnet`, `OBS_SOURCE=live`, dan `VERIFIER_COMMIT` dengan commit yang membangun `wasm_hash` vault final. Cek nilainya dengan view `agent` milik vault.
2. **[VPS]** `docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build worker api`
3. Cek `sync_state` (§4) untuk vault baru. Baris vault lama tetap ada, karena setiap tabel dikunci per `vault_id`.
4. Di Vercel: `NEXT_PUBLIC_VAULT_ID` dan `NEXT_PUBLIC_API_ORIGIN=https://api.<domain>`.

Worker harus sudah hidup sebelum siklus pertama vault final, supaya bundel bukti diambil selagi log RPC masih ada.

## 7. Bila lead tidak terjangkau, 16–18 Nov

Partner tidak memegang kunci vault, keeper, atau governor, dan tidak membutuhkannya.

**Alert.** Workflow `Heartbeat` jalan tiap 15 menit dan mengirim email GitHub bila gagal. Baris `FAIL` di log job menjelaskan sebabnya:

- `worker heartbeat is N minutes old`: worker berhenti atau macet.
- `last successful index round was N minutes ago`: worker hidup, tapi setiap putaran gagal. Alasannya ada di `last_error` (§4).
- `API ... answered HTTP 503` atau `could not be read`: API atau VPS mati.
- `keeper ... holds X NEAR, below Y`: saldo keeper menipis, jadi siklus berikutnya bisa gagal membayar gas.

Workflow ini baru jalan setelah lead mengisi variabel repo `API_ORIGIN` dan `KEEPER_ACCOUNT`, dan bila perlu `KEEPER_MIN_NEAR` (bawaan 2) dan `RPC_URL`. `RPC_URL` bawaannya node mainnet, jadi selama vault masih di testnet isi `https://rpc.testnet.fastnear.com`; kalau tidak, cek keeper akan selalu gagal.

**Me-restart worker.** Lead memberi partner user SSH sendiri tanpa grup `docker`, dengan satu aturan sudo. **[VPS]** Di `/etc/sudoers.d/foundling-partner`, dibuat dengan `visudo -f`:

```
partner ALL=(root) NOPASSWD: /usr/bin/docker compose -f /srv/foundling/deploy/compose.yml --env-file /srv/foundling/deploy/.env restart worker
```

Partner lalu menjalankan:

```bash
sudo /usr/bin/docker compose -f /srv/foundling/deploy/compose.yml --env-file /srv/foundling/deploy/.env restart worker
curl -s https://api.<domain>/v1/status
```

Bila `heartbeat_at` kembali segar dalam satu menit, selesai. Bila tidak, catat jamnya (WIB) dan pesan galatnya, lalu tunggu lead. Jangan mengubah `.env` atau database.

**Saldo keeper.** Keeper berjalan di luar VPS. Partner mengabari lead. Bila partner mau, ia bisa mengirim NEAR dari wallet sendiri ke akun keeper, tanpa kunci apa pun dari vault.

## 8. Yang tetap jalan saat VPS mati

- Website tetap tampil. Landing dan `/app` membaca chain lewat RPC, bukan lewat API.
- Deposit, `redeem`, klaim, `cancel_deposit`, dan `withdraw_claimable` ditandatangani langsung dari wallet ke kontrak.
- Panel macet (`advance`, `abort_stale_cycle`, `expire_decision`) juga langsung ke kontrak.
- Halaman riwayat, NAV, dan hasil bukti menampilkan "pending" sampai API kembali.
- Bundel bukti yang sudah ada aman di Postgres dan di cabang `live-proofs`. Siklus yang terjadi selama VPS mati diambil saat worker hidup lagi lewat node arsip (`--rpc`), jadi tidak terbatas jendela 17–20 jam node biasa.

## 9. Pengukuran W2 di VPS (WEBSITE §11)

**[VPS]** Apakah `api.kraken.com` terjangkau? `recheck_obs.py` membutuhkannya untuk jalur `pb`. Cek dari dalam worker:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env exec worker python3 -c "
import urllib.request,sys
try:
    r=urllib.request.urlopen('https://api.kraken.com/0/public/Time',timeout=10); print('kraken OK', r.status)
except Exception as e:
    print('kraken FAIL', type(e).__name__, str(e)[:120]); sys.exit(1)"
```

Dari jaringan lokal lead pada 2026-11-05, hasilnya `kraken FAIL ... Hostname mismatch`, karena jaringan itu memblokir Kraken. Bila VPS juga gagal, setiap cek `pb` di recheck obs menjadi SKIP. Pilih VPS di wilayah yang menjangkau Kraken, atau catat keterbatasan ini di halaman `/proof`.

**[VPS]** RAM sungguhan, setelah stack hidup minimal satu jam dan worker sudah memproses satu bukti:

```bash
free -m
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"
```

| Pengukuran | Tanggal | Hasil |
| --- | --- | --- |
| `api.kraken.com` dari worker | | |
| RAM total terpakai (`free -m`) | | |
| Puncak RAM worker (`docker stats`) | | |
