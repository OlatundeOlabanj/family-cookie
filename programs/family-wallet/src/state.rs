// Family Wallet, on-chain account structs (v1 draft)
// Made by TJS Code
//
// This file defines account layouts only. Instruction handlers
// (init, contribute, delegate, key-rotation, withdraw) come next,
// once these structs are confirmed.
//
// PDA seed conventions (documented here so backend + tests agree):
//   FeeConfig:                     [b"fee_config"]                                    (singleton)
//   FamilyVault:                   [b"vault", vault_seed.as_ref()]
//   SavingsGoal:                   [b"goal", vault.key().as_ref(), goal_seq.to_le_bytes().as_ref()]
//   RecurringContributionDelegate: [b"delegate", goal.key().as_ref()]
//   KeyRotationRequest:            [b"rotation", vault.key().as_ref(), &[device_role]]
//     device_role: 0 = primary_contributor_device, 1 = partner_device.
//     NOTE: seeded on a role byte, not the raw device pubkey — a
//     33-byte secp256r1 key exceeds Solana's 32-byte-per-seed limit,
//     and a role byte is simpler/clearer anyway ("the pending rotation
//     for the partner slot", not "for device X").

use anchor_lang::prelude::*;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum FeeTier {
    Standard = 0,
    Founding = 1,
    Waived = 2,
}

/// Singleton config account (one per program deployment). Holds the
/// actual fee amount per tier, so pricing can change globally without
/// touching any individual FamilyVault. FamilyVault only stores WHICH
/// tier it's on — that's the auditable, on-chain-visible part. Mutable
/// only by an admin authority (decide at instruction-design time
/// whether that's your program's upgrade authority or a dedicated
/// admin pubkey).
#[account]
pub struct FeeConfig {
    pub admin: Pubkey,
    pub standard_fee_amount: u64,
    pub founding_fee_amount: u64,
    // Waived tier is implicitly 0 — no field needed, which is itself
    // a nice auditing property: "Waived" can never accidentally charge.
    pub bump: u8,
}

impl FeeConfig {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1;
}

/// One per family. Root of trust for the guardian model (passkey signers
/// for day-to-day use + single third-party guardian for recovery).
#[account]
pub struct FamilyVault {
    /// This PDA's own address, stored for convenience in downstream CPIs.
    pub vault_authority: Pubkey,
    /// Dedicated nonce used ONLY to derive this vault's PDA address —
    /// deliberately decoupled from any authentication material. Two
    /// real bugs taught us this: (1) seeding on primary_contributor
    /// broke once that field became mutable via rotation, and (2)
    /// secp256r1 device keys are 33 bytes, which exceeds Solana's
    /// 32-byte-per-seed-component limit outright. A fresh, purpose-
    /// built nonce (e.g. a throwaway keypair's pubkey, generated once
    /// at creation and never used to sign anything) sidesteps both
    /// problems permanently.
    pub vault_seed: Pubkey,
    /// Day-to-day signer #1. Registered passkey pubkey (secp256r1,
    /// 33-byte compressed point) — NOT a conventional Ed25519 keypair.
    /// Verified via the secp256r1 precompile + instruction
    /// introspection, not via a normal Signer check.
    pub primary_contributor_device: [u8; 33],
    /// Day-to-day signer #2. Same verification mechanism as above.
    pub partner_device: [u8; 33],
    /// Recovery-only. A normal Ed25519 pubkey — the guardian is NOT
    /// passkey-based, deliberately, since guardian approval is a rare,
    /// high-stakes action better suited to a conventional wallet
    /// signature than a device-bound passkey.
    pub guardian: Pubkey,
    /// v1: flat fee, resolved via FeeConfig at contribution time.
    pub fee_tier: FeeTier,
    /// Where the atomic fee is swept to. TJS Code fee wallet.
    pub fee_destination: Pubkey,
    /// Monotonic counter used to derive SavingsGoal PDAs.
    pub goal_seq: u32,
    pub bump: u8,
    pub created_at: i64,
}
impl FamilyVault {
    pub const SPACE: usize =
        8 // discriminator
        + 32 // vault_authority
        + 32 // vault_seed
        + 33 // primary_contributor_device
        + 33 // partner_device
        + 32 // guardian
        + 1  // fee_tier
        + 32 // fee_destination
        + 4  // goal_seq
        + 1  // bump
        + 8; // created_at
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum Currency {
    Sol = 0,
    Usdc = 1,
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum GoalStatus {
    Active = 0,
    Completed = 1,
    Withdrawn = 2,
}

/// v1: one shared savings goal per family vault (goal_seq will be 0
/// for every vault in v1, but the struct doesn't hardcode that
/// assumption — keeps the door open without a migration later).
#[account]
pub struct SavingsGoal {
    pub vault: Pubkey,
    pub goal_seq: u32,

    pub name: [u8; 32],       // fixed-size, UTF-8, zero-padded — keeps rent predictable
    pub target_amount: u64,
    pub current_amount: u64,
    pub currency: Currency,
    pub deadline: i64,
    pub status: GoalStatus,

    /// Token mint this goal is denominated in. CORRECTION from earlier
    /// draft: SOL goals use the wSOL mint (native SOL has no delegate/
    /// approve mechanism, so recurring contributions are impossible
    /// without wrapping — see RecurringContributionDelegate). Both
    /// Currency variants are therefore always SPL token accounts.
    pub mint: Pubkey,

    /// Vault token account (or native SOL PDA) actually holding funds.
    pub goal_token_account: Pubkey,

    pub bump: u8,
    pub created_at: i64,
}

impl SavingsGoal {
    pub const SPACE: usize = 8 + 32 + 4 + 32 + 8 + 8 + 1 + 8 + 1 + 32 + 32 + 1 + 8;
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum ScheduleStatus {
    Active = 0,
    Paused = 1,
    Cancelled = 2,
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum Frequency {
    Weekly = 0,
    Monthly = 1,
}

/// The delegated-authority account. This is the highest-risk struct in
/// v1 — it exists specifically so a parent doesn't have to manually sign
/// every recurring DCA transfer. The Celery scheduler submits contribute
/// transactions on this delegate's behalf; the program must verify:
///   1. the delegate PDA matches this account exactly (seeds constraint)
///   2. amount <= amount_per_period (never more than authorized)
///   3. now >= next_run_at (never early)
///   4. status == Active
/// This account itself holds NO signing key off-chain — it's a PDA,
/// so only the program (via CPI with the right seeds) can move funds
/// under it. There is no separate "delegate keypair" to leak.
#[account]
pub struct RecurringContributionDelegate {
    pub goal: Pubkey,
    pub vault: Pubkey,

    /// Which registered contributor this recurring schedule is
    /// attributed to in Contribution records (for UI/history only —
    /// authorization comes from the PDA, not this field).
    pub authorized_by_role: u8,

    /// The exact token account this schedule pulls from, recorded at
    /// authorization time and enforced on-chain in
    /// execute_recurring_contribution via an `address` constraint.
    /// Closes a real trust gap: without this, a compromised backend
    /// could redirect the recurring payment source to any SPL-approved
    /// account it chose, even though the amount/timing were still
    /// enforced correctly.
    pub source_token_account: Pubkey,

    pub amount_per_period: u64,
    pub frequency: Frequency,
    pub next_run_at: i64,
    pub status: ScheduleStatus,

    pub bump: u8,
    pub created_at: i64,
}

impl RecurringContributionDelegate {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 32 + 8 + 1 + 8 + 1 + 1 + 8;
}

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[borsh(use_discriminant = true)]
pub enum RotationStatus {
    Pending = 0,
    Approved = 1,
    Executed = 2,
    Rejected = 3,
}

/// Second highest-risk struct in v1. Guardian-alone approval (per
/// current decision — no partner veto window in v1). Seeded on a role
/// byte (device_role), not the raw device pubkey — a 33-byte secp256r1
/// key exceeds Solana's 32-byte-per-seed limit. One open request per
/// role at a time; PDA seeds enforce that (re-requesting while Pending
/// should fail, not silently overwrite).
#[account]
pub struct KeyRotationRequest {
    pub vault: Pubkey,

    /// 0 = primary_contributor_device, 1 = partner_device. Also the
    /// PDA seed component identifying which slot this request targets.
    pub device_role: u8,

    /// Snapshotted from the vault at request time, for audit — not
    /// itself load-bearing for authorization (device_role + vault is).
    pub lost_device_pubkey: [u8; 33],
    pub new_device_pubkey: [u8; 33],

    /// Must equal FamilyVault.guardian at approval time — checked in
    /// the instruction, stored here for audit/history.
    pub guardian: Pubkey,

    pub status: RotationStatus,
    pub requested_at: i64,
    pub approved_at: i64, // 0 until approved

    pub bump: u8,
}
impl KeyRotationRequest {
    pub const SPACE: usize =
        8  // discriminator
        + 32 // vault
        + 1  // device_role
        + 33 // lost_device_pubkey
        + 33 // new_device_pubkey
        + 32 // guardian
        + 1  // status
        + 8  // requested_at
        + 8  // approved_at
        + 1; // bump
}
