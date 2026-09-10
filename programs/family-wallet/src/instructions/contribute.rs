use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::FamilyWalletError;
use crate::fee::resolve_fee_amount;
use crate::passkey::verify_passkey_authorization;
use crate::state::{FamilyVault, FeeConfig, GoalStatus, SavingsGoal};
use crate::token_transfer::transfer_checked_cpi_signed;

/// Both Currency variants (Sol via wSOL, Usdc) are SPL token accounts,
/// so manual contributions use one unified TransferChecked path.
///
/// Authorization: NOT a Signer check. The contributor's funds live in
/// a wallet_authority PDA (per device, no off-chain keypair — see the
/// smart-wallet design in passkey.rs), and this instruction moves
/// funds out of it via invoke_signed ONLY after
/// verify_passkey_authorization confirms a real secp256r1 signature
/// from the registered device authorized this exact transaction
/// (full-transaction-hash bound, so amount/goal/every account here is
/// cryptographically committed to by the passkey signature itself).
#[derive(Accounts)]
#[instruction(device_role: u8)]
pub struct Contribute<'info> {
    /// Pays the transaction fee. No special privilege — passkey
    /// verification is what actually authorizes the fund movement.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: read via introspection inside verify_passkey_authorization.
    pub instructions_sysvar: UncheckedAccount<'info>,

    #[account(seeds = [b"fee_config"], bump = fee_config.bump)]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    pub vault: Box<Account<'info, FamilyVault>>,

    #[account(
        mut,
        seeds = [b"goal", vault.key().as_ref(), goal.goal_seq.to_le_bytes().as_ref()],
        bump = goal.bump,
        has_one = vault,
    )]
    pub goal: Box<Account<'info, SavingsGoal>>,

    #[account(mut, address = goal.goal_token_account)]
    pub goal_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault.fee_destination)]
    pub fee_destination: Box<Account<'info, TokenAccount>>,

    /// The contributing device's personal holding account — owned by
    /// wallet_authority, not by any personal keypair.
    #[account(mut)]
    pub contributor_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: signing-authority-only PDA, holds no data. Verified via
    /// seeds constraint below; used solely as CPI signer once passkey
    /// verification succeeds.
    #[account(
        seeds = [b"wallet", vault.key().as_ref(), &[device_role]],
        bump,
    )]
    pub wallet_authority: UncheckedAccount<'info>,

    #[account(address = goal.mint)]
    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<Contribute>,
    device_role: u8,
    amount: u64,
    decimals: u8,
    authenticator_data: Vec<u8>,
    client_data_json: Vec<u8>,
) -> Result<()> {
    require!(amount > 0, FamilyWalletError::ZeroAmount);
    require!(
        ctx.accounts.goal.status == GoalStatus::Active,
        FamilyWalletError::GoalNotActive
    );

    let expected_device_pubkey = match device_role {
        0 => ctx.accounts.vault.primary_contributor_device,
        1 => ctx.accounts.vault.partner_device,
        _ => return err!(FamilyWalletError::UnauthorizedContributor),
    };

    // TODO(passkey): expected_origin should come from program-level
    // config once the frontend domain is finalized — placeholder now.
    verify_passkey_authorization(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &expected_device_pubkey,
        &authenticator_data,
        &client_data_json,
        b"https://family-cookie-tjscode.netlify.app",
        10,
    )?;

    let fee_amount = resolve_fee_amount(&ctx.accounts.fee_config, ctx.accounts.vault.fee_tier);

    let vault_key = ctx.accounts.vault.key();
    let wallet_bump = ctx.bumps.wallet_authority;
    let wallet_seeds: &[&[u8]] = &[b"wallet", vault_key.as_ref(), &[device_role], &[wallet_bump]];
    let signer_seeds: &[&[&[u8]]] = &[wallet_seeds];

    transfer_checked_cpi_signed(
        &ctx.accounts.token_program,
        &ctx.accounts.contributor_token_account,
        &ctx.accounts.mint,
        &ctx.accounts.goal_token_account,
        &ctx.accounts.wallet_authority.to_account_info(),
        amount,
        decimals,
        signer_seeds,
    )?;

    if fee_amount > 0 {
        transfer_checked_cpi_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.contributor_token_account,
            &ctx.accounts.mint,
            &ctx.accounts.fee_destination,
            &ctx.accounts.wallet_authority.to_account_info(),
            fee_amount,
            decimals,
            signer_seeds,
        )?;
    }

    let goal = &mut ctx.accounts.goal;
    goal.current_amount = goal
        .current_amount
        .checked_add(amount)
        .ok_or(FamilyWalletError::Overflow)?;
    if goal.current_amount >= goal.target_amount {
        goal.status = GoalStatus::Completed;
    }

    Ok(())
}
