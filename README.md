# ⛏️ hashminer

**HASH256 Multi-Core CPU Miner** untuk [https://hash256.org/mine](https://hash256.org/mine)

> Mining HASH token menggunakan semua CPU core secara paralel dengan worker threads Node.js.

---

## ✨ Fitur

- 🚀 Multi-core paralel via `worker_threads`
- ⚡ Hash engine otomatis: `keccak native C` → `js-sha3` → `ethers fallback`
- 📊 Live hashrate, peak H/s, dan total hashes di terminal
- 📝 Log otomatis ke `miner.log`
- 🔁 Auto-retry jika TX gagal atau epoch berubah
- 🛡️ Gas estimation sebelum kirim TX

---

## 📋 Requirements

- Node.js v18+
- npm
- RPC URL (Ethereum mainnet, e.g. Infura / Alchemy)
- Private key wallet dengan sedikit ETH untuk gas

---

## 🛠️ Install

```bash
git clone https://github.com/airdropumbrella/hashminer
cd hashminer
npm install
npm install js-sha3 keccak   # opsional tapi sangat disarankan untuk hashrate maksimal
cp .env.example .env
nano .env
```

---

## ⚙️ Konfigurasi `.env`

```env
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
CORES=64          # opsional, default: semua CPU core
REPORT_EVERY=1000000  # opsional, default: 1.000.000
```

---

## ▶️ Jalankan

```bash
npm start
```

---

## 🖥️ Background (screen)

```bash
apt install -y screen
screen -S hash
npm start
# Keluar tanpa matikan: CTRL+A lalu D
# Balik lagi: screen -r hash
```

---

## 🔢 Batasi Core

Set di `.env`:
```env
CORES=32
```

Atau langsung di terminal:
```bash
CORES=32 npm start
```

---

## 📈 Estimasi Hashrate

| Hash Mode | Per Core | 64 Core | 128 Core |
|---|---|---|---|
| ethers fallback | ~7K H/s | ~470K H/s | ~940K H/s |
| js-sha3 | ~25K H/s | ~1.6M H/s | ~3.2M H/s |
| **keccak native C** | **~35K H/s** | **~2.2M H/s** | **~4.5M H/s** |

> Hash mode aktif terlihat di log saat startup. Install `js-sha3` dan `keccak` untuk performa terbaik.

---

## 📄 Contoh Output

```
[2026-05-11T04:28:41Z] ==========================================
[2026-05-11T04:28:41Z]   HASH256 Multi-Core CPU Miner
[2026-05-11T04:28:41Z] ==========================================
[2026-05-11T04:28:41Z] Wallet      : 0xYourWalletAddress
[2026-05-11T04:28:41Z] CPU Cores   : 64
[2026-05-11T04:28:41Z] Hash mode   : keccak native C
[2026-05-11T04:28:41Z] ------------------------------------------
[2026-05-11T04:28:41Z] Era         : 0
[2026-05-11T04:28:41Z] Reward      : 100.0 HASH
[2026-05-11T04:28:41Z] Difficulty  : 105312291668...
[2026-05-11T04:28:41Z] Mining dengan 64 core...
  2,200,000 H/s | 1234.5M hashes | peak 2,250,000 H/s | 64 cores | 120s
```

---

## ⚠️ Tips

- Gunakan RPC dengan rate limit tinggi (Alchemy / Infura)
- Jangan lupa sisakan ETH di wallet untuk gas fee
- Jalankan di background dengan `screen` agar tidak terputus saat SSH disconnect
- Untuk hashrate maksimal, pastikan `Hash mode: keccak native C` muncul di log

---

## 📜 Lisensi

MIT
