require("dotenv").config();

const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os   = require("os");
const fs   = require("fs");
const path = require("path");

const RPC_URL          = process.env.RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const NUM_CORES        = parseInt(process.env.CORES) || os.cpus().length;
const REPORT_EVERY     = parseInt(process.env.REPORT_EVERY) || 1_000_000;
const LOG_FILE         = path.join(__dirname, "miner.log");

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

  // Alokasi buffer SEKALI — zero GC pressure dalam loop
  const challengeBuf = Buffer.from(challenge.slice(2), "hex");
  const packed       = Buffer.allocUnsafe(64);
  const nonceBuf     = Buffer.allocUnsafe(32);
  challengeBuf.copy(packed, 0);

  const diffBuf = Buffer.from(
    BigInt(difficulty).toString(16).padStart(64, "0"), "hex"
  );

  let nonce    = BigInt(startNonce);
  let attempts = 0;

  function writeBE(buf, val) {
    let v = val;
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }

  function bufLT(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  }

  // Coba keccak native — tapi reuse instance via copy trick (anti-OOM)
  let hashFn = null;
  try {
    // Pakai js-sha3 — pure JS tapi cepat dan tidak OOM
    const { keccak256 } = require("js-sha3");
    // Hasilnya hex string, convert ke Buffer
    hashFn = (buf) => Buffer.from(keccak256.arrayBuffer(buf));
    hashFn(Buffer.alloc(1)); // test
  } catch (_) {
    hashFn = null;
  }

  if (!hashFn) {
    try {
      // Fallback: keccak npm — pakai arraybuffer untuk avoid string alloc
      const Keccak = require("keccak");
      // Buat factory function — create fresh per hash tapi lightweight
      hashFn = (buf) => Keccak("keccak256").update(buf).digest();
      hashFn(Buffer.alloc(1));
    } catch (_) {
      hashFn = null;
    }
  }

  if (hashFn) {
    // PATH CEPAT: native/js-sha3
    while (true) {
      writeBE(nonceBuf, nonce);
      nonceBuf.copy(packed, 32);
      const hash = hashFn(packed);
      attempts++;
      if (bufLT(hash, diffBuf)) {
        parentPort.postMessage({ type: "found", nonce: nonce.toString(), hash: "0x" + hash.toString("hex"), workerId });
        break;
      }
      nonce++;
      if (attempts % REPORT_EVERY === 0) parentPort.postMessage({ type: "progress", attempts, workerId });
    }
  } else {
    // PATH FALLBACK: ethers
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
      if (attempts % REPORT_EVERY === 0) parentPort.postMessage({ type: "progress", attempts, workerId });
    }
  }

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN THREAD
// ═══════════════════════════════════════════════════════════════════════════════
} else {

  const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logStream.write(line + "\n");
  }

  function checkEnv() {
    if (!RPC_URL || !PRIVATE_KEY) { console.error("ERROR: Set RPC_URL dan PRIVATE_KEY di .env"); process.exit(1); }
    if (!PRIVATE_KEY.startsWith("0x")) { console.error("ERROR: PRIVATE_KEY harus diawali 0x"); process.exit(1); }
  }

  function workerStartNonce(id, total) {
    const MAX    = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
    const slice  = MAX / BigInt(total);
    const base   = slice * BigInt(id);
    const jitter = BigInt(Math.floor(Math.random() * 999_999));
    return (base + jitter).toString();
  }

  function killAll(workers) {
    for (const w of workers) { try { w.terminate(); } catch (_) {} }
  }

  function mineRound(challenge, difficulty) {
    return new Promise((resolve, reject) => {
      const workers        = [];
      const workerAttempts = new Array(NUM_CORES).fill(0);
      let found            = false;
      let totalAttempts    = 0;
      let peakRate         = 0;
      const t0             = Date.now();

      const ticker = setInterval(() => {
        const secs = (Date.now() - t0) / 1000;
        const rate = Math.floor(totalAttempts / secs);
        if (rate > peakRate) peakRate = rate;
        process.stdout.write(
          `\r  \x1b[32m${rate.toLocaleString()}\x1b[0m H/s` +
          ` | ${(totalAttempts / 1e6).toFixed(1)}M hashes` +
          ` | peak ${peakRate.toLocaleString()} H/s` +
          ` | ${NUM_CORES} cores | ${secs.toFixed(0)}s   `
        );
      }, 1000);

      for (let i = 0; i < NUM_CORES; i++) {
        const w = new Worker(__filename, {
          workerData: { challenge, difficulty, startNonce: workerStartNonce(i, NUM_CORES), workerId: i }
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
            const secs = (Date.now() - t0) / 1000;
            const rate = Math.floor(totalAttempts / secs);
            process.stdout.write("\n");
            resolve({ nonce: msg.nonce, hash: msg.hash, secs: secs.toFixed(1), rate, totalAttempts });
          }
        });
        w.on("error", (err) => {
          if (!found) { found = true; clearInterval(ticker); killAll(workers); reject(err); }
        });
        workers.push(w);
      }
    });
  }

  let totalMints   = 0;
  let totalHashes  = 0;
  let peakHashrate = 0;
  const t0session  = Date.now();

  async function main() {
    checkEnv();

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    // Deteksi hash mode
    let hashMode = "ethers fallback";
    try { require("js-sha3"); hashMode = "js-sha3 (fast pure JS)"; } catch (_) {}
    try { require("keccak"); hashMode = "keccak native C"; } catch (_) {}

    log("==========================================");
    log("  HASH256 Multi-Core CPU Miner");
    log("==========================================");
    log(`Wallet      : ${wallet.address}`);
    log(`Contract    : ${CONTRACT_ADDRESS}`);
    log(`CPU Cores   : ${NUM_CORES}`);
    log(`Hash mode   : ${hashMode}`);
    log(`REPORT_EVERY: ${REPORT_EVERY.toLocaleString()}`);
    log(`Log file    : ${LOG_FILE}`);
    log("");

    let errors = 0;

    while (true) {
      try {
        const [state, challenge] = await Promise.all([
          contract.miningState(),
          contract.getChallenge(wallet.address),
        ]);

        const difficulty = state.difficulty.toString();
        const epochNow   = state.epoch.toString();
        const uptime     = ((Date.now() - t0session) / 60000).toFixed(1);

        log("------------------------------------------");
        log(`Era        : ${state.era}`);
        log(`Reward     : ${ethers.formatUnits(state.reward, 18)} HASH`);
        log(`Difficulty : ${difficulty}`);
        log(`Epoch      : ${epochNow} | Remaining: ${state.remaining} blok`);
        log(`Challenge  : ${challenge}`);
        log(`Session    : ${totalMints} mints | ${(totalHashes/1e9).toFixed(2)} GH | uptime ${uptime} mnt`);
        log(`Mining dengan ${NUM_CORES} core...`);

        const { nonce, hash, secs, rate, totalAttempts } = await mineRound(challenge, difficulty);
        totalHashes += totalAttempts;
        if (rate > peakHashrate) peakHashrate = rate;

        log(`Nonce      : ${nonce}`);
        log(`Hash       : ${hash}`);
        log(`Round      : ${secs}s | avg ${rate.toLocaleString()} H/s | peak ${peakHashrate.toLocaleString()} H/s`);

        const fresh = await contract.miningState();
        if (fresh.epoch.toString() !== epochNow) {
          log("⚠ Epoch berubah — skip, ulang ronde...");
          errors = 0;
          continue;
        }

        try {
          let gas;
          try {
            gas = await contract.mine.estimateGas(BigInt(nonce));
          } catch (e) {
            log(`⚠ Gas estimate gagal: ${e.shortMessage || e.message}`);
            continue;
          }
          log("Mengirim TX...");
          const tx = await contract.mine(BigInt(nonce), { gasLimit: gas + 15000n });
          log(`TX         : ${tx.hash}`);
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            totalMints++;
            log(`✓ MINT #${totalMints} | Block: ${receipt.blockNumber} | Uptime: ${uptime} mnt`);
            log(`  Total hashes: ${(totalHashes/1e9).toFixed(2)} GH | Peak: ${peakHashrate.toLocaleString()} H/s`);
            log(`  https://etherscan.io/tx/${tx.hash}`);
          } else {
            log("✗ TX reverted");
          }
        } catch (txErr) {
          log(`✗ TX error: ${txErr.shortMessage || txErr.message}`);
        }

        errors = 0;

      } catch (err) {
        errors++;
        log(`ERROR #${errors}: ${err.shortMessage || err.message}`);
        const wait = Math.min(3000 * Math.pow(2, errors - 1), 60_000);
        log(`Retry dalam ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  process.on("SIGINT",  () => { log(`\nStop. Mints: ${totalMints} | Peak: ${peakHashrate.toLocaleString()} H/s`); process.exit(0); });
  process.on("SIGTERM", () => { log(`\nStop. Mints: ${totalMints} | Peak: ${peakHashrate.toLocaleString()} H/s`); process.exit(0); });
  main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
}
