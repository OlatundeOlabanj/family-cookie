// Full end-to-end test of `contribute` under real passkey auth:
// creates a fresh vault (new schema), a goal, funds a real
// wallet_authority-owned token account, and contributes using a real
// P-256 signature — the actual production code path, not an isolated
// verification check.

import * as crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  Keypair,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, createTransferInstruction } from "@solana/spl-token";
import {
  getProgram,
  loadTestWallet,
  deriveFeeConfigPda,
  deriveVaultPda,
  deriveGoalPda,
  deriveWalletAuthorityPda,
  ensureAta,
} from "../tests/helpers";
import { DEVNET_USDC_MINT, USDC_DECIMALS } from "./constants";

const SECP256R1_PROGRAM_ID = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const EXPECTED_ORIGIN = "https://family-cookie-tjscode.netlify.app";
const CURVE_ORDER = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const DEVICE_ROLE_PRIMARY = 0;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getCompressedPubkey(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as any;
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const yIsOdd = (y[y.length - 1] & 1) === 1;
  return Buffer.concat([Buffer.from([yIsOdd ? 0x03 : 0x02]), x]);
}

function lowSNormalize(signature: Buffer): Buffer {
  const r = signature.subarray(0, 32);
  let s = signature.subarray(32, 64);
  const sBig = BigInt("0x" + s.toString("hex"));
  const halfOrder = CURVE_ORDER / 2n;
  if (sBig > halfOrder) {
    const normalized = CURVE_ORDER - sBig;
    let hex = normalized.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    hex = hex.padStart(64, "0");
    s = Buffer.from(hex, "hex");
  }
  return Buffer.concat([r, s]);
}

function buildPrecompileInstruction(signature: Buffer, pubkey: Buffer, message: Buffer) {
  const HEADER_LEN = 2;
  const OFFSETS_ENTRY_LEN = 14;
  const dataStart = HEADER_LEN + OFFSETS_ENTRY_LEN;
  const sigOffset = dataStart;
  const pubkeyOffset = sigOffset + 64;
  const messageOffset = pubkeyOffset + 33;

  const data = Buffer.alloc(messageOffset + message.length);
  data.writeUInt8(1, 0);
  data.writeUInt8(0, 1);
  data.writeUInt16LE(sigOffset, 2);
  data.writeUInt16LE(0xffff, 4);
  data.writeUInt16LE(pubkeyOffset, 6);
  data.writeUInt16LE(0xffff, 8);
  data.writeUInt16LE(messageOffset, 10);
  data.writeUInt16LE(message.length, 12);
  data.writeUInt16LE(0xffff, 14);
  signature.copy(data, sigOffset);
  pubkey.copy(data, pubkeyOffset);
  message.copy(data, messageOffset);

  return new TransactionInstruction({ programId: SECP256R1_PROGRAM_ID, keys: [], data });
}

async function main() {
  const { program, provider } = getProgram();
  const connection = provider.connection;
  const mainWallet = (provider.wallet as anchor.Wallet).payer;

  const primaryFunder = loadTestWallet("primary"); // already has USDC, used to fund the new smart-wallet account
  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");

  console.log("Generating real P-256 device keypair (primary)...");
  const { publicKey: devicePub, privateKey: devicePriv } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const primaryDevicePubkey = getCompressedPubkey(devicePub);
  const partnerDevicePubkey = Buffer.concat([Buffer.from([0x02]), crypto.randomBytes(32)]); // unused placeholder

  const vaultSeedKp = Keypair.generate(); // fresh nonce, never signs anything
  const [vaultPda] = deriveVaultPda(vaultSeedKp.publicKey);
  const [goalPda] = deriveGoalPda(vaultPda, 0);
  const [feeConfigPda] = deriveFeeConfigPda();
  const [walletAuthorityPda] = deriveWalletAuthorityPda(vaultPda, DEVICE_ROLE_PRIMARY);

  const feeDestinationUsdcAta = await ensureAta(
    connection,
    feeDestinationOwner,
    DEVNET_USDC_MINT,
    feeDestinationOwner.publicKey
  );

  console.log("Creating fresh vault (new schema)...");
  await program.methods
    .initFamilyVault(
      vaultSeedKp.publicKey,
      Array.from(primaryDevicePubkey),
      Array.from(partnerDevicePubkey),
      guardian.publicKey,
      { standard: {} },
      feeDestinationUsdcAta
    )
    .accounts({
      backendAuthority: mainWallet.publicKey,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const goalUsdcAta = await ensureAta(connection, mainWallet, DEVNET_USDC_MINT, goalPda);

  console.log("Creating savings goal...");
  const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
  await program.methods
    .initSavingsGoal(
      "E2E Passkey Test Goal",
      new anchor.BN(1000 * 10 ** USDC_DECIMALS),
      { usdc: {} },
      new anchor.BN(oneYearFromNow),
      DEVNET_USDC_MINT
    )
    .accounts({
      backendAuthority: mainWallet.publicKey,
      vault: vaultPda,
      goal: goalPda,
      goalTokenAccount: goalUsdcAta,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Creating + funding the wallet_authority-owned token account (the 'personal deposit address')...");
  const walletAuthorityUsdcAta = await ensureAta(
    connection,
    mainWallet,
    DEVNET_USDC_MINT,
    walletAuthorityPda
  );
  const fundAmount = 2 * 10 ** USDC_DECIMALS; // 2 USDC
  const primaryFunderAta = await ensureAta(connection, primaryFunder, DEVNET_USDC_MINT, primaryFunder.publicKey);
  const fundIx = createTransferInstruction(primaryFunderAta, walletAuthorityUsdcAta, primaryFunder.publicKey, fundAmount);
  await provider.sendAndConfirm(new Transaction().add(fundIx), [primaryFunder]);
  console.log(`  funded wallet_authority's USDC account with ${fundAmount / 10 ** USDC_DECIMALS} USDC`);

  // --- Build the contribute instruction (placeholder proof fields first, to discover real account metas + business prefix) ---
  const contributeAmount = 1 * 10 ** USDC_DECIMALS; // 1 USDC
  const dummyBuf = Buffer.from([0]);

  const placeholderIx = await program.methods
    .contribute(DEVICE_ROLE_PRIMARY, new anchor.BN(contributeAmount), USDC_DECIMALS, dummyBuf, dummyBuf)
    .accounts({
      payer: mainWallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      feeConfig: feeConfigPda,
      vault: vaultPda,
      goal: goalPda,
      goalTokenAccount: goalUsdcAta,
      feeDestination: feeDestinationUsdcAta,
      contributorTokenAccount: walletAuthorityUsdcAta,
      walletAuthority: walletAuthorityPda,
      mint: DEVNET_USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const businessPrefixLen = 8 + 1 + 8 + 1; // discriminator + device_role + amount + decimals
  const businessPrefix = placeholderIx.data.subarray(0, businessPrefixLen);

  const hashInput = Buffer.concat([
    placeholderIx.programId.toBuffer(),
    ...placeholderIx.keys.map((k) =>
      Buffer.concat([k.pubkey.toBuffer(), Buffer.from([k.isSigner ? 1 : 0, k.isWritable ? 1 : 0])])
    ),
    businessPrefix,
  ]);
  const challengeHash = crypto.createHash("sha256").update(hashInput).digest();
  const challengeB64 = base64UrlEncode(challengeHash);
  console.log("Computed challenge:", challengeB64);

  const rpIdHash = crypto.createHash("sha256").update("family-cookie-tjscode.netlify.app").digest();
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 0])]);
  const clientDataJson = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: challengeB64, origin: EXPECTED_ORIGIN })
  );
  const clientDataHash = crypto.createHash("sha256").update(clientDataJson).digest();
  const message = Buffer.concat([authenticatorData, clientDataHash]);

  const rawSignature = crypto.sign(null, message, { key: devicePriv, dsaEncoding: "ieee-p1363" });
  const signature = lowSNormalize(rawSignature);

  const precompileIx = buildPrecompileInstruction(signature, primaryDevicePubkey, message);

  const realContributeIx = await program.methods
    .contribute(DEVICE_ROLE_PRIMARY, new anchor.BN(contributeAmount), USDC_DECIMALS, authenticatorData, clientDataJson)
    .accounts({
      payer: mainWallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      feeConfig: feeConfigPda,
      vault: vaultPda,
      goal: goalPda,
      goalTokenAccount: goalUsdcAta,
      feeDestination: feeDestinationUsdcAta,
      contributorTokenAccount: walletAuthorityUsdcAta,
      walletAuthority: walletAuthorityPda,
      mint: DEVNET_USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const before = await getAccount(connection, goalUsdcAta);

  console.log("Sending real contribute transaction (precompile + contribute)...");
  const tx = new Transaction().add(precompileIx).add(realContributeIx);
  try {
    const sig = await provider.sendAndConfirm(tx);
    console.log("SUCCESS. signature:", sig);
    const after = await getAccount(connection, goalUsdcAta);
    const delta = Number(after.amount) - Number(before.amount);
    console.log(`Goal balance increased by ${delta / 10 ** USDC_DECIMALS} USDC (expected ${contributeAmount / 10 ** USDC_DECIMALS})`);
  } catch (err: any) {
    console.log("FAILED:", err.message ?? err);
    if (err.logs) err.logs.forEach((l: string) => console.log("  " + l));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
