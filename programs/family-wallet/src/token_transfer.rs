// SPL Token transfers via anchor_spl's CPI wrapper.
//
// CORRECTION from the earlier hand-rolled draft: calling the standalone
// `spl-token` crate's raw instruction builder directly, alongside
// anchor-lang's AccountInfo/Pubkey types, breaks on newer Anchor/Solana
// versions — anchor-lang 1.1.2 uses Solana's new modular SDK crates
// (solana-pubkey, solana-instruction, etc.), while standalone spl-token
// still resolves an older monolithic solana-program, so the two crates'
// "Pubkey" and "Instruction" types are structurally different despite
// sharing a name. anchor_spl is published in lockstep with anchor-lang
// specifically to avoid this — so we use its typed CPI helpers here
// instead of invoking the raw instruction ourselves. This is still "no
// @solana/spl-token" in spirit (that constraint was about the client-
// side TS/JS library on VeilPay, not the on-chain Rust CPI path).

use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked as spl_transfer_checked, Mint, Token, TokenAccount, TransferChecked};

#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_cpi<'info>(
    token_program: &Program<'info, Token>,
    source: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    destination: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: source.to_account_info(),
        mint: mint.to_account_info(),
        to: destination.to_account_info(),
        authority: authority.clone(),
    };
    let cpi_ctx = CpiContext::new(token_program.key(), cpi_accounts);
    spl_transfer_checked(cpi_ctx, amount, decimals)
}

#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_cpi_signed<'info>(
    token_program: &Program<'info, Token>,
    source: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    destination: &Account<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let cpi_accounts = TransferChecked {
        from: source.to_account_info(),
        mint: mint.to_account_info(),
        to: destination.to_account_info(),
        authority: authority.clone(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.key(),
        cpi_accounts,
        signer_seeds,
    );
    spl_transfer_checked(cpi_ctx, amount, decimals)
}
