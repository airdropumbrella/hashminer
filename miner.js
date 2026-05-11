require("dotenv").config();

const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os  = require("os");
const fs  = require("fs");
const path = require("path");

const RPC_URL        = process.env.RPC_URL;
const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const NUM_CORES      = parseInt(process.env.CORES) || os.cpus().length;
const LOG_FILE       = path.join(__dirname, "miner.log");

// Semakin tinggi = semakin sedikit IPC overhead antar worker → hashrate naik
// Di 192 core, 1_000_000 adalah sweet spot
const REPORT_EVERY   = parseInt(process.env.REPORT_EVERY) || 1_000_000;

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER THREAD
// ═══════════════════════════════════════════════════════════════════════════════
if (!isMainThread) {
  const { challenge, difficulty, startNonce, workerId } = workerData;

  // ── Coba native C keccak ──────────────────────────────────────────────────
  let hashFn = null;
  try {
    const Keccak = require("keccak");
    // Test sekali dulu
    Keccak("keccak256").update(Buffer.alloc(1)).digest();
    hashFn = (buf) => Keccak("keccak256").update(buf).digest();
  } catch (_) {
    hashFn = null; // fallback ke ethers
  }

  const challengeBuf = Buffer.from(challenge.slice(2), "hex"); // 32 bytes

  // Alokasikan SEKALI, reuse terus — hindari GC pressure
  const packed   = Buffer.allocUnsafe(64);
  const nonceBuf = Buffer.allocUnsafe(32);

  challengeBuf.copy(packed, 0); // packed[0..31] = challenge (tidak berubah)

  // Target difficulty sebagai Buffer untuk perbandingan byte-per-byte (lebih cepat dari BigInt)
  const diffHex = BigInt(difficulty).toString(16).padStart(64, "0");
  const diffBuf = Buffer.from(diffHex, "hex");

  let nonce    = BigInt(startNonce);
  let attempts = 0;

  // Tulis BigInt ke buffer 32 byte tanpa alokasi
  function writeBE(buf, val) {
    let v = val;
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }

  // Bandingkan dua Buffer 32 byte: return true jika a < b
  function bufLT(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  }

  // ── FAST PATH: native C ───────────────────────────────────────────────────
  if (hashFn) {
    while (true) {
      writeBE(nonceBuf, nonce);
      nonceBuf.copy(packed, 32); // packed[32..63] = nonce

      const hash = hashFn(packed);
      attempts++;

      if (bufLT(hash, diffBuf)) {
        parentPort.postMessage({ type: "found", nonce: nonce.toString(), hash: "0x" + hash.toString("hex"), workerId });
        break;
      }

      nonce++;
      if (attempts % REPORT_EVERY === 0) {
        parentPort.postMessage({ type: "progress", attempts, workerId });
      }
    }

  // ── FALLBACK: ethers.js ───────────────────────────────────────────────────
  } else {
    const { solidityPackedKeccak256 } = require("ethers");
    const diffBigInt = BigInt(difficulty);

    while (true) {
      const hash = solidityPackedKeccak256(["bytes32", "uint256"], [challenge, nonce]);
      attempts++;

      if (BigInt(hash) < diffBigInt) {
        parentPort.postMessage({ type: "found", nonce: nonce.toString(), hash, workerId });
        break;
      }

      nonce++;
      if (attempts % REPORT_EVERY === 0) {
        parentPort.postMessage({ type: "progress", attempts, workerId });
      }
    }
  }

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN THREAD
// ═══════════════════════════════════════════════════════════════════════════════
} else {

  // ── Logger ────────────────────────────────────────────────────────────────
  const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logStream.write(line + "\n");
  }

  // ── Env check ─────────────────────────────────────────────────────────────
  function checkEnv() {
    if (!RPC_URL || !PRIVATE_KEY) {
      console.error("ERROR: Isi RPC_URL dan PRIVATE_KEY di .env dulu.");
      process.exit(1);
    }
    if (!PRIVATE_KEY.startsWith("0x")) {
      console.error("ERROR: PRIVATE_KEY harus diawali 0x.");
      process.exit(1);
    }
  }

  // ── Nonce: bagi range ke setiap worker ────────────────────────────────────
  // Setiap worker dapat slice berbeda dari 256-bit space → tidak ada duplikasi
  function startNonce(workerId, total) {
    const MAX   = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
    const slice = MAX / BigInt(total);
    const base  = slice * BigInt(workerId);
    const jitter = BigInt(Math.floor(Math.random() * 1_000_000));
    return (base + jitter).toString();
  }

  // ── Kill semua worker ─────────────────────────────────────────────────────
  function killAll(workers) {
    for (const w of workers) { try { w.terminate(); } catch (_) {} }
  }

  // ── Core mining engine ────────────────────────────────────────────────────
  function mineRound(challenge, difficulty) {
    return new Promise((resolve, reject) => {
      const workers        = [];
      const workerAttempts = new Array(NUM_CORES).fill(0);
      let found            = false;
      let totalAttempts    = 0;
      const t0             = Date.now();
      let peakRate         = 0;

      // Status line setiap detik
      const ticker = setInterval(() => {
        const secs = (Date.now() - t0) / 1000;
        const rate = Math.floor(totalAttempts / secs);
        if (rate > peakRate) peakRate = rate;
        process.stdout.write(
          `\r  \x1b[32m${rate.toLocaleString()}\x1b[0m H/s` +
          ` | ${(totalAttempts / 1e6).toFixed(1)}M hashes` +
          ` | peak ${peakRate.toLocaleString()} H/s` +
          ` | ${secs.toFixed(0)}s      `
        );
      }, 1000);

      for (let i = 0; i < NUM_CORES; i++) {
        const w = new Worker(__filename, {
          workerData: { challenge, difficulty, startNonce: startNonce(i, NUM_CORES), workerId: i }
        });

        w.on("message", (msg) => {
          if (msg.type === "progress") {
            totalAttempts += msg.attempts - workerAttempts[msg.workerId];
            workerAttempts[msg.workerId] = msg.attempts;
          }

          if (msg.type === "found" && !found) {
            found = true;
            clearInterval(ticker);
            killAll(workers);

            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const finalRate = Math.floor(totalAttempts / parseFloat(elapsed));
            process.stdout.write("\n");
            resolve({ nonce: msg.nonce, hash: msg.hash, elapsed, rate: finalRate, attempts: totalAttempts });
          }
        });

        w.on("error", (err) => {
          if (!found) {
            found = true;
            clearInterval(ticker);
            killAll(workers);
            reject(err);
          }
        });

        workers.push(w);
      }
    });
  }

  // ── Session stats ─────────────────────────────────────────────────────────
  let totalMints    = 0;
  let totalAttempts = 0;
  let peakHashrate  = 0;
  const sessionStart = Date.now();

  // ── Main loop ─────────────────────────────────────────────────────────────
  async function run() {
    checkEnv();

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    // Cek keccak mode
    let native = false;
    try { const K = require("keccak"); K("keccak256").update(Buffer.alloc(1)).digest(); native = true; } catch (_) {}

    log("==========================================");
    log("  HASH256 Multi-Core CPU Miner (max opt)");
    log("==========================================");
    log(`Wallet      : ${wallet.address}`);
    log(`Contract    : ${CONTRACT_ADDRESS}`);
    log(`CPU Cores   : ${NUM_CORES}`);
    log(`Keccak      : ${native ? "native C (fast)" : "ethers.js (LAMBAT — install: npm i keccak)"}`);
    log(`REPORT_EVERY: ${REPORT_EVERY.toLocaleString()}`);
    log(`Log         : ${LOG_FILE}`);
    log("");

    if (!native) {
      log("⚠ PERINGATAN: native keccak tidak tersedia!");
      log("  Jalankan: npm install keccak");
      log("  Hashrate bisa 5-10x lebih lambat!\n");
    }

    let errors = 0;

    while (true) {
      try {
        // Fetch state & challenge bersamaan
        const [state, challenge] = await Promise.all([
          contract.miningState(),
          contract.getChallenge(wallet.address),
        ]);

        const difficulty  = state.difficulty.toString();
        const epochNow    = state.epoch.toString();
        const uptimeMnt   = ((Date.now() - sessionStart) / 60000).toFixed(1);

        log("------------------------------------------");
        log(`Era        : ${state.era}`);
        log(`Reward     : ${ethers.formatUnits(state.reward, 18)} HASH`);
        log(`Difficulty : ${difficulty}`);
        log(`Epoch      : ${epochNow} | Remaining: ${state.remaining} blok`);
        log(`Challenge  : ${challenge}`);
        log(`Session    : ${totalMints} mints | uptime ${uptimeMnt} mnt`);
        log(`Mining dengan ${NUM_CORES} core...`);

        // ── MINE ─────────────────────────────────────────────────────────
        const { nonce, hash, elapsed, rate, attempts } = await mineRound(challenge, difficulty);
        totalAttempts += attempts;
        if (rate > peakHashrate) peakHashrate = rate;

        log(`Nonce      : ${nonce}`);
        log(`Hash       : ${hash}`);
        log(`Round      : ${elapsed}s | ${rate.toLocaleString()} H/s avg | peak ${peakHashrate.toLocaleString()} H/s`);

        // Cek epoch masih sama sebelum submit
        const fresh = await contract.miningState();
        if (fresh.epoch.toString() !== epochNow) {
          log("⚠ Epoch berubah saat mining — skip, ulang...");
          errors = 0;
          continue;
        }

        // ── SUBMIT TX ─────────────────────────────────────────────────────
        try {
          // Estimasi gas dulu — deteksi revert sebelum kirim
          let gas;
          try {
            gas = await contract.mine.estimateGas(BigInt(nonce));
          } catch (e) {
            log(`⚠ Gas estimasi gagal (epoch sudah dimine?): ${e.shortMessage || e.message}`);
            continue;
          }

          log("Mengirim TX...");
          const tx = await contract.mine(BigInt(nonce), { gasLimit: gas + 15000n });
          log(`TX hash    : ${tx.hash}`);

          const receipt = await tx.wait();

          if (receipt.status === 1) {
            totalMints++;
            log(`✓ BERHASIL! Block: ${receipt.blockNumber} | Total mints: ${totalMints} | Uptime: ${uptimeMnt} mnt`);
            log(`  Total hashes sesi: ${(totalAttempts / 1e9).toFixed(3)} GH`);
            log(`  Etherscan: https://etherscan.io/tx/${tx.hash}`);
          } else {
            log("✗ TX reverted.");
          }

        } catch (txErr) {
          log(`✗ TX gagal: ${txErr.shortMessage || txErr.message}`);
        }

        errors = 0; // reset error counter setelah round sukses

      } catch (err) {
        errors++;
        log(`ERROR #${errors}: ${err.shortMessage || err.message}`);

        // Exponential backoff: 3s → 6s → 12s → ... max 60s
        const wait = Math.min(3000 * Math.pow(2, errors - 1), 60_000);
        log(`Retry dalam ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  function shutdown(sig) {
    const uptimeMnt = ((Date.now() - sessionStart) / 60000).toFixed(1);
    log(`\nShutdown (${sig}). Mints: ${totalMints} | Uptime: ${uptimeMnt} mnt | Peak: ${peakHashrate.toLocaleString()} H/s`);
    process.exit(0);
  }
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  run().catch((err) => {
    log(`FATAL: ${err.shortMessage || err.message || err}`);
    process.exit(1);
  });
}
