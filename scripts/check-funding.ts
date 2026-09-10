import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { DEVNET_USDC_MINT, TEST_WALLETS_DIR, USDC_DECIMALS } from "./constants";

const WALLET_NAMES = ["primary", "partner", "guardian", "fee-destination"] as const;
const MIN_SOL = 0.05;

function loadKeypair(name: string): Keypair {
  const filePath = path.join(process.cwd(), TEST_WALLETS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`${name}.json not found — run: npm run setup-wallets`);
  const secret = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  let allGood = true;
  console.log("Checking test wallet funding on devnet...\n");

  for (const name of WALLET_NAMES) {
    const kp = loadKeypair(name);
    const solBalance = await connection.getBalance(kp.publicKey);
    const solOk = solBalance / LAMPORTS_PER_SOL >= MIN_SOL;
    if (!solOk) allGood = false;
    console.log(`${name.padEnd(18)} SOL: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4).padStart(10)} ${solOk ? "OK" : `NEEDS >= ${MIN_SOL}`}`);

    if (name === "primary" || name === "partner") {
      const usdcAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, kp.publicKey);
      try {
        const account = await getAccount(connection, usdcAta);
        const amount = Number(account.amount) / 10 ** USDC_DECIMALS;
        console.log(`${"".padEnd(18)} USDC: ${amount.toFixed(2).padStart(9)} OK`);
      } catch {
        console.log(`${"".padEnd(18)} USDC: ATA not found — needs faucet funding`);
        allGood = false;
      }
    }
  }

  console.log();
  if (allGood) {
    console.log("All wallets funded. Ready to run: npm test");
  } else {
    console.log("Some wallets still need funding.");
    process.exit(1);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
