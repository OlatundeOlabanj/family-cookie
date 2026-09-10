use anchor_lang::prelude::*;
use crate::errors::FamilyWalletError;
use crate::passkey::verify_passkey_authorization;
use crate::state::{FamilyVault, RecurringContributionDelegate, SavingsGoal};

/// Either registered device can cancel a recurring schedule. Closing
/// the account (rather than just flipping status to Cancelled)
/// reclaims rent and, just as importantly, means
/// execute_recurring_contribution can never succeed against it again
/// — Anchor's Account<'info, T> validation requires the account to
/// still exist and deserialize correctly, so a closed delegate is a
/// hard stop, not just a status flag someone could theoretically
/// route around.
///
/// Note for hygiene: this does NOT revoke the underlying SPL Token
/// `Approve` grant on the source token account — that approval
/// technically still exists until revoked or replaced. Harmless in
/// practice since this program's instructions require the delegate
/// account to exist, but worth a client-side Revoke too for full
/// cleanliness.
#[derive(Accounts)]
#[instruction(device_role: u8)]
pub struct CancelRecurringDelegate<'info> {
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
        mut,
        seeds = [b"delegate", goal.key().as_ref()],
        bump = delegate.bump,
        has_one = goal,
        has_one = vault,
        close = payer,
    )]
    pub delegate: Box<Account<'info, RecurringContributionDelegate>>,
}

pub fn handler(
    ctx: Context<CancelRecurringDelegate>,
    device_role: u8,
    authenticator_data: Vec<u8>,
    client_data_json: Vec<u8>,
) -> Result<()> {
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
        1,
    )?;

    Ok(())
}
