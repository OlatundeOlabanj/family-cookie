use anchor_lang::prelude::*;

use crate::state::{FamilyVault, FeeTier};

#[derive(Accounts)]
#[instruction(vault_seed: Pubkey)]
pub struct InitFamilyVault<'info> {
    /// Backend service authority. Pays rent and signs vault creation.
    /// This is NOT a passkey check — vault creation happens once
    /// during onboarding, before any device is registered, so there's
    /// nothing to verify a signature against yet.
    #[account(mut)]
    pub backend_authority: Signer<'info>,

    #[account(
        init,
        payer = backend_authority,
        space = FamilyVault::SPACE,
        seeds = [b"vault", vault_seed.as_ref()],
        bump
    )]
    pub vault: Account<'info, FamilyVault>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitFamilyVault>,
    vault_seed: Pubkey,
    primary_contributor_device: [u8; 33],
    partner_device: [u8; 33],
    guardian: Pubkey,
    fee_tier: FeeTier,
    fee_destination: Pubkey,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    vault.vault_authority = vault.key();
    vault.vault_seed = vault_seed;
    vault.primary_contributor_device = primary_contributor_device;
    vault.partner_device = partner_device;
    vault.guardian = guardian;
    vault.fee_tier = fee_tier;
    vault.fee_destination = fee_destination;
    vault.goal_seq = 0;
    vault.bump = ctx.bumps.vault;
    vault.created_at = Clock::get()?.unix_timestamp;
    Ok(())
}
