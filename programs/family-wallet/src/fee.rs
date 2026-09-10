use crate::state::{FeeConfig, FeeTier};

/// Resolves the actual fee amount for a vault's tier by reading the
/// singleton FeeConfig. Waived is hardcoded to zero at the type level
/// (see state.rs) so it can never accidentally pick up a nonzero value.
pub fn resolve_fee_amount(fee_config: &FeeConfig, tier: FeeTier) -> u64 {
    match tier {
        FeeTier::Standard => fee_config.standard_fee_amount,
        FeeTier::Founding => fee_config.founding_fee_amount,
        FeeTier::Waived => 0,
    }
}
