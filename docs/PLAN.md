# Foundling: rencana kerja

Dokumen ini dan `docs/SPEC.md` adalah sumber kebenaran proyek. Rencana ada di sini, detail produk ada di SPEC.

Tim: lead dan partner. Partner membantu lead. Tenggat submit 15 Nov 06:59 WIB, target kirim 13 Nov.

## Pembagian per fitur

Pemilik fitur menulis kode dan tesnya sendiri.

| Fitur | Pemilik |
| --- | --- |
| Deposit dan redeem | Lead |
| Batas risiko: cap, cooldown, freeze, peran | Lead |
| Siklus trading | Lead |
| Swap Rhea dan harga oracle | Lead |
| Strategi di OutLayer dan penasihat NEAR AI | Lead |
| Komitmen, reveal, replay, cek attestation | Lead |
| Deploy mainnet dan vault final | Lead |
| Bot keeper dan skrip deploy | Partner |
| `verify.py` dan halaman bukti | Partner |
| Sandbox dan Attack Lab: harness, mock OutLayer, tes serangan | Partner |
| CI, README, video demo | Partner |

## Milestone

| # | Selesai bila | Pemilik | Target |
| --- | --- | --- | --- |
| 1 | Partner bisa clone repo dan build `contracts/vault`; mesin partner bisa build amd64 (Linux x86-64 atau Docker `--platform linux/amd64`); akun guardian testnet dan mainnet dibuat | Partner | Sebelum mulai |
| 2 | Uji mainnet kecil selesai: callback OutLayer (SP1a, keputusan mode NEAR atau fallback A paling lambat 2 Nov 21:00 WIB), rahasia terikat hash (SP1b, SP2), rute Rhea (SP8) | Lead, partner siapkan harness | 3 Nov |
| 3 | Vault dasar lulus tes di sandbox: deposit, redeem, cap, freeze | Lead | 4 Nov |
| 4 | Satu siklus penuh di mainnet pada vault latihan, lalu `redeem` nyata | Lead, bot dari partner | 6 Nov |
| 5 | Jalur macet dan pulih selesai, Attack Lab lulus, soak semalam lulus, kontrak beku | Lead, Partner | 9 Nov |
| 6 | Cadangan kunci diuji; vault final lahir tanpa kunci, satu siklus dan satu `redeem` nyata; partner mendemokan `freeze` | Lead, Partner | 11 Nov |
| 7 | `reveal` dan replay lulus di mainnet, `verify.py` lulus | Lead, Partner | 12 Nov |
| 8 | LICENSE, video, README, post X, repo publik, submit oleh lead | Partner, Lead | 13 Nov |

Bot keeper, halaman bukti, dan kredit NEAR AI dijaga hidup sampai penjurian selesai 18 Nov. Bila bot berjalan di Mac, Mac harus tersambung listrik.

Urutan jaringan: sandbox → testnet → mainnet kecil → mainnet final. Eksekutor OutLayer testnet restart tiap 11–42 detik, jadi testnet cukup untuk gladi run pendek, sedangkan keputusan diambil dari hasil mainnet.

## Sebelum kode dimulai

1. Partner diundang ke repo dan milestone 1 lulus.
2. Akun user macOS kedua dibuat lead untuk kunci mainnet.
3. Disk Mac lead bebas ≥40 GB.

## Aturan

- Partner kerja di cabang, lead yang merge ke `main`.
- Kunci mainnet hanya dipegang lead, kecuali kunci guardian yang dipegang partner.
- Kunci tidak pernah masuk repo.
- Hanya lead yang submit.

## Dipangkas dari rencana awal

- CLI Rust penuh diganti skrip di atas near-cli.
- Halaman bukti statis, tanpa tombol cek ulang.
- `verify.py` memegang semua pemeriksaan non-kripto; cek attestation dan signature ada di alat kecil milik lead.
- Fitur opsional (UI web, 1Click, Trezu, E2EE) hanya dikerjakan bila milestone 4 selesai lebih awal.
