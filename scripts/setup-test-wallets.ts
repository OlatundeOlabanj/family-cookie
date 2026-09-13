import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEVNET_USDC_MINT, WSOL_MINT, TEST_WALLETS_DIR } from "./constants";

const WALLET_NAMES = ["primary", "partner", "guardian", "fee-destination", "bank"] as const;

function loadOrCreateKeypair(name: string): Keypair {
  const dir = path.join(process.cwd(), TEST_WALLETS_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.json`);
  if (fs.existsSync(filePath)) {
    const secret = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

function main() {
  console.log("Setting up persistent test wallets (devnet)...\n");
  const wallets: Record<string, Keypair> = {};
  for (const name of WALLET_NAMES) wallets[name] = loadOrCreateKeypair(name);

  console.log("=".repeat(70));
  console.log("WALLET ADDRESSES");
  console.log("=".repeat(70));
  for (const name of WALLET_NAMES) {
    console.log(`${name.padEnd(18)} ${wallets[name].publicKey.toBase58()}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 1: Fund each wallet with devnet SOL (for rent + tx fees)");
  console.log("=".repeat(70));
  for (const name of WALLET_NAMES) {
    console.log(`solana transfer ${wallets[name].publicKey.toBase58()} 0.1 --allow-unfunded-recipient`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("STEP 2: Get devnet USDC");
  console.log("=".repeat(70));
  console.log("Devnet USDC mint:", DEVNET_USDC_MINT.toBase58());
  console.log("\nUse a devnet USDC faucet (e.g. https://faucet.circle.com, select Solana Devnet).");
  console.log(
    "\n`bank` is the one that matters here, it's the sole funding source\n" +
      "for the per-run wallet_authority top-ups in 02_recurring_contribution\n" +
      "and 04_passkey_flow (each `anchor test` run spends real USDC from it,\n" +
      "since vault/device setup is fresh per run, not idempotent). Fund it\n" +
      "generously (e.g. 50+ USDC) so it lasts many runs before needing a\n" +
      "top-up:\n"
  );
  console.log("  bank:   ", wallets.bank.publicKey.toBase58());
  console.log(
    "\n`primary` and `partner` no longer need real USDC balances; they're\n" +
      "only used as signers/placeholder-owned token accounts now, not as the\n" +
      "actual source of funds for any transfer. A little is harmless if you\n" +
      "already have it from before, but don't bother topping them up.\n"
  );
  console.log("  primary:", wallets.primary.publicKey.toBase58());
  console.log("  partner:", wallets.partner.publicKey.toBase58());

  console.log("\n" + "=".repeat(70));
  console.log("STEP 3: Associated token accounts (informational)");
  console.log("=".repeat(70));
  for (const name of ["primary", "partner", "bank"] as const) {
    const owner = wallets[name].publicKey;
    console.log(`${name} USDC ATA:  ${getAssociatedTokenAddressSync(DEVNET_USDC_MINT, owner).toBase58()}`);
    console.log(`${name} wSOL ATA:  ${getAssociatedTokenAddressSync(WSOL_MINT, owner).toBase58()}`);
  }
  const feeOwner = wallets["fee-destination"].publicKey;
  console.log(`fee-destination USDC ATA: ${getAssociatedTokenAddressSync(DEVNET_USDC_MINT, feeOwner).toBase58()}`);
  console.log(`fee-destination wSOL ATA: ${getAssociatedTokenAddressSync(WSOL_MINT, feeOwner).toBase58()}`);

  console.log("\n" + "=".repeat(70));
  console.log("Once funded, run: npm run check-funding");
  console.log("=".repeat(70));
}

main();
