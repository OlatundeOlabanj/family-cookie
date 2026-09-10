use anchor_lang::prelude::*;
use anchor_spl::token::{approve, Approve, Token, TokenAccount};
use crate::errors::FamilyWalletError;
use crate::passkey::verify_passkey_authorization;
use crate::state::{FamilyVault, Frequency, RecurringContributionDelegate, SavingsGoal, ScheduleStatus};

/// Records the recurring-contribution schedule AND grants the delegate
/// PDA real SPL Approve authority over source_token_account, in the
/// same instruction — CORRECTED from an earlier design that assumed
/// the contributor could submit a separate client-side Approve
/// themselves. That only works for a normal wallet-owned account;
/// source_token_account is owned by wallet_authority, a PDA with no
/// private key, so only THIS PROGRAM can approve on its behalf, via
/// invoke_signed, gated by the same passkey verification already
/// required for this instruction.
#[derive(Accounts)]
#[instruction(device_role: u8)]
pub struct AuthorizeRecurringDelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: read via introspection inside verify_passkey_authorization.
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub vault: Box<Account<'info, FamilyVault>>,

    #[account(
        seeds = [b"goal", vault.key().as_ref(), goal.goal_seq.to_le_bytes().as_ref()],
        bump = goal.bump,
        has_one = vault,
    )]
    pub goal: Box<Account<'info, SavingsGoal>>,

    #[account(
        init,
        payer = payer,
        space = RecurringContributionDelegate::SPACE,
        seeds = [b"delegate", goal.key().as_ref()],
        bump
    )]
    pub delegate: Box<Account<'info, RecurringContributionDelegate>>,

    /// The contributing device's own token account that will fund
    /// this schedule — must be owned by that device's wallet_authority
    /// PDA (checked below).
    #[account(mut)]
    pub source_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: signing-authority-only PDA, holds no data. Also the SPL
    /// Approve authority (via invoke_signed) for source_token_account.
    #[account(
        seeds = [b"wallet", vault.key().as_ref(), &[device_role]],
        bump,
    )]
    pub wallet_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<AuthorizeRecurringDelegate>,
    device_role: u8,
    amount_per_period: u64,
    frequency: Frequency,
    next_run_at: i64,
    authenticator_data: Vec<u8>,
    client_data_json: Vec<u8>,
) -> Result<()> {
    require!(amount_per_period > 0, FamilyWalletError::ZeroAmount);
    require!(
        ctx.accounts.source_token_account.owner == ctx.accounts.wallet_authority.key(),
        FamilyWalletError::UnauthorizedContributor
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
        1 + 8 + 1 + 8, // device_role + amount_per_period + frequency + next_run_at
    )?;

    let delegate = &mut ctx.accounts.delegate;
    delegate.goal = ctx.accounts.goal.key();
    delegate.vault = ctx.accounts.vault.key();
    delegate.authorized_by_role = device_role;
    delegate.source_token_account = ctx.accounts.source_token_account.key();
    delegate.amount_per_period = amount_per_period;
    delegate.frequency = frequency;
    delegate.next_run_at = next_run_at;
    delegate.status = ScheduleStatus::Active;
    delegate.bump = ctx.bumps.delegate;
    delegate.created_at = Clock::get()?.unix_timestamp;

    // Real fund-movement authorization for the recurring path: approve
    // the delegate PDA to move up to a generous multi-period ceiling.
    // The actual per-execution enforcement (exact amount, timing,
    // status) is our own program's job in execute_recurring_contribution
    // — this SPL allowance is a ceiling, not the primary control.
    let vault_key = ctx.accounts.vault.key();
    let wallet_bump = ctx.bumps.wallet_authority;
    let wallet_seeds: &[&[u8]] = &[b"wallet", vault_key.as_ref(), &[device_role], &[wallet_bump]];
    let signer_seeds: &[&[&[u8]]] = &[wallet_seeds];

    let approve_amount = amount_per_period
        .checked_mul(100)
        .ok_or(FamilyWalletError::Overflow)?;

    let cpi_accounts = Approve {
        to: ctx.accounts.source_token_account.to_account_info(),
        delegate: ctx.accounts.delegate.to_account_info(),
        authority: ctx.accounts.wallet_authority.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    approve(cpi_ctx, approve_amount)?;

    Ok(())
}
