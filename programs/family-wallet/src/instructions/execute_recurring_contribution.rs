use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::FamilyWalletError;
use crate::fee::resolve_fee_amount;
use crate::state::{
    FamilyVault, FeeConfig, Frequency, GoalStatus, RecurringContributionDelegate, SavingsGoal,
    ScheduleStatus,
};
use crate::token_transfer::transfer_checked_cpi_signed;

/// Called by the Celery scheduler (any keeper, no special signer
/// privilege needed for the CALLER — the fund-movement authority comes
/// entirely from the on-chain delegate PDA + its seeds, not from
/// whoever submits this transaction). This is deliberate: a
/// compromised backend key that can only CALL this instruction still
/// cannot move more than `amount_per_period`, cannot move funds early,
/// and cannot move funds to anywhere except goal_token_account /
/// fee_destination, because those are enforced by the constraints
/// below, not by caller identity.
#[derive(Accounts)]
pub struct ExecuteRecurringContribution<'info> {
    /// Anyone may call this — see doc comment above. Pays the tx fee.
    #[account(mut)]
    pub keeper: Signer<'info>,

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

    #[account(
        mut,
        seeds = [b"delegate", goal.key().as_ref()],
        bump = delegate.bump,
        has_one = goal,
        has_one = vault,
    )]
    pub delegate: Box<Account<'info, RecurringContributionDelegate>>,

    #[account(mut, address = goal.goal_token_account)]
    pub goal_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut, address = vault.fee_destination)]
    pub fee_destination: Box<Account<'info, TokenAccount>>,

    /// The recurring schedule's registered source, enforced on-chain
    /// against delegate.source_token_account — the backend cannot
    /// redirect this to a different account, even one that's also
    /// SPL-approved for this delegate PDA.
    #[account(mut, address = delegate.source_token_account)]
    pub source_token_account: Box<Account<'info, TokenAccount>>,

    #[account(address = goal.mint)]
    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExecuteRecurringContribution>, decimals: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    {
        let delegate = &ctx.accounts.delegate;
        require!(
            delegate.status == ScheduleStatus::Active,
            FamilyWalletError::ScheduleNotActive
        );
        require!(now >= delegate.next_run_at, FamilyWalletError::ScheduleNotDue);
        require!(
            ctx.accounts.goal.status == GoalStatus::Active,
            FamilyWalletError::GoalNotActive
        );
    }

    let amount = ctx.accounts.delegate.amount_per_period;
    let fee_amount = resolve_fee_amount(&ctx.accounts.fee_config, ctx.accounts.vault.fee_tier);

    let goal_key = ctx.accounts.goal.key();
    let delegate_bump = ctx.accounts.delegate.bump;
    let delegate_seeds: &[&[u8]] = &[b"delegate", goal_key.as_ref(), &[delegate_bump]];
    let signer_seeds: &[&[&[u8]]] = &[delegate_seeds];

    transfer_checked_cpi_signed(
        &ctx.accounts.token_program,
        &ctx.accounts.source_token_account,
        &ctx.accounts.mint,
        &ctx.accounts.goal_token_account,
        &ctx.accounts.delegate.to_account_info(),
        amount,
        decimals,
        signer_seeds,
    )?;

    if fee_amount > 0 {
        transfer_checked_cpi_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.source_token_account,
            &ctx.accounts.mint,
            &ctx.accounts.fee_destination,
            &ctx.accounts.delegate.to_account_info(),
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

    let delegate = &mut ctx.accounts.delegate;
    let period_seconds: i64 = match delegate.frequency {
        Frequency::Weekly => 7 * 24 * 60 * 60,
        Frequency::Monthly => 30 * 24 * 60 * 60,
    };
    delegate.next_run_at = delegate
        .next_run_at
        .checked_add(period_seconds)
        .ok_or(FamilyWalletError::Overflow)?;

    Ok(())
}
