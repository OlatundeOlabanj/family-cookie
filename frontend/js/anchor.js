// Program interaction layer: PDA derivation, instruction building via
// the bundled @coral-xyz/anchor Program/IDL, and the three flows the
// UI drives (create vault+goal, fund the wallet-authority holding
// account, contribute to a goal).
// Made by TJS Code

import { PROGRAM_ID } from "./config.js";
import {
  registerDevicePasskey,
  computeChallengeHash,
  getPasskeyAssertion,
  buildSecp256r1Instruction,
  buildSignedMessage,
  SECP256R1_PROGRAM_ID,
} from "./passkey.js";

const { web3, anchor, splToken } = window.FW_VENDOR;
const PROGRAM_PUBKEY = new web3.PublicKey(PROGRAM_ID);

// A placeholder, deliberately-unusable partner device slot. This build
// only registers one real passkey (device_role 0, primary). Nobody can
// ever authorize device_role 1 with this, since no matching private
// key exists - inviting a real partner device is a future feature,
// not wired into this UI. Same pattern the deleted test scripts used.
const PLACEHOLDER_PARTNER_DEVICE = new Uint8Array([0x02, ...new Array(32).fill(1)]);

export function deriveFeeConfigPda() {
  return web3.PublicKey.findProgramAddressSync([Buffer.from("fee_config")], PROGRAM_PUBKEY)[0];
}

export function deriveVaultPda(vaultSeed) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultSeed.toBytes()],
    PROGRAM_PUBKEY
  )[0];
}

export function deriveGoalPda(vaultPda, goalSeq) {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32LE(goalSeq, 0); // goal_seq is u32 in state.rs
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("goal"), vaultPda.toBytes(), seqBuf],
    PROGRAM_PUBKEY
  )[0];
}

export function deriveWalletAuthorityPda(vaultPda, deviceRole) {
  return web3.PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), vaultPda.toBytes(), Buffer.from([deviceRole])],
    PROGRAM_PUBKEY
  )[0];
}

function getProgram(connection, walletHandle) {
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: walletHandle.publicKey },
    { commitment: "confirmed" }
  );
  return new anchor.Program(window.FW_IDL, provider);
}

async function signAndSend(walletHandle, connection, instructions, extraSigners = []) {
  const tx = new web3.Transaction();
  tx.add(...instructions);
  tx.feePayer = walletHandle.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  if (extraSigners.length) tx.partialSign(...extraSigners);
  const signature = await walletHandle.signAndSendTransaction(tx, connection);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight }, "confirmed");
  return signature;
}

// --- Flow 1: create a vault (with one registered passkey device) and a first savings goal ---

export async function createVaultAndGoal({
  connection,
  walletHandle,
  goalMint,
  goalMintDecimals,
  goalName,
  targetAmountUi,
  deadlineUnixSeconds,
  rpId,
}) {
  const program = getProgram(connection, walletHandle);

  const device = await registerDevicePasskey({
    rpId,
    rpName: "Family Cookie",
    userDisplayName: walletHandle.publicKey.toBase58().slice(0, 8),
  });

  const vaultSeedKeypair = web3.Keypair.generate(); // used only for its pubkey, per state.rs's documented pattern
  const vaultSeed = vaultSeedKeypair.publicKey;
  const vaultPda = deriveVaultPda(vaultSeed);

  const mintPubkey = new web3.PublicKey(goalMint);
  // Stand-in fee destination: this deployment has no dedicated TJS Code
  // fee wallet set up yet, so fees route to the connected wallet's own
  // token account for now. Swap for a real fee wallet before going
  // beyond a demo.
  const feeDestination = splToken.getAssociatedTokenAddressSync(mintPubkey, walletHandle.publicKey);

  const initVaultIx = await program.methods
    .initFamilyVault(vaultSeed, Array.from(new Uint8Array(device.compressedPubkey)), Array.from(PLACEHOLDER_PARTNER_DEVICE), walletHandle.publicKey, { standard: {} }, feeDestination)
    .accounts({
      backendAuthority: walletHandle.publicKey,
      vault: vaultPda,
      systemProgram: web3.SystemProgram.programId,
    })
    .instruction();

  const goalPda = deriveGoalPda(vaultPda, 0);
  const goalTokenAccount = splToken.getAssociatedTokenAddressSync(mintPubkey, goalPda, true);

  const targetAmountRaw = new anchor.BN(Math.round(targetAmountUi * 10 ** goalMintDecimals));
  const initGoalIx = await program.methods
    .initSavingsGoal(goalName, targetAmountRaw, { usdc: {} }, new anchor.BN(deadlineUnixSeconds))
    .accounts({
      backendAuthority: walletHandle.publicKey,
      vault: vaultPda,
      goal: goalPda,
      goalTokenAccount,
      mint: mintPubkey,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
      associatedTokenProgram: splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    })
    .instruction();

  const signature = await signAndSend(walletHandle, connection, [initVaultIx, initGoalIx]);

  return {
    signature,
    vaultPda,
    goalPda,
    goalTokenAccount,
    credentialId: device.credentialId,
    devicePubkey: device.compressedPubkey,
  };
}

// --- Flow 2: top up the wallet-authority holding account -----------------

// contribute() moves funds out of a PDA-owned holding account, not
// straight from the user's personal wallet (see the doc comment on
// Contribute in contribute.rs). This tops that holding account up
// first, in a plain wallet-signed transfer - no passkey needed here.
export async function fundWalletAuthority({
  connection,
  walletHandle,
  vaultPda,
  goalMint,
  amountUi,
  decimals,
  deviceRole = 0,
}) {
  const mintPubkey = new web3.PublicKey(goalMint);
  const walletAuthorityPda = deriveWalletAuthorityPda(vaultPda, deviceRole);
  const sourceAta = splToken.getAssociatedTokenAddressSync(mintPubkey, walletHandle.publicKey);
  const destAta = splToken.getAssociatedTokenAddressSync(mintPubkey, walletAuthorityPda, true);

  const instructions = [];
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) {
    instructions.push(
      splToken.createAssociatedTokenAccountInstruction(
        walletHandle.publicKey,
        destAta,
        walletAuthorityPda,
        mintPubkey
      )
    );
  }

  const amountRaw = BigInt(Math.round(amountUi * 10 ** decimals));
  instructions.push(
    splToken.createTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destAta,
      walletHandle.publicKey,
      amountRaw,
      decimals
    )
  );

  const signature = await signAndSend(walletHandle, connection, instructions);
  return { signature, walletAuthorityPda, contributorTokenAccount: destAta };
}

// --- Flow 3: contribute to a goal, passkey-authorized -----------------

const CONTRIBUTE_BUSINESS_DATA_LEN = 10; // device_role:u8(1) + amount:u64(8) + decimals:u8(1)

export async function contributeToGoal({
  connection,
  walletHandle,
  vaultPda,
  goalPda,
  goalTokenAccount,
  goalMint,
  amountUi,
  decimals,
  credentialId,
  rpId,
  deviceRole = 0,
}) {
  const program = getProgram(connection, walletHandle);
  const mintPubkey = new web3.PublicKey(goalMint);
  const feeConfigPda = deriveFeeConfigPda();
  const walletAuthorityPda = deriveWalletAuthorityPda(vaultPda, deviceRole);
  const contributorTokenAccount = splToken.getAssociatedTokenAddressSync(mintPubkey, walletAuthorityPda, true);

  const vaultAccount = await program.account.familyVault.fetch(vaultPda);
  const feeDestination = vaultAccount.feeDestination;

  const amountRaw = new anchor.BN(Math.round(amountUi * 10 ** decimals));

  // Placeholder proof bytes just to get a correctly account-resolved
  // instruction for hashing - the first 18 bytes (8 discriminator + 10
  // business-arg bytes) are identical to the final instruction, which
  // is all hash_authorized_action ever reads for this instruction.
  const placeholderContributeIx = await program.methods
    .contribute(deviceRole, amountRaw, decimals, Buffer.from([]), Buffer.from([]))
    .accounts({
      payer: walletHandle.publicKey,
      instructionsSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      feeConfig: feeConfigPda,
      vault: vaultPda,
      goal: goalPda,
      goalTokenAccount,
      feeDestination,
      contributorTokenAccount,
      walletAuthority: walletAuthorityPda,
      mint: mintPubkey,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
    })
    .instruction();

  // Final instruction order is fixed BEFORE hashing: the precompile
  // slot must physically exist first, since hash_authorized_action's
  // instruction index counting includes it even though its content is
  // skipped: [precompileIx, contributeIx].
  const dummyPrecompileIx = new web3.TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data: Buffer.alloc(0),
  });

  const unsignedTx = new web3.Transaction();
  unsignedTx.feePayer = walletHandle.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  unsignedTx.recentBlockhash = blockhash;
  unsignedTx.add(dummyPrecompileIx, placeholderContributeIx);

  const contributeIndex = 1; // [precompile(0), contribute(1)]
  const challengeHash = await computeChallengeHash(unsignedTx, contributeIndex, CONTRIBUTE_BUSINESS_DATA_LEN);

  const assertion = await getPasskeyAssertion({ rpId, credentialId, challengeHash });
  const signedMessage = await buildSignedMessage(assertion.authenticatorData, assertion.clientDataJSON);

  const vaultDevicePubkey =
    deviceRole === 0 ? vaultAccount.primaryContributorDevice : vaultAccount.partnerDevice;
  const precompileIx = buildSecp256r1Instruction({
    compressedPubkey: new Uint8Array(vaultDevicePubkey),
    signatureRaw: assertion.signatureRaw,
    message: signedMessage,
  });

  const finalContributeIx = await program.methods
    .contribute(deviceRole, amountRaw, decimals, Buffer.from(assertion.authenticatorData), Buffer.from(assertion.clientDataJSON))
    .accounts({
      payer: walletHandle.publicKey,
      instructionsSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      feeConfig: feeConfigPda,
      vault: vaultPda,
      goal: goalPda,
      goalTokenAccount,
      feeDestination,
      contributorTokenAccount,
      walletAuthority: walletAuthorityPda,
      mint: mintPubkey,
      tokenProgram: splToken.TOKEN_PROGRAM_ID,
    })
    .instruction();

  const signature = await signAndSend(walletHandle, connection, [precompileIx, finalContributeIx]);
  return { signature };
}

// --- Reads -----------------------------------------------------------

export async function fetchGoalBalance(connection, goalTokenAccount) {
  const balance = await connection.getTokenAccountBalance(goalTokenAccount, "confirmed");
  return balance.value;
}

export async function fetchGoal(connection, walletHandle, goalPda) {
  const program = getProgram(connection, walletHandle);
  return await program.account.savingsGoal.fetch(goalPda);
}

// --- Error decoding ----------------------------------------------------

const REJECTION_PATTERNS = ["reject", "cancel", "denied", "declined", "closed the popup"];

export function describeTransactionError(err) {
  const rawMessage = (err && err.message) || String(err);
  if (REJECTION_PATTERNS.some((p) => rawMessage.toLowerCase().includes(p))) {
    return { kind: "rejected", message: "The wallet request was declined. Nothing was sent." };
  }

  try {
    const logs = err.logs || (err.getLogs && err.getLogs()) || null;
    if (logs) {
      const parsed = anchor.AnchorError.parse(logs);
      if (parsed) {
        return { kind: "program", message: parsed.error.errorMessage || rawMessage };
      }
    }
  } catch (_) {
    // fall through to generic handling below
  }

  if (rawMessage.toLowerCase().includes("insufficient")) {
    return { kind: "funds", message: "Not enough balance to cover this transaction." };
  }

  return { kind: "unknown", message: `Transaction failed: ${rawMessage}` };
}
