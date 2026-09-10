// Reports exactly how much more devnet USDC primary.json's ATA needs
// before `anchor test` can run clean, based on what the test suite
// actually transfers out of it - not a guessed round number.
//
// IMPORTANT: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU is Circle's
// public devnet USDC mint (see scripts/setup-test-wallets.ts). We do
// not hold its mint authority, so there is no "mint more" script to
// rerun - the only source is the faucet at https://faucet.circle.com
// (select Solana Devnet). This script tells you the exact amount to
// request there, instead of a guess.
//
// Coverage note: only 04_passkey_flow.test.ts currently spends primary's
// USDC (its `before` hook transfers 3 USDC from primary's ATA into the
// vault's wallet-authority holding account; everything after that moves
// funds between the holding account and the goal, not primary's ATA
// again). 01_setup_and_contribute.test.ts and 02_recurring_contribution
// .test.ts are still on the old calling convention and are being
// rewritten separately - this script will need a one-line update to
// their contribution once that lands, so their real spend doesn't get
// silently missed here.
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { DEVNET_USDC_MINT, TEST_WALLETS_DIR, USDC_DECIMALS } from "./constants";

// Exact amounts each test file's `before` hook transfers out of
// primary's own ATA in a single `anchor test` run. Update this list
// alongside any test file that starts moving primary's USDC.
const KNOWN_SPEND_USDC: { file: string; amount: number }[] = [
  { file: "tests/04_passkey_flow.test.ts", amount: 3 },
];

function loadKeypair(name: string): Keypair {
  const filePath = path.join(process.cwd(), TEST_WALLETS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`${name}.json not found - run: npm run setup-wallets`);
  const secret = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const primary = loadKeypair("primary");
  const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, primary.publicKey);

  const requiredUsdc = KNOWN_SPEND_USDC.reduce((sum, row) => sum + row.amount, 0);

  let currentUsdc = 0;
  try {
    const account = await getAccount(connection, ata);
    currentUsdc = Number(account.amount) / 10 ** USDC_DECIMALS;
  } catch {
    currentUsdc = 0; // ATA doesn't exist yet - treat as zero balance
  }

  console.log("primary.json address:", primary.publicKey.toBase58());
  console.log("primary USDC ATA:    ", ata.toBase58());
  console.log();
  console.log("Known per-run spend:");
  for (const row of KNOWN_SPEND_USDC) console.log(`  ${row.amount.toFixed(2).padStart(8)} USDC  ${row.file}`);
  console.log(`  ${requiredUsdc.toFixed(2).padStart(8)} USDC  total required for one full run`);
  console.log();
  console.log(`Current balance:      ${currentUsdc.toFixed(2)} USDC`);

  const shortfall = requiredUsdc - currentUsdc;
  if (shortfall <= 0) {
    console.log("\nSufficient for one full run. No faucet request needed.");
    return;
  }

  console.log(`\nShortfall:            ${shortfall.toFixed(2)} USDC`);
  console.log("\nRequest at least that much devnet USDC from:");
  console.log("  https://faucet.circle.com  (select Solana Devnet)");
  console.log(`  to: ${primary.publicKey.toBase58()}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
