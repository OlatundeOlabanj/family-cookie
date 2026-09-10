// WebAuthn passkey integration for the family-wallet program's custom
// secp256r1 authorization scheme.
//
// This mirrors programs/family-wallet/src/passkey.rs exactly. Two
// details that file flagged as "best guess, not independently
// confirmed" were checked against the official solana-secp256r1-program
// crate source (docs.rs, v2.2.2) while building this file, and BOTH
// check out:
//   1. The program id import (solana_sdk_ids::secp256r1_program::ID)
//      is correct - it's the crate's own re-export.
//   2. u16::MAX IS the "same instruction" sentinel for the offsets'
//      instruction-index fields, confirmed against the crate's own
//      new_secp256r1_instruction() reference implementation.
// One thing that reference implementation also clarified, which this
// file follows: the field ORDER inside the instruction data is
// pubkey, then signature, then message - not signature-first.
//
// Made by TJS Code

const { web3 } = window.FW_VENDOR;

export const SECP256R1_PROGRAM_ID = new web3.PublicKey("Secp256r1SigVerify1111111111111111111111111");

const COMPRESSED_PUBKEY_LEN = 33;
const SIGNATURE_LEN = 64;
const FIELD_SIZE = 32;
const OFFSETS_HEADER_LEN = 2;
const OFFSETS_ENTRY_LEN = 14;
const DATA_START = OFFSETS_HEADER_LEN + OFFSETS_ENTRY_LEN; // 16
const CURRENT_INSTRUCTION_SENTINEL = 0xffff;
const ANCHOR_DISCRIMINATOR_LEN = 8;

// SEC2 secp256r1 order and half-order, used for low-S normalization.
const SECP256R1_ORDER = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const SECP256R1_HALF_ORDER = SECP256R1_ORDER / 2n;

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

function concatBytes(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function u16le(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

// --- Registration (navigator.credentials.create) --------------------

// Registers a new platform passkey and returns its credential id and
// compressed secp256r1 public key (33 bytes) - the format the program
// stores per device on FamilyVault. Registration itself is NOT
// origin-checked on-chain (only assertions are, via contribute /
// withdraw / authorize_recurring_delegate / cancel_recurring_delegate),
// so this part works regardless of the EXPECTED_ORIGIN wiring.
export async function registerDevicePasskey({ rpId, rpName, userDisplayName }) {
  if (!window.PublicKeyCredential) {
    throw new Error("This browser does not support WebAuthn/passkeys.");
  }
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const challenge = crypto.getRandomValues(new Uint8Array(32)); // registration challenge, not origin-bound to any tx

  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: rpName },
      user: { id: userId, name: userDisplayName, displayName: userDisplayName },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 = ECDSA P-256 / secp256r1
      authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
      timeout: 60000,
      attestation: "none",
    },
  });
  if (!credential) throw new Error("Passkey registration was cancelled.");

  const response = credential.response;
  let spki;
  if (typeof response.getPublicKey === "function") {
    spki = new Uint8Array(response.getPublicKey());
  } else {
    throw new Error(
      "This browser's WebAuthn implementation doesn't expose getPublicKey(). Try a recent Chrome, Edge, or Safari."
    );
  }

  return {
    credentialId: new Uint8Array(credential.rawId),
    compressedPubkey: compressSpkiP256PublicKey(spki),
  };
}

// Parses the fixed 91-byte SPKI DER structure WebAuthn returns for a
// P-256 (secp256r1) public key and compresses the uncompressed EC
// point (0x04 || X || Y) down to the 33-byte compressed form the
// program expects (0x02/0x03 prefix + X), matching
// COMPRESSED_PUBKEY_LEN in passkey.rs.
function compressSpkiP256PublicKey(spki) {
  if (spki.length !== 91 || spki[spki.length - 65] !== 0x04) {
    throw new Error("Unexpected SPKI layout for a P-256 public key.");
  }
  const point = spki.slice(spki.length - 65); // 0x04 || X(32) || Y(32)
  const x = point.slice(1, 33);
  const y = point.slice(33, 65);
  const prefix = (y[31] & 1) === 1 ? 0x03 : 0x02;
  return concatBytes(new Uint8Array([prefix]), x);
}

// --- Challenge hash (mirrors hash_authorized_action in passkey.rs) --

// Computes the exact same 32-byte hash the on-chain program computes
// in hash_authorized_action: every OTHER instruction hashed in full
// (program id + per-account pubkey/signer/writable + full data),
// the secp256r1 precompile instruction skipped entirely, and the
// business instruction (the one at contributeIndex) hashed only over
// its fixed-size business-argument prefix
// (8-byte Anchor discriminator + businessDataLen bytes).
//
// `transaction` must already contain every non-precompile instruction
// in its FINAL order (accounts, data - everything) before this is
// called, since any change afterwards invalidates the passkey
// signature that gets bound to this exact hash.
export async function computeChallengeHash(transaction, contributeIndex, businessDataLen) {
  const message = transaction.compileMessage();
  let buffer = new Uint8Array(0);

  message.instructions.forEach((compiledIx, i) => {
    const programId = message.accountKeys[compiledIx.programIdIndex];
    if (programId.equals(SECP256R1_PROGRAM_ID)) return; // skipped, same as the Rust side

    const parts = [buffer, programId.toBytes()];
    for (const accIndex of compiledIx.accounts) {
      const pubkey = message.accountKeys[accIndex];
      parts.push(pubkey.toBytes());
      parts.push(new Uint8Array([message.isAccountSigner(accIndex) ? 1 : 0]));
      parts.push(new Uint8Array([message.isAccountWritable(accIndex) ? 1 : 0]));
    }

    const ixData = base58ToBytes(compiledIx.data);
    if (i === contributeIndex) {
      const prefixLen = ANCHOR_DISCRIMINATOR_LEN + businessDataLen;
      if (ixData.length < prefixLen) {
        throw new Error("Instruction data shorter than expected business-argument prefix.");
      }
      parts.push(ixData.slice(0, prefixLen));
    } else {
      parts.push(ixData);
    }
    buffer = concatBytes(...parts);
  });

  return await sha256(buffer);
}

function base58ToBytes(b58) {
  return window.FW_VENDOR.anchor.utils.bytes.bs58.decode(b58);
}

// --- Assertion (navigator.credentials.get) ---------------------------

// Requests a live WebAuthn assertion bound to `challengeHash` (the
// 32-byte output of computeChallengeHash) and returns the pieces the
// secp256r1 precompile instruction needs: authenticatorData,
// clientDataJSON, and a low-S-normalized raw 64-byte (r||s) signature.
export async function getPasskeyAssertion({ rpId, credentialId, challengeHash }) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId,
      challenge: challengeHash,
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "preferred",
      timeout: 60000,
    },
  });
  if (!assertion) throw new Error("Passkey approval was cancelled.");

  const response = assertion.response;
  const authenticatorData = new Uint8Array(response.authenticatorData);
  const clientDataJSON = new Uint8Array(response.clientDataJSON);
  const signatureDer = new Uint8Array(response.signature);

  return {
    authenticatorData,
    clientDataJSON,
    signatureRaw: normalizeLowS(derToRawSignature(signatureDer)),
  };
}

// WebAuthn/ASN.1 signatures are DER-encoded (SEQUENCE of two INTEGERs,
// r and s). The secp256r1 precompile wants raw, fixed-width 32+32
// bytes instead.
function derToRawSignature(der) {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Not a DER SEQUENCE.");
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const nBytes = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < nBytes; i++) seqLen = (seqLen << 8) | der[offset++];
  }
  function readInt() {
    if (der[offset++] !== 0x02) throw new Error("Expected DER INTEGER.");
    let len = der[offset++];
    if (len & 0x80) {
      const nBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < nBytes; i++) len = (len << 8) | der[offset++];
    }
    let bytes = der.slice(offset, offset + len);
    offset += len;
    // Strip a leading 0x00 sign-padding byte if present.
    if (bytes.length > FIELD_SIZE && bytes[0] === 0x00) bytes = bytes.slice(1);
    const padded = new Uint8Array(FIELD_SIZE);
    padded.set(bytes, FIELD_SIZE - bytes.length);
    return padded;
  }
  const r = readInt();
  const s = readInt();
  return concatBytes(r, s);
}

function normalizeLowS(rawSig) {
  const r = rawSig.slice(0, FIELD_SIZE);
  let s = rawSig.slice(FIELD_SIZE);
  const sInt = bytesToBigInt(s);
  if (sInt > SECP256R1_HALF_ORDER) {
    const normalized = SECP256R1_ORDER - sInt;
    s = bigIntToBytes(normalized, FIELD_SIZE);
  }
  return concatBytes(r, s);
}

function bytesToBigInt(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

function bigIntToBytes(n, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// --- Precompile instruction builder -----------------------------------

// Builds the secp256r1 precompile TransactionInstruction. Field order
// is pubkey, then signature, then message - confirmed against the
// official crate's new_secp256r1_instruction() reference. Both
// instruction-index fields use the CURRENT_INSTRUCTION_SENTINEL, i.e.
// "look inside this same instruction's data", exactly like the
// reference implementation and like passkey.rs expects.
export function buildSecp256r1Instruction({ compressedPubkey, signatureRaw, message }) {
  if (compressedPubkey.length !== COMPRESSED_PUBKEY_LEN) throw new Error("Pubkey must be 33 bytes.");
  if (signatureRaw.length !== SIGNATURE_LEN) throw new Error("Signature must be 64 bytes.");

  const pubkeyOffset = DATA_START;
  const signatureOffset = pubkeyOffset + COMPRESSED_PUBKEY_LEN;
  const messageOffset = signatureOffset + SIGNATURE_LEN;

  const header = new Uint8Array([1, 0]); // num_signatures = 1, padding = 0
  const offsets = concatBytes(
    u16le(signatureOffset),
    u16le(CURRENT_INSTRUCTION_SENTINEL),
    u16le(pubkeyOffset),
    u16le(CURRENT_INSTRUCTION_SENTINEL),
    u16le(messageOffset),
    u16le(message.length),
    u16le(CURRENT_INSTRUCTION_SENTINEL)
  );

  const data = concatBytes(header, offsets, compressedPubkey, signatureRaw, message);

  return new web3.TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data: Buffer.from(data),
  });
}

// Builds the WebAuthn-signed "message" the precompile verifies:
// authenticatorData || SHA-256(clientDataJSON), per the WebAuthn spec
// and exactly matching expected_message in verify_passkey_authorization.
export async function buildSignedMessage(authenticatorData, clientDataJSON) {
  const clientDataHash = await sha256(clientDataJSON);
  return concatBytes(authenticatorData, clientDataHash);
}
