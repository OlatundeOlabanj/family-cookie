// Passkey (secp256r1) authorization verification.
//
// This is the highest-risk file in the program — it's the actual
// on-chain check that a WebAuthn passkey really authorized this
// specific transaction. Two things in here are my best understanding
// from Solana's spec/docs, NOT yet confirmed against a real compiler
// or a real browser-generated signature, flagged inline where they
// appear:
//   1. The exact import path for the secp256r1 precompile's program ID
//   2. Whether u16::MAX is really the "this same instruction" sentinel
//      for the offsets' instruction-index fields (modeled on the
//      well-documented Ed25519 precompile's convention, which
//      secp256r1 was designed to mirror — but not independently
//      verified here).
// Everything else (offsets struct layout, WebAuthn message format) is
// confirmed against Solana's SIMD-0075 spec.
//
// CORRECTED after an earlier design flaw: the challenge commitment
// cannot include the precompile instruction (not determined until
// after signing) or the proof fields on our own instruction
// (authenticator_data, client_data_json — also downstream of the
// commitment itself). Doing so is circular: you can't sign a
// commitment to your own signature. The fix: hash every OTHER
// instruction in full (this is what still closes the "compromised
// backend bundles an extra instruction" attack class), skip the
// precompile instruction entirely, and for our own instruction only
// hash the fixed-size "business argument" prefix (device_role,
// amount, etc. — whatever comes before the variable-length proof
// fields in the instruction's declared argument order).

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sha256_hasher::hashv;

use crate::errors::FamilyWalletError;

// UNCONFIRMED IMPORT — best guess based on the analogous, confirmed-
// working `solana_sdk_ids::secp256k1_program` pattern for the OTHER
// precompile. If this doesn't resolve, the fallback is comparing
// `ix.program_id.to_string()` against the literal base58 string
// "Secp256r1SigVerify1111111111111111111111111" instead.
use solana_sdk_ids::secp256r1_program;

const SIGNATURE_LEN: usize = 64;
const COMPRESSED_PUBKEY_LEN: usize = 33;
const OFFSETS_HEADER_LEN: usize = 2; // num_signatures (u8) + padding (u8)
const OFFSETS_ENTRY_LEN: usize = 14; // 7 x u16 LE
const CURRENT_INSTRUCTION_SENTINEL: u16 = u16::MAX;
const ANCHOR_DISCRIMINATOR_LEN: usize = 8;

struct Secp256r1SignatureOffsets {
    signature_offset: u16,
    signature_instruction_index: u16,
    public_key_offset: u16,
    public_key_instruction_index: u16,
    message_data_offset: u16,
    message_data_size: u16,
    message_instruction_index: u16,
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    require!(
        data.len() >= offset + 2,
        FamilyWalletError::InvalidPasskeyProof
    );
    Ok(u16::from_le_bytes([data[offset], data[offset + 1]]))
}

fn parse_offsets(data: &[u8]) -> Result<Secp256r1SignatureOffsets> {
    require!(
        data.len() >= OFFSETS_HEADER_LEN + OFFSETS_ENTRY_LEN,
        FamilyWalletError::InvalidPasskeyProof
    );
    let num_signatures = data[0];
    require!(num_signatures >= 1, FamilyWalletError::InvalidPasskeyProof);

    let base = OFFSETS_HEADER_LEN;
    Ok(Secp256r1SignatureOffsets {
        signature_offset: read_u16(data, base)?,
        signature_instruction_index: read_u16(data, base + 2)?,
        public_key_offset: read_u16(data, base + 4)?,
        public_key_instruction_index: read_u16(data, base + 6)?,
        message_data_offset: read_u16(data, base + 8)?,
        message_data_size: read_u16(data, base + 10)?,
        message_instruction_index: read_u16(data, base + 12)?,
    })
}

/// Resolves an offsets field's (instruction_index, data) into the
/// actual byte slice it refers to — which may be the same instruction
/// the offsets live in, or a different one in the same transaction.
fn resolve_bytes<'a>(
    instructions_sysvar: &AccountInfo,
    same_instruction_data: &'a [u8],
    instruction_index: u16,
    offset: u16,
    len: usize,
) -> Result<Vec<u8>> {
    let data: Vec<u8> = if instruction_index == CURRENT_INSTRUCTION_SENTINEL {
        same_instruction_data.to_vec()
    } else {
        let ix = load_instruction_at_checked(instruction_index as usize, instructions_sysvar)
            .map_err(|_| error!(FamilyWalletError::InvalidPasskeyProof))?;
        ix.data
    };
    let start = offset as usize;
    require!(
        data.len() >= start + len,
        FamilyWalletError::InvalidPasskeyProof
    );
    Ok(data[start..start + len].to_vec())
}

/// Finds the secp256r1 precompile instruction anywhere in this
/// transaction and returns (verified_pubkey, verified_message).
/// Does NOT re-verify the signature math — the Solana runtime already
/// guarantees that before our program executes at all (an invalid
/// precompile signature drops the whole transaction, never reaching
/// us). Our job is confirming it verified the RIGHT pubkey and
/// message, which the runtime does NOT guarantee on its own.
fn find_verified_secp256r1_signature(
    instructions_sysvar: &AccountInfo,
) -> Result<([u8; 33], Vec<u8>)> {
    let mut i: usize = 0;
    loop {
        let ix = match load_instruction_at_checked(i, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };
        if ix.program_id == secp256r1_program::ID {
            let offsets = parse_offsets(&ix.data)?;

            let pubkey_bytes = resolve_bytes(
                instructions_sysvar,
                &ix.data,
                offsets.public_key_instruction_index,
                offsets.public_key_offset,
                COMPRESSED_PUBKEY_LEN,
            )?;
            let mut pubkey = [0u8; COMPRESSED_PUBKEY_LEN];
            pubkey.copy_from_slice(&pubkey_bytes);

            let message = resolve_bytes(
                instructions_sysvar,
                &ix.data,
                offsets.message_instruction_index,
                offsets.message_data_offset,
                offsets.message_data_size as usize,
            )?;

            let _ = (offsets.signature_offset, offsets.signature_instruction_index, SIGNATURE_LEN);

            return Ok((pubkey, message));
        }
        i += 1;
    }
    Err(error!(FamilyWalletError::InvalidPasskeyProof))
}

/// Hashes the "authorized action" this transaction represents — every
/// OTHER instruction in full, PLUS only the fixed-size business-
/// argument prefix of our own instruction (after the 8-byte Anchor
/// discriminator). The secp256r1 precompile instruction is skipped
/// entirely. Both exclusions exist because those bytes are downstream
/// of this very commitment (see module doc comment) — including them
/// would make the challenge circular and unsatisfiable.
///
/// `business_data_len` is the number of bytes (after the discriminator)
/// that make up the fixed-size arguments declared BEFORE
/// authenticator_data/client_data_json in the calling instruction's
/// signature — e.g. for `contribute(device_role: u8, amount: u64,
/// decimals: u8, ...)` that's 1 + 8 + 1 = 10.
fn hash_authorized_action(
    instructions_sysvar: &AccountInfo,
    business_data_len: usize,
) -> Result<[u8; 32]> {
    let current_index = load_current_index_checked(instructions_sysvar)? as usize;

    let mut buffer: Vec<u8> = Vec::new();
    let mut i: usize = 0;
    loop {
        let ix = match load_instruction_at_checked(i, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => break,
        };

        if ix.program_id == secp256r1_program::ID {
            i += 1;
            continue;
        }

        buffer.extend_from_slice(ix.program_id.as_ref());
        for acc in ix.accounts.iter() {
            buffer.extend_from_slice(acc.pubkey.as_ref());
            buffer.push(acc.is_signer as u8);
            buffer.push(acc.is_writable as u8);
        }

        if i == current_index {
            let prefix_len = ANCHOR_DISCRIMINATOR_LEN + business_data_len;
            require!(
                ix.data.len() >= prefix_len,
                FamilyWalletError::InvalidPasskeyProof
            );
            buffer.extend_from_slice(&ix.data[..prefix_len]);
        } else {
            buffer.extend_from_slice(&ix.data);
        }

        i += 1;
    }
    Ok(hashv(&[&buffer]).to_bytes())
}

/// Finds `"key":"value"` in a clientDataJSON byte string and returns
/// `value`'s bytes. Deliberately NOT a general JSON parser — browsers
/// produce clientDataJSON deterministically, and the three fields we
/// read (type, origin, challenge) are all values that cannot contain
/// literal `"` or `\` characters (a fixed enum string, a URL, and
/// base64url respectively), so unescaped substring search is safe
/// for exactly this use case. Would NOT be safe for arbitrary JSON.
fn extract_json_string_field<'a>(json: &'a [u8], key: &str) -> Result<&'a [u8]> {
    let pattern = format!("\"{}\":\"", key);
    let pattern_bytes = pattern.as_bytes();
    let start = json
        .windows(pattern_bytes.len())
        .position(|w| w == pattern_bytes)
        .ok_or(error!(FamilyWalletError::InvalidPasskeyProof))?
        + pattern_bytes.len();
    let end = json[start..]
        .iter()
        .position(|&b| b == b'"')
        .ok_or(error!(FamilyWalletError::InvalidPasskeyProof))?
        + start;
    Ok(&json[start..end])
}

/// The main entry point every passkey-gated instruction calls.
/// `business_data_len` — see hash_authorized_action's doc comment.
pub fn verify_passkey_authorization(
    instructions_sysvar: &AccountInfo,
    expected_device_pubkey: &[u8; 33],
    authenticator_data: &[u8],
    client_data_json: &[u8],
    expected_origin: &[u8],
    business_data_len: usize,
) -> Result<()> {
    let (verified_pubkey, verified_message) =
        find_verified_secp256r1_signature(instructions_sysvar)?;

    require!(
        &verified_pubkey == expected_device_pubkey,
        FamilyWalletError::UnauthorizedContributor
    );

    let client_data_hash = hashv(&[client_data_json]).to_bytes();
    let mut expected_message = Vec::with_capacity(authenticator_data.len() + 32);
    expected_message.extend_from_slice(authenticator_data);
    expected_message.extend_from_slice(&client_data_hash);
    require!(
        expected_message == verified_message,
        FamilyWalletError::InvalidPasskeyProof
    );

    let origin = extract_json_string_field(client_data_json, "origin")?;
    require!(
        origin == expected_origin,
        FamilyWalletError::InvalidPasskeyProof
    );

    let cd_type = extract_json_string_field(client_data_json, "type")?;
    require!(
        cd_type == b"webauthn.get",
        FamilyWalletError::InvalidPasskeyProof
    );

    let challenge_b64 = extract_json_string_field(client_data_json, "challenge")?;
    let expected_challenge_hash = hash_authorized_action(instructions_sysvar, business_data_len)?;
    let expected_challenge_b64 = base64_url_encode(&expected_challenge_hash);
    require!(
        challenge_b64 == expected_challenge_b64.as_bytes(),
        FamilyWalletError::InvalidPasskeyProof
    );

    Ok(())
}

/// Minimal base64url (no padding) encoder — WebAuthn's `challenge`
/// field uses this encoding. Written by hand rather than pulling in a
/// base64 crate for one function; not performance-sensitive.
fn base64_url_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let triple = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(triple & 0x3F) as usize] as char);
        }
    }
    out
}
