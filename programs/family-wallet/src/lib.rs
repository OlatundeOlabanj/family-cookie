// Family Wallet, Anchor program entrypoint (v1 draft)
// Made by TJS Code

use anchor_lang::prelude::*;

pub mod errors;
pub mod fee;
pub mod instructions;
pub mod passkey;
pub mod state;
pub mod token_transfer;

use instructions::*;
use state::{Currency, FeeTier, Frequency};

// TODO: replace with the real deployed program ID once `anchor keys sync`
// (or `solana address -k target/deploy/family_wallet-keypair.json`) has
// been run on your machine — this placeholder will not deploy correctly.
declare_id!("6apQZUxBwpBbFNiBpYzGeMBQJ8328xrrsQ3aRcQhM2Av");

#[program]
pub mod family_wallet {
    use super::*;

    pub fn init_fee_config(
        ctx: Context<InitFeeConfig>,
        standard_fee_amount: u64,
        founding_fee_amount: u64,
    ) -> Result<()> {
        instructions::init_fee_config::handler(ctx, standard_fee_amount, founding_fee_amount)
    }

    pub fn init_family_vault(
        ctx: Context<InitFamilyVault>,
        vault_seed: Pubkey,
        primary_contributor_device: [u8; 33],
        partner_device: [u8; 33],
        guardian: Pubkey,
        fee_tier: FeeTier,
        fee_destination: Pubkey,
    ) -> Result<()> {
        instructions::init_family_vault::handler(
            ctx,
            vault_seed,
            primary_contributor_device,
            partner_device,
            guardian,
            fee_tier,
            fee_destination,
        )
    }

    pub fn init_savings_goal(
        ctx: Context<InitSavingsGoal>,
        name: String,
        target_amount: u64,
        currency: Currency,
        deadline: i64,
    ) -> Result<()> {
        instructions::init_savings_goal::handler(ctx, name, target_amount, currency, deadline)
    }

    pub fn contribute(
        ctx: Context<Contribute>,
        device_role: u8,
        amount: u64,
        decimals: u8,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::contribute::handler(
            ctx,
            device_role,
            amount,
            decimals,
            authenticator_data,
            client_data_json,
        )
    }

    pub fn authorize_recurring_delegate(
        ctx: Context<AuthorizeRecurringDelegate>,
        device_role: u8,
        amount_per_period: u64,
        frequency: Frequency,
        next_run_at: i64,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::authorize_recurring_delegate::handler(
            ctx,
            device_role,
            amount_per_period,
            frequency,
            next_run_at,
            authenticator_data,
            client_data_json,
        )
    }

    pub fn execute_recurring_contribution(
        ctx: Context<ExecuteRecurringContribution>,
        decimals: u8,
    ) -> Result<()> {
        instructions::execute_recurring_contribution::handler(ctx, decimals)
    }

    pub fn cancel_recurring_delegate(
        ctx: Context<CancelRecurringDelegate>,
        device_role: u8,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::cancel_recurring_delegate::handler(
            ctx,
            device_role,
            authenticator_data,
            client_data_json,
        )
    }


    pub fn request_key_rotation(
        ctx: Context<RequestKeyRotation>,
        device_role: u8,
        new_device_pubkey: [u8; 33],
    ) -> Result<()> {
        instructions::request_key_rotation::handler(ctx, device_role, new_device_pubkey)
    }

    pub fn approve_key_rotation(ctx: Context<ApproveKeyRotation>) -> Result<()> {
        instructions::approve_key_rotation::handler(ctx)
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        device_role: u8,
        amount: u64,
        decimals: u8,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::withdraw::handler(
            ctx,
            device_role,
            amount,
            decimals,
            authenticator_data,
            client_data_json,
        )
    }
}
