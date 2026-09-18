/**
 * Diagnostic #2: same init_family_vault call as
 * scripts/test-cookiechain-direct.ts, but built the way a wallet adapter
 * (Nightly included) typically builds and sends a transaction, instead of
 * the way AnchorProvider.rpc() does it under the hood. Still no browser,
 * no extension — this is Node/Anchor only.
 *
 * Concretely, this script:
 *   1. Builds the init_family_vault instruction (same args/accounts as the
 *      direct script) via the real Anchor program.
 *   2. Fetches a fresh blockhash EXPLICITLY, at a chosen commitment level
 *      (wallets often use a different default commitment than
 *      AnchorProvider does internally).
 *   3. Assembles it as a v0 VersionedTransaction (the format most modern
 *      wallet adapters, Nightly included, build and ask you to sign) rather
 *      than a legacy Transaction.
 *   4. Simulates it against the RPC BEFORE sending — most wallets simulate
 *      client-side before ever prompting the user to approve, and that
 *      simulation step is a common place for chain-specific RPC quirks to
 *      surface that a raw .rpc() send does not hit.
 *   5. Only if simulation succeeds, sends + confirms the raw transaction.
 *
 * Nothing here is swallowed or summarized: simulation output and any send
 * error are printed as complete raw objects, same as the direct script.
 *
 * Run:
 *   npm run test:cookiechain-walletlike
 *
 * Compare its output against test-cookiechain-direct.ts's output. If this
 * one also succeeds, the difference lives somewhere Nightly-specific that
 * neither script reaches (its own RPC config, its own commitment/blockhash
 * caching, or something in its signing flow). If THIS one fails while the
 * direct script succeeds, you've isolated it: something about
 * versioned-tx + simulate-before-send + explicit-blockhash is what Cookie
 * Chain's RPC handles differently — which is the exact, specific claim to
 * bring to Nightly support or the Cookie Chain Telegram.
 */

import * as os from "os";
import * as path from "path";

process.env.ANCHOR_PROVIDER_URL = "https://rpc.cookiescan.io";
process.env.ANCHOR_WALLET = path.join(
  os.homedir(),
  ".config",
  "solana",
  "cookiechain-deployer.json"
);

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getProgram, generateDeviceKeypair } from "../tests/helpers";

const EXPECTED_PROGRAM_ID = "6tyoXrDQiqs6PCfc94sP1vV5v4h81DsWXaU5uCpwke9w";

// Commitment level to fetch the blockhash at. Try "confirmed" first; if you
// want to test whether commitment level itself is the variable, change this
// to "processed" or "finalized" and re-run.
const BLOCKHASH_COMMITMENT: anchor.web3.Commitment = "confirmed";

async function main() {
  const { program, provider } = getProgram();
  const connection = provider.connection;

  if (program.programId.toBase58() !== EXPECTED_PROGRAM_ID) {
    throw new Error(
      `IDL program ID mismatch: expected ${EXPECTED_PROGRAM_ID}, got ${program.programId.toBase58()}`
    );
  }

  const backendAuthority = (provider.wallet as anchor.Wallet).payer;

  console.log("RPC endpoint:        ", (connection as any)._rpcEndpoint);
  console.log("Program ID:          ", program.programId.toBase58());
  console.log("Signer (deployer):   ", backendAuthority.publicKey.toBase58());
  console.log("Blockhash commitment:", BLOCKHASH_COMMITMENT);

  const vaultSeedKp = Keypair.generate();
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultSeedKp.publicKey.toBuffer()],
    program.programId
  );

  const device = generateDeviceKeypair();
  const partnerDevicePubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]);
  const guardian = Keypair.generate().publicKey;
  const feeDestination = Keypair.generate().publicKey;

  console.log("Vault seed:          ", vaultSeedKp.publicKey.toBase58());
  console.log("Vault PDA:           ", vaultPda.toBase58());

  // --- 1. Build the instruction (no .rpc(), just .instruction()) ---
  const ix = await program.methods
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
    .instruction();

  try {
    // --- 2. Explicit blockhash fetch, wallet-adapter style ---
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      BLOCKHASH_COMMITMENT
    );
    console.log("Blockhash:           ", blockhash);
    console.log("Last valid height:   ", lastValidBlockHeight);

    // --- 3. Assemble as a v0 VersionedTransaction ---
    const messageV0 = new TransactionMessage({
      payerKey: backendAuthority.publicKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([backendAuthority]);

    // --- 4. Simulate BEFORE sending, exactly like a wallet would before
    // prompting the user to approve ---
    console.log("\n=== SIMULATION (raw result) ===");
    const simResult = await connection.simulateTransaction(versionedTx, {
      sigVerify: true,
      commitment: BLOCKHASH_COMMITMENT,
    });
    console.dir(simResult, { depth: null, maxArrayLength: null });

    if (simResult.value.err) {
      console.log("\n=== SIMULATION FAILED — not sending ===");
      process.exitCode = 1;
      return;
    }

    // --- 5. Send + confirm the raw transaction ---
    const sig = await connection.sendRawTransaction(versionedTx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      BLOCKHASH_COMMITMENT
    );

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
