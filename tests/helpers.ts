import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { TEST_WALLETS_DIR } from "../scripts/constants";

export const IDL = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "target", "idl", "family_wallet.json"),
    "utf-8"
  )
);

export const PROGRAM_ID = new PublicKey(IDL.address ?? IDL.metadata?.address);

export function loadTestWallet(name: string): Keypair {
  const filePath = path.join(__dirname, "..", TEST_WALLETS_DIR, `${name}.json`);
  const secret = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function getProgram(): { program: anchor.Program; provider: anchor.AnchorProvider } {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL as anchor.Idl, provider);
  return { program, provider };
}

export function deriveFeeConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("fee_config")], PROGRAM_ID);
}

export function deriveVaultPda(vaultSeed: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultSeed.toBuffer()],
    PROGRAM_ID
  );
}

export function deriveWalletAuthorityPda(
  vault: PublicKey,
  deviceRole: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("wallet"), vault.toBuffer(), Buffer.from([deviceRole])],
    PROGRAM_ID
  );
}

export function deriveGoalPda(vault: PublicKey, goalSeq: number): [PublicKey, number] {
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32LE(goalSeq, 0);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("goal"), vault.toBuffer(), seqBuf],
    PROGRAM_ID
  );
}

export function deriveDelegatePda(goal: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("delegate"), goal.toBuffer()],
    PROGRAM_ID
  );
}

export function deriveRotationPda(vault: PublicKey, deviceRole: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rotation"), vault.toBuffer(), Buffer.from([deviceRole])],
    PROGRAM_ID
  );
}

export async function ensureAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner,
    true
  );
  return account.address;
}

// --- Passkey (secp256r1) test helpers ---
// Real P-256 signing, WebAuthn-shaped message construction, and
// secp256r1 precompile instruction building — proven against real
// devnet transactions (contribute, withdraw, authorize_recurring_
// delegate, cancel_recurring_delegate all verified working with these
// helpers before they were moved here from standalone scripts).

import * as crypto from "crypto";
import { TransactionInstruction } from "@solana/web3.js";

export const SECP256R1_PROGRAM_ID = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
export const PASSKEY_EXPECTED_ORIGIN = "https://family-cookie-tjscode.netlify.app";

const CURVE_ORDER = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateDeviceKeypair(): {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  compressedPubkey: Buffer;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" }) as any;
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const yIsOdd = (y[y.length - 1] & 1) === 1;
  const compressedPubkey = Buffer.concat([Buffer.from([yIsOdd ? 0x03 : 0x02]), x]);
  return { publicKey, privateKey, compressedPubkey };
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

function buildPrecompileInstruction(signature: Buffer, pubkey: Buffer, message: Buffer): TransactionInstruction {
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

/// Given a PLACEHOLDER instruction (built with dummy proof-field bytes,
/// just to discover the real account metas + business-arg prefix),
/// computes the challenge, signs it with the real device key, and
/// returns everything needed to build the REAL instruction + its
/// paired precompile instruction.
export async function signForInstruction(
  placeholderIx: TransactionInstruction,
  businessDataLen: number,
  devicePriv: crypto.KeyObject,
  devicePub: Buffer
): Promise<{ authenticatorData: Buffer; clientDataJson: Buffer; precompileIx: TransactionInstruction }> {
  const businessPrefix = placeholderIx.data.subarray(0, 8 + businessDataLen);
  const hashInput = Buffer.concat([
    placeholderIx.programId.toBuffer(),
    ...placeholderIx.keys.map((k) =>
      Buffer.concat([k.pubkey.toBuffer(), Buffer.from([k.isSigner ? 1 : 0, k.isWritable ? 1 : 0])])
    ),
    businessPrefix,
  ]);
  const challengeHash = crypto.createHash("sha256").update(hashInput).digest();
  const challengeB64 = base64UrlEncode(challengeHash);

  const rpIdHash = crypto.createHash("sha256").update("family-cookie-tjscode.netlify.app").digest();
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 0])]);
  const clientDataJson = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: challengeB64, origin: PASSKEY_EXPECTED_ORIGIN })
  );
  const clientDataHash = crypto.createHash("sha256").update(clientDataJson).digest();
  const message = Buffer.concat([authenticatorData, clientDataHash]);

  const rawSig = crypto.sign(null, message, { key: devicePriv, dsaEncoding: "ieee-p1363" });
  const signature = lowSNormalize(rawSig);
  const precompileIx = buildPrecompileInstruction(signature, devicePub, message);

  return { authenticatorData, clientDataJson, precompileIx };
}
