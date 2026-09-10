use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::errors::FamilyWalletError;
use crate::state::{Currency, FamilyVault, GoalStatus, SavingsGoal};

#[derive(Accounts)]
pub struct InitSavingsGoal<'info> {
    #[account(mut)]
    pub backend_authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, FamilyVault>,

    #[account(
        init,
        payer = backend_authority,
        space = SavingsGoal::SPACE,
        seeds = [b"goal", vault.key().as_ref(), vault.goal_seq.to_le_bytes().as_ref()],
        bump
    )]
    pub goal: Account<'info, SavingsGoal>,

    /// Program-created via CPI to the Associated Token Program —
    /// CORRECTED from the earlier draft, which trusted the client to
    /// pre-create this and just hand over an address with no on-chain
    /// verification of who actually created it or what authority it
    /// has. The goal PDA itself is the token account's authority,
    /// enforced structurally by the associated_token::authority
    /// constraint below, not by convention.
    #[account(
        init,
        payer = backend_authority,
        associated_token::mint = mint,
        associated_token::authority = goal,
    )]
    pub goal_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitSavingsGoal>,
    name: String,
    target_amount: u64,
    currency: Currency,
    deadline: i64,
) -> Result<()> {
    require!(name.as_bytes().len() <= 32, FamilyWalletError::NameTooLong);
    let mut name_bytes = [0u8; 32];
    name_bytes[..name.as_bytes().len()].copy_from_slice(name.as_bytes());

    let goal = &mut ctx.accounts.goal;
    goal.vault = ctx.accounts.vault.key();
    goal.goal_seq = ctx.accounts.vault.goal_seq;
    goal.name = name_bytes;
    goal.target_amount = target_amount;
    goal.current_amount = 0;
    goal.currency = currency;
    goal.deadline = deadline;
    goal.status = GoalStatus::Active;
    goal.mint = ctx.accounts.mint.key();
    goal.goal_token_account = ctx.accounts.goal_token_account.key();
    goal.bump = ctx.bumps.goal;
    goal.created_at = Clock::get()?.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    vault.goal_seq = vault
        .goal_seq
        .checked_add(1)
        .ok_or(FamilyWalletError::Overflow)?;

    Ok(())
}
