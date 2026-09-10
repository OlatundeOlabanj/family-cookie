use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::FamilyWalletError;
use crate::passkey::verify_passkey_authorization;
use crate::state::{FamilyVault, GoalStatus, SavingsGoal};

/// v1: either registered device can withdraw the full or partial goal
/// balance to their own token account. No guardian approval required
/// for withdrawal in v1 — deliberate scope choice, guardian authority
/// is recovery-only, not a spending control.
///
/// Unlike contribute.rs, this does NOT need wallet_authority as a CPI
/// signer — funds move FROM the shared goal (owned by the goal PDA)
/// TO the person, not from their personal holding account. The
/// destination_token_account has no separate ownership constraint
/// here because it doesn't need one: it's part of this transaction's
/// account list, which is included in the full-transaction hash the
/// passkey signature commits to — any substitution of the destination
/// would invalidate the signature.
#[derive(Accounts)]
#[instruction(device_role: u8)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: read via introspection inside verify_passkey_authorization.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub vault: Account<'info, FamilyVault>,

    #[account(
        mut,
        seeds = [b"goal", vault.key().as_ref(), goal.goal_seq.to_le_bytes().as_ref()],
        bump = goal.bump,
        has_one = vault,
    )]
    pub goal: Account<'info, SavingsGoal>,

    #[account(mut, address = goal.goal_token_account)]
    pub goal_token_account: Account<'info, TokenAccount>,

    /// The withdrawing device's own token account.
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,

    #[account(address = goal.mint)]
    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<Withdraw>,
    device_role: u8,
    amount: u64,
    decimals: u8,
    authenticator_data: Vec<u8>,
    client_data_json: Vec<u8>,
) -> Result<()> {
    require!(amount > 0, FamilyWalletError::ZeroAmount);

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

    let goal = &ctx.accounts.goal;
    require!(
        goal.status == GoalStatus::Active || goal.status == GoalStatus::Completed,
        FamilyWalletError::GoalNotActive
    );
    require!(
        amount <= goal.current_amount,
        FamilyWalletError::InsufficientGoalBalance
    );

    let vault_key = ctx.accounts.vault.key();
    let goal_bump = ctx.accounts.goal.bump;
    let goal_seq_bytes = ctx.accounts.goal.goal_seq.to_le_bytes();
    let goal_seeds: &[&[u8]] = &[b"goal", vault_key.as_ref(), &goal_seq_bytes, &[goal_bump]];
    let signer_seeds: &[&[&[u8]]] = &[goal_seeds];

    crate::token_transfer::transfer_checked_cpi_signed(
        &ctx.accounts.token_program,
        &ctx.accounts.goal_token_account,
        &ctx.accounts.mint,
        &ctx.accounts.destination_token_account,
        &ctx.accounts.goal.to_account_info(),
        amount,
        decimals,
        signer_seeds,
    )?;

    let goal = &mut ctx.accounts.goal;
    goal.current_amount = goal
        .current_amount
        .checked_sub(amount)
        .ok_or(FamilyWalletError::Overflow)?;
    if goal.current_amount == 0 {
        goal.status = GoalStatus::Withdrawn;
    }

    Ok(())
}
