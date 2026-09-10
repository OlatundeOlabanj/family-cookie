use anchor_lang::prelude::*;
use crate::errors::FamilyWalletError;
use crate::state::{FamilyVault, KeyRotationRequest, RotationStatus};

/// Backend-authority-signed, deliberately NOT passkey-verified: this
/// instruction moves no funds and grants no authority on its own — the
/// real security boundary is entirely downstream, at guardian approval
/// in approve_key_rotation. Requiring the LOST device's own passkey
/// signature here would also be circular (you can't sign with the
/// device you're reporting as lost), so this intentionally stays
/// backend-authenticated, same pattern as init_family_vault /
/// init_savings_goal. The backend's own account-recovery flow (outside
/// this program) is what actually verifies "this person is really
/// reporting their own lost device" before calling this instruction.
#[derive(Accounts)]
#[instruction(device_role: u8)]
pub struct RequestKeyRotation<'info> {
    #[account(mut)]
    pub backend_authority: Signer<'info>,

    pub vault: Account<'info, FamilyVault>,

    #[account(
        init,
        payer = backend_authority,
        space = KeyRotationRequest::SPACE,
        seeds = [b"rotation", vault.key().as_ref(), &[device_role]],
        bump
    )]
    pub rotation_request: Account<'info, KeyRotationRequest>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RequestKeyRotation>,
    device_role: u8,
    new_device_pubkey: [u8; 33],
) -> Result<()> {
    let lost_device_pubkey = match device_role {
        0 => ctx.accounts.vault.primary_contributor_device,
        1 => ctx.accounts.vault.partner_device,
        _ => return err!(FamilyWalletError::DeviceNotRegistered),
    };

    let rotation = &mut ctx.accounts.rotation_request;
    rotation.vault = ctx.accounts.vault.key();
    rotation.device_role = device_role;
    rotation.lost_device_pubkey = lost_device_pubkey;
    rotation.new_device_pubkey = new_device_pubkey;
    rotation.guardian = ctx.accounts.vault.guardian;
    rotation.status = RotationStatus::Pending;
    rotation.requested_at = Clock::get()?.unix_timestamp;
    rotation.approved_at = 0;
    rotation.bump = ctx.bumps.rotation_request;
    Ok(())
}
