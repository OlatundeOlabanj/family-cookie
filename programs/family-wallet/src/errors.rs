use anchor_lang::prelude::*;

#[error_code]
pub enum FamilyWalletError {
    #[msg("Fee tier does not match any configured tier.")]
    InvalidFeeTier,

    #[msg("Signer is not an authorized contributor on this vault.")]
    UnauthorizedContributor,

    #[msg("Signer is not the registered guardian on this vault.")]
    UnauthorizedGuardian,

    #[msg("Contribution amount must be greater than zero.")]
    ZeroAmount,

    #[msg("Contribution currency does not match the goal's currency.")]
    CurrencyMismatch,

    #[msg("Recurring schedule is not active.")]
    ScheduleNotActive,

    #[msg("Recurring contribution attempted before next_run_at.")]
    ScheduleNotDue,

    #[msg("Recurring contribution amount exceeds amount_per_period.")]
    AmountExceedsSchedule,

    #[msg("Savings goal is not active.")]
    GoalNotActive,

    #[msg("Withdrawal amount exceeds current goal balance.")]
    InsufficientGoalBalance,

    #[msg("Key rotation request is not in Pending status.")]
    RotationNotPending,

    #[msg("Lost device pubkey does not match any registered signer on this vault.")]
    DeviceNotRegistered,

    #[msg("Arithmetic overflow.")]
    Overflow,

    #[msg("Vault name exceeds maximum stored length.")]
    NameTooLong,
    #[msg("Passkey authorization proof is invalid or does not match this transaction.")]
    InvalidPasskeyProof,
}
