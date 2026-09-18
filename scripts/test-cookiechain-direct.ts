/**
 * Pure diagnostic: call init_family_vault directly against Cookie Chain,
 * with no browser, no wallet extension, no frontend in the loop at all.
 *
 * Reuses the exact same Anchor program setup already proven working in
 * tests/04_passkey_flow.test.ts (same IDL, same PROGRAM_ID, same
 * getProgram()/generateDeviceKeypair() helpers) — only the RPC endpoint
 * and the signing keypair change, via ANCHOR_PROVIDER_URL / ANCHOR_WALLET.
 *
 * Run:
 *   npm run test:cookiechain-direct
 */

import * as os from "os";
import * as path from "path";

// Anchor's Program/Provider setup below is identical to tests/helpers.ts's
// getProgram(), which uses AnchorProvider.env(). Point that at Cookie Chain
// and the deployer key BEFORE importing/calling it, so nothing else about
// the proven setup has to change.
process.env.ANCHOR_PROVIDER_URL = "https://rpc.cookiescan.io";
process.env.ANCHOR_WALLET = path.join(
  os.homedir(),
  ".config",
  "solana",
  "cookiechain-deployer.json"
);

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getProgram, generateDeviceKeypair, PROGRAM_ID } from "../tests/helpers";

const EXPECTED_PROGRAM_ID = "6tyoXrDQiqs6PCfc94sP1vV5v4h81DsWXaU5uCpwke9w";

async function main() {
  const { program, provider } = getProgram();

  if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
    throw new Error(
      `IDL program ID mismatch: expected ${EXPECTED_PROGRAM_ID}, got ${program.programId.toBase58()}`
    );
  }

  const backendAuthority = (provider.wallet as anchor.Wallet).payer;

  console.log("RPC endpoint:      ", (provider.connection as any)._rpcEndpoint);
  console.log("Program ID:        ", program.programId.toBase58());
  console.log("Signer (deployer): ", backendAuthority.publicKey.toBase58());

  // Fresh, random vault seed every run, exactly like the devnet test.
  const vaultSeedKp = Keypair.generate();
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultSeedKp.publicKey.toBuffer()],
    program.programId
  );

  // Same minimal-valid-args shape the devnet test already uses successfully:
  // a real P-256 device key for the primary device, and the same
  // proven-working placeholder bytes for the partner device slot.
  const device = generateDeviceKeypair();
  const partnerDevicePubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]);
  const guardian = Keypair.generate().publicKey;
  const feeDestination = Keypair.generate().publicKey; // stored as bytes only, not read as an account here

  console.log("Vault seed:        ", vaultSeedKp.publicKey.toBase58());
  console.log("Vault PDA:         ", vaultPda.toBase58());

  try {
    const sig = await program.methods
      .initFamilyVault(
        vaultSeedKp.publicKey,
        Array.from(device.compressedPubkey),
        Array.from(partnerDevicePubkey),
        guardian,
        { standard: {} },
        feeDestination
      )
      .accounts({
        backendAuthority: backendAuthority.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log("\n=== SUCCESS ===");
    console.log("Transaction signature:", sig);
  } catch (err) {
    console.log("\n=== FAILURE (raw error object) ===");
    console.dir(err, { depth: null, maxArrayLength: null });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.log("\n=== FATAL (setup error, before any RPC call) ===");
  console.dir(err, { depth: null, maxArrayLength: null });
  process.exitCode = 1;
});
