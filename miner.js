require("dotenv").config();
const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const NUM_CORES = parseInt(process.env.CORES) || os.cpus().length;

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

if (!isMainThread) {
  const { solidityPackedKeccak256 } = require("ethers");
  const { challenge, difficulty, startNonce, workerId } = workerData;
  const diffBigInt = BigInt(difficulty);
  let nonce = BigInt(startNonce);
  let attempts = 0;
  const REPORT_EVERY = 100_000;
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
} else {
  function requireEnv() {
    if (!RPC_URL || !PRIVATE_KEY) {
      console.error("Isi RPC_URL dan PRIVATE_KEY di file .env dulu.");
      process.exit(1);
    }
    if (!PRIVATE_KEY.startsWith("0x")) {
      console.error("PRIVATE_KEY harus diawali 0x.");
      process.exit(1);
    }
  }

  function randomStartNonce(workerId, totalWorkers) {
    const RANGE = BigInt("18446744073709551615");
    const slice = RANGE / BigInt(totalWorkers);
    const base = slice * BigInt(workerId);
    const jitter = BigInt(Math.floor(Math.random() * 1_000_000));
    return (base + jitter).toString();
  }

  function killWorkers(workers) {
    for (const w of workers) { try { w.terminate(); } catch (_) {} }
  }

  function mineWithWorkers(challenge, difficulty) {
    return new Promise((resolve, reject) => {
      const workers = [];
      let found = false;
      let totalAttempts = 0;
      const workerAttempts = new Array(NUM_CORES).fill(0);
      const t0 = Date.now();

      const ticker = setInterval(() => {
        const secs = (Date.now() - t0) / 1000;
        const rate = Math.floor(totalAttempts / secs).toLocaleString();
        process.stdout.write(`\r  ${rate} H/s | ${totalAttempts.toLocaleString()} hashes | ${NUM_CORES} cores   `);
      }, 1000);

      for (let i = 0; i < NUM_CORES; i++) {
        const w = new Worker(__filename, {
          workerData: { challenge, difficulty, startNonce: randomStartNonce(i, NUM_CORES), workerId: i }
        });
        w.on("message", (msg) => {
          if (msg.type === "progress") {
            totalAttempts += msg.attempts - workerAttempts[msg.workerId];
            workerAttempts[msg.workerId] = msg.attempts;
          }
          if (msg.type === "found" && !found) {
            found = true;
            clearInterval(ticker);
            killWorkers(workers);
            const secs = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`\n\nFOUND! Core #${msg.workerId} | ${secs}s`);
            resolve({ nonce: msg.nonce, hash: msg.hash });
          }
        });
        w.on("error", (err) => {
          if (!found) { found = true; clearInterval(ticker); killWorkers(workers); reject(err); }
        });
        workers.push(w);
      }
    });
  }

  async function main() {
    requireEnv();
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    console.log("======================================");
    console.log("   HASH256 Multi-Core CPU Miner");
    console.log("======================================");
    console.log("Wallet   :", wallet.address);
    console.log("Contract :", CONTRACT_ADDRESS);
    console.log("CPU Cores:", NUM_CORES);
    console.log("");

    let totalMints = 0;
    const sessionStart = Date.now();

    while (true) {
      try {
        const [state, challenge] = await Promise.all([
          contract.miningState(),
          contract.getChallenge(wallet.address),
        ]);
        const difficulty = state.difficulty.toString();

        console.log("--------------------------------------");
        console.log("Era      :", state.era.toString());
        console.log("Reward   :", ethers.formatUnits(state.reward, 18), "HASH");
        console.log("Difficulty:", difficulty);
        console.log("Epoch    :", state.epoch.toString());
        console.log("Remaining:", state.remaining.toString(), "blok");
        console.log("Challenge:", challenge);
        console.log("Mining dengan", NUM_CORES, "core parallel...");

        const { nonce, hash } = await mineWithWorkers(challenge, difficulty);
        console.log("Nonce    :", nonce);
        console.log("Hash     :", hash);

        const newState = await contract.miningState();
        if (newState.epoch.toString() !== state.epoch.toString()) {
          console.log("Epoch berubah, skip - ulang mining...");
          continue;
        }

        try {
          console.log("Mengirim transaksi...");
          const tx = await contract.mine(BigInt(nonce));
          console.log("TX hash  :", tx.hash);
          console.log("Menunggu konfirmasi...");
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            totalMints++;
            const uptime = ((Date.now() - sessionStart) / 60000).toFixed(1);
            console.log("Berhasil! Block:", receipt.blockNumber, "| Mints:", totalMints, "| Uptime:", uptime, "mnt");
            console.log("Etherscan: https://etherscan.io/tx/" + tx.hash);
          } else {
            console.log("TX reverted");
          }
        } catch (err) {
          console.error("TX gagal:", err.shortMessage || err.message);
        }

      } catch (err) {
        console.error("\nError:", err.shortMessage || err.message);
        console.log("Retry dalam 5 detik...");
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  process.on("SIGINT", () => { console.log("\nMiner dihentikan."); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\nMiner dihentikan."); process.exit(0); });
  main().catch((err) => { console.error(err.shortMessage || err.message || err); process.exit(1); });
}
