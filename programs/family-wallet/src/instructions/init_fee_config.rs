use anchor_lang::prelude::*;

use crate::state::FeeConfig;

#[derive(Accounts)]
pub struct InitFeeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = FeeConfig::SPACE,
        seeds = [b"fee_config"],
        bump
    )]
    pub fee_config: Account<'info, FeeConfig>,

    pub system_program: Program<'info, System>,
}

/// Deployed once, ever, per program. Whoever signs this becomes the
/// admin who can later call `update_fee_config`. Run this immediately
/// after program deploy, before any FamilyVault is created.
pub fn handler(
    ctx: Context<InitFeeConfig>,
    standard_fee_amount: u64,
    founding_fee_amount: u64,
) -> Result<()> {
    let fee_config = &mut ctx.accounts.fee_config;
    fee_config.admin = ctx.accounts.admin.key();
    fee_config.standard_fee_amount = standard_fee_amount;
    fee_config.founding_fee_amount = founding_fee_amount;
    fee_config.bump = ctx.bumps.fee_config;
    Ok(())
}
