use anchor_lang::prelude::*;
use crate::errors::FamilyWalletError;
use crate::state::{FamilyVault, KeyRotationRequest, RotationStatus};
/// Guardian-alone approval, per locked v1 decision (no partner veto
/// window). This single instruction both approves AND executes the
/// rotation atomically — swapping the registered device pubkey for
/// the new one directly on FamilyVault. Splitting "approve" and
/// "execute" into two separate txs would only add a race-condition
/// window without adding real security, since the guardian signature
/// IS the authorization.
#[derive(Accounts)]
pub struct ApproveKeyRotation<'info> {
    pub guardian: Signer<'info>,
    #[account(
        mut,
        has_one = guardian,
    )]
    pub vault: Account<'info, FamilyVault>,
    #[account(
        mut,
        seeds = [b"rotation", vault.key().as_ref(), &[rotation_request.device_role]],
        bump = rotation_request.bump,
        has_one = vault,
        has_one = guardian,
    )]
    pub rotation_request: Account<'info, KeyRotationRequest>,
}
pub fn handler(ctx: Context<ApproveKeyRotation>) -> Result<()> {
    require!(
        ctx.accounts.rotation_request.status == RotationStatus::Pending,
        FamilyWalletError::RotationNotPending
    );
    let new_device = ctx.accounts.rotation_request.new_device_pubkey;
    let device_role = ctx.accounts.rotation_request.device_role;
    let vault = &mut ctx.accounts.vault;
    match device_role {
        0 => vault.primary_contributor_device = new_device,
        1 => vault.partner_device = new_device,
        _ => return err!(FamilyWalletError::DeviceNotRegistered),
    }
    let rotation = &mut ctx.accounts.rotation_request;
    rotation.status = RotationStatus::Executed;
    rotation.approved_at = Clock::get()?.unix_timestamp;
    Ok(())
}
