# hashminer

HASH256 multi-core CPU miner untuk https://hash256.org/mine

## Install

```bash
npm install
cp .env.example .env
nano .env
```

## Jalankan

```bash
npm start
```

## Background (screen)

```bash
apt install -y screen
screen -S hash
npm start
# Keluar tanpa matikan: CTRL+A lalu D
# Balik lagi: screen -r hash
```

## Batasi core

```bash
CORES=4 npm start
```
