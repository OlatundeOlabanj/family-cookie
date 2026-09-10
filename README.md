# Family Cookie

Cookie Chain bounty submission built on the `family_wallet` Anchor program: a
savings-goal wallet where contributions are authorized by a device passkey,
not a routine wallet click. The same program deploys to Solana devnet and to
Cookie Chain. The underlying product name is still undecided; `family_wallet`
stays the crate/program identifier regardless of what this submission is
called.

Made by TJS Code

Note: the sections below are the original phase-1, backend-only draft notes
and are now stale in places (they predate passkey verification actually
being implemented, and predate the frontend and the Cookie Chain port). A
full rewrite covering setup end-to-end is still pending as a separate pass.

## What's in this folder

`programs/family-wallet/src/` — the full v1 account structs + instruction
set, compiled and verified with `cargo check` / `cargo build --lib`
against `anchor-lang = 0.29.0` in this sandbox.

- `state.rs` — FeeConfig, FamilyVault, SavingsGoal,
  RecurringContributionDelegate, KeyRotationRequest
- `errors.rs` — custom error codes
- `fee.rs` — fee-tier resolution (FeeConfig lookup)
- `token_transfer.rs` — hand-rolled SPL TransferChecked CPI (both a plain
  `invoke` variant for user-signed transfers, and an `invoke_signed`
  variant for PDA-authorized transfers — used by the recurring delegate)
- `instructions/` — one file per instruction:
  `init_fee_config`, `init_family_vault`, `init_savings_goal`,
  `contribute`, `authorize_recurring_delegate`,
  `execute_recurring_contribution`, `request_key_rotation`,
  `approve_key_rotation`, `withdraw`

## What was actually verified here, and what wasn't

This sandbox has no network access to Solana's or Rust's own install
servers (`static.rust-lang.org`, `release.solana.com`), and its Ubuntu
package archive only offers `rustc 1.75`. So:

**Verified here:** the code compiles — real `rustc` + real `anchor-lang`
+ real `spl-token`, `cargo build --lib` succeeds with zero warnings.
Every account struct, every constraint (`has_one`, `seeds`, `address`),
every CPI call, borrows correctly and type-checks.

**NOT verified here, needs your machine:**
- `anchor build` (BPF/SBF target compilation — needs the Solana BPF
  toolchain, not available in this sandbox)
- `anchor test` (local validator + the actual instruction logic running
  against real accounts — this is where the delegated-authority and
  key-rotation adversarial tests belong, per your testing approach)
- IDL generation
- Devnet deployment

## Running this for real, on your Fedora machine

```bash
# from inside this folder
anchor build
anchor keys sync          # updates declare_id! to your real program keypair
anchor test                # spins up a local validator, runs tests/
```

You likely have a modern rustc already (this sandbox was stuck on 1.75,
which is why `anchor-lang` is pinned to `0.29.0` and several transitive
deps are pinned lower than latest in `Cargo.lock`). On your machine you
can probably delete `Cargo.lock`, bump `anchor-lang` back to `"0.30.1"`
in `Cargo.toml`, and let cargo resolve fresh — no need to inherit this
sandbox's version ceiling.

## Known TODOs before this is test-ready, not just compile-ready

1. **`declare_id!`** — currently a randomly generated placeholder
   pubkey. Run `anchor keys sync` to replace it with your program's
   real deploy keypair.
2. **Passkey (secp256r1) verification** — not implemented. Every
   instruction that should ultimately require a passkey signature
   currently trusts a `backend_authority` / `Signer` account instead,
   with a `TODO(passkey)` comment marking the seam. This needs its own
   design pass (Lazorkit/Turnkey integration, or hand-rolled against
   Solana's secp256r1 precompile) before mainnet.
3. **`init_savings_goal`'s `goal_token_account`** — currently an
   `UncheckedAccount` validated off-chain. Needs a real PDA-owned SPL
   token account creation flow (who's the token account's authority?
   Likely the `goal` PDA itself, matching the withdraw instruction's
   assumption — confirm and wire up the actual `InitializeAccount3`
   CPI in `init_savings_goal`).
4. **`execute_recurring_contribution`'s `source_token_account`** — the
   backend must pass the correct contributor token account; there's no
   on-chain mapping from `delegate.authorized_by` to a specific token
   account address yet. Worth adding that field to
   `RecurringContributionDelegate` so the constraint can be enforced
   on-chain instead of trusted from the caller.
5. **No tests yet** — Anchor unit/integration tests (TypeScript,
   `tests/`) haven't been written. Given your testing approach, the
   next work session should prioritize adversarial tests for
   `execute_recurring_contribution` and `approve_key_rotation` first.
