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
const { Buffer } = window;
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
  const isNativeWrap = mintPubkey.equals(splToken.NATIVE_MINT);
  const walletAuthorityPda = deriveWalletAuthorityPda(vaultPda, deviceRole);
  const sourceAta = splToken.getAssociatedTokenAddressSync(mintPubkey, walletHandle.publicKey);
  const destAta = splToken.getAssociatedTokenAddressSync(mintPubkey, walletAuthorityPda, true);

  const instructions = [];
  const amountRaw = BigInt(Math.round(amountUi * 10 ** decimals));

  // Wrapped-native mints (wSOL on Solana, wrapped-COOK on Cookie
  // Chain, same sentinel address either way) don't hold a real SPL
  // balance just because the wallet holds the native token - native
  // balance has to be wrapped first: create the ATA if it doesn't
  // exist, move real lamports into it, then syncNative so the SPL
  // Token program's tracked `amount` reflects those lamports. Without
  // this, the transfer below would move from an empty or nonexistent
  // account even though the wallet is genuinely funded.
  if (isNativeWrap) {
    const sourceInfo = await connection.getAccountInfo(sourceAta);
    if (!sourceInfo) {
      instructions.push(
        splToken.createAssociatedTokenAccountInstruction(walletHandle.publicKey, sourceAta, walletHandle.publicKey, mintPubkey)
      );
    }
    instructions.push(
      web3.SystemProgram.transfer({
        fromPubkey: walletHandle.publicKey,
        toPubkey: sourceAta,
        lamports: amountRaw,
      })
    );
    instructions.push(splToken.createSyncNativeInstruction(sourceAta));
  }

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

// Shared passkey-authorization pattern used by contribute,
// authorize_recurring_delegate, and cancel_recurring_delegate: build a
// placeholder instruction to compute the challenge hash, get a live
// WebAuthn assertion bound to it, build the real instruction with the
// real proof bytes, and send [precompile, action]. Factored out once
// three instructions needed the exact same shape, so a mistake in this
// security-critical sequence only has one place to happen.
async function passkeyAuthorizedCall({
  connection,
  walletHandle,
  credentialId,
  rpId,
  businessDataLen,
  buildInstruction, // (authenticatorData: Buffer, clientDataJson: Buffer) => Promise<TransactionInstruction>
  devicePubkeyBytes, // Uint8Array(33), the registered device pubkey this proof must verify against
}) {
  const placeholderIx = await buildInstruction(Buffer.from([]), Buffer.from([]));

  // Final instruction order is fixed BEFORE hashing: the precompile
  // slot must physically exist first, since hash_authorized_action's
  // instruction index counting includes it even though its content is
  // skipped.
  const dummyPrecompileIx = new web3.TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data: Buffer.alloc(0),
  });

  const unsignedTx = new web3.Transaction();
  unsignedTx.feePayer = walletHandle.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  unsignedTx.recentBlockhash = blockhash;
  unsignedTx.add(dummyPrecompileIx, placeholderIx);

  const actionIndex = 1; // [precompile(0), action(1)]
  const challengeHash = await computeChallengeHash(unsignedTx, actionIndex, businessDataLen);

  const assertion = await getPasskeyAssertion({ rpId, credentialId, challengeHash });
  const signedMessage = await buildSignedMessage(assertion.authenticatorData, assertion.clientDataJSON);

  const precompileIx = buildSecp256r1Instruction({
    compressedPubkey: devicePubkeyBytes,
    signatureRaw: assertion.signatureRaw,
    message: signedMessage,
  });

  const finalIx = await buildInstruction(Buffer.from(assertion.authenticatorData), Buffer.from(assertion.clientDataJSON));

  const signature = await signAndSend(walletHandle, connection, [precompileIx, finalIx]);
  return { signature };
}

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
  const devicePubkeyBytes =
    deviceRole === 0 ? new Uint8Array(vaultAccount.primaryContributorDevice) : new Uint8Array(vaultAccount.partnerDevice);

  const amountRaw = new anchor.BN(Math.round(amountUi * 10 ** decimals));

  const buildInstruction = (authenticatorData, clientDataJson) =>
    program.methods
      .contribute(deviceRole, amountRaw, decimals, authenticatorData, clientDataJson)
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

  return passkeyAuthorizedCall({
    connection,
    walletHandle,
    credentialId,
    rpId,
    businessDataLen: CONTRIBUTE_BUSINESS_DATA_LEN,
    buildInstruction,
    devicePubkeyBytes,
  });
}

// --- Recurring contributions -------------------------------------------

const AUTHORIZE_DELEGATE_BUSINESS_DATA_LEN = 18; // device_role(1) + amount_per_period(8) + frequency(1) + next_run_at(8)
const CANCEL_DELEGATE_BUSINESS_DATA_LEN = 1; // device_role(1)

export function deriveDelegatePda(goalPda) {
  return web3.PublicKey.findProgramAddressSync([Buffer.from("delegate"), goalPda.toBytes()], PROGRAM_PUBKEY)[0];
}

export async function fetchRecurringDelegate(connection, walletHandle, goalPda) {
  const program = getProgram(connection, walletHandle);
  const delegatePda = deriveDelegatePda(goalPda);
  try {
    const account = await program.account.recurringContributionDelegate.fetch(delegatePda);
    return { exists: true, delegatePda, account };
  } catch {
    return { exists: false, delegatePda, account: null };
  }
}

export async function authorizeRecurring({
  connection,
  walletHandle,
  vaultPda,
  goalPda,
  goalMint,
  amountUi,
  decimals,
  frequency, // "weekly" | "monthly"
  nextRunUnixSeconds,
  credentialId,
  rpId,
  deviceRole = 0,
}) {
  const program = getProgram(connection, walletHandle);
  const mintPubkey = new web3.PublicKey(goalMint);
  const walletAuthorityPda = deriveWalletAuthorityPda(vaultPda, deviceRole);
  const sourceTokenAccount = splToken.getAssociatedTokenAddressSync(mintPubkey, walletAuthorityPda, true);
  const delegatePda = deriveDelegatePda(goalPda);

  const vaultAccount = await program.account.familyVault.fetch(vaultPda);
  const devicePubkeyBytes =
    deviceRole === 0 ? new Uint8Array(vaultAccount.primaryContributorDevice) : new Uint8Array(vaultAccount.partnerDevice);

  const amountRaw = new anchor.BN(Math.round(amountUi * 10 ** decimals));
  const frequencyArg = frequency === "monthly" ? { monthly: {} } : { weekly: {} };
  const nextRunArg = new anchor.BN(nextRunUnixSeconds);

  const buildInstruction = (authenticatorData, clientDataJson) =>
    program.methods
      .authorizeRecurringDelegate(deviceRole, amountRaw, frequencyArg, nextRunArg, authenticatorData, clientDataJson)
      .accounts({
        payer: walletHandle.publicKey,
        instructionsSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
        sourceTokenAccount,
        walletAuthority: walletAuthorityPda,
        tokenProgram: splToken.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .instruction();

  return passkeyAuthorizedCall({
    connection,
    walletHandle,
    credentialId,
    rpId,
    businessDataLen: AUTHORIZE_DELEGATE_BUSINESS_DATA_LEN,
    buildInstruction,
    devicePubkeyBytes,
  });
}

export async function cancelRecurring({
  connection,
  walletHandle,
  vaultPda,
  goalPda,
  credentialId,
  rpId,
  deviceRole = 0,
}) {
  const program = getProgram(connection, walletHandle);
  const delegatePda = deriveDelegatePda(goalPda);

  const vaultAccount = await program.account.familyVault.fetch(vaultPda);
  const devicePubkeyBytes =
    deviceRole === 0 ? new Uint8Array(vaultAccount.primaryContributorDevice) : new Uint8Array(vaultAccount.partnerDevice);

  const buildInstruction = (authenticatorData, clientDataJson) =>
    program.methods
      .cancelRecurringDelegate(deviceRole, authenticatorData, clientDataJson)
      .accounts({
        payer: walletHandle.publicKey,
        instructionsSysvar: web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
      })
      .instruction();

  return passkeyAuthorizedCall({
    connection,
    walletHandle,
    credentialId,
    rpId,
    businessDataLen: CANCEL_DELEGATE_BUSINESS_DATA_LEN,
    buildInstruction,
    devicePubkeyBytes,
  });
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

// Real on-chain contribution history for a goal, read straight from the
// chain's own RPC (getSignaturesForAddress + getParsedTransaction) - not
// a CookieScan integration. CookieScan (cookiescan.io) has no discoverable
// public API as of this build (checked: no docs page, no api.cookiescan.io
// or docs.cookiescan.io found), so this deliberately does not claim to be
// one. It reads the goal's own token account history and reports the
// SPL transfers that landed in it, which is exactly what "money moved
// into this goal" means on-chain, regardless of which explorer indexes it.
export async function fetchGoalActivity(connection, goalTokenAccount, limit = 15) {
  const signatures = await connection.getSignaturesForAddress(goalTokenAccount, { limit }, "confirmed");
  const events = [];

  for (const sigInfo of signatures) {
    if (sigInfo.err) continue; // failed transactions moved nothing
    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) continue;

    const amount = extractTransferAmountInto(tx, goalTokenAccount);
    if (amount === null) continue; // not a transfer into this account (e.g. account creation)

    events.push({
      signature: sigInfo.signature,
      blockTime: sigInfo.blockTime ?? tx.blockTime ?? null,
      amountRaw: amount,
    });
  }

  return events;
}

// Scans a parsed transaction's instructions (including inner instructions,
// since contribute() moves funds via a CPI, not a top-level instruction)
// for an SPL token transfer whose destination is goalTokenAccount, and
// returns the raw token amount moved, or null if none is found.
function extractTransferAmountInto(tx, goalTokenAccount) {
  const targetStr = goalTokenAccount.toBase58();
  const allInstructions = [
    ...(tx.transaction?.message?.instructions ?? []),
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];

  for (const ix of allInstructions) {
    const parsed = ix.parsed;
    if (!parsed || (parsed.type !== "transferChecked" && parsed.type !== "transfer")) continue;
    const info = parsed.info;
    if (info.destination !== targetStr) continue;
    if (parsed.type === "transferChecked") return BigInt(info.tokenAmount.amount);
    return BigInt(info.amount);
  }
  return null;
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
