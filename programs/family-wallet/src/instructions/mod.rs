pub mod approve_key_rotation;
pub mod authorize_recurring_delegate;
pub mod cancel_recurring_delegate;
pub mod contribute;
pub mod execute_recurring_contribution;
pub mod init_family_vault;
pub mod init_fee_config;
pub mod init_savings_goal;
pub mod request_key_rotation;
pub mod withdraw;

// NOTE: glob re-exports are required here — Anchor's #[derive(Accounts)]
// macro generates a `__client_accounts_*` module alongside each Accounts
// struct, and #[program] in lib.rs expects those surfaced via
// `instructions::*`. This does cause an "ambiguous glob re-exports"
// warning (every module also exports a `handler` fn with the same
// name) — harmless, since lib.rs calls each handler through a fully
// qualified path (instructions::contribute::handler(...), etc.), never
// through the ambiguous unqualified glob import. Suppressed below.
#[allow(ambiguous_glob_reexports)]
mod reexports {
    pub use super::approve_key_rotation::*;
    pub use super::authorize_recurring_delegate::*;
    pub use super::cancel_recurring_delegate::*;
    pub use super::contribute::*;
    pub use super::execute_recurring_contribution::*;
    pub use super::init_family_vault::*;
    pub use super::init_fee_config::*;
    pub use super::init_savings_goal::*;
    pub use super::request_key_rotation::*;
    pub use super::withdraw::*;
}
pub use reexports::*;
