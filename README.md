# Family Cookie

A savings goal wallet on Cookie Chain. You connect a wallet, create a goal
with a target amount and a deadline, fund a personal holding account, then
move money into the goal itself with a device passkey instead of a routine
wallet click. There is no swap, no price feed, no order book, and no
trading logic anywhere in the on-chain program.

Made by TJS Code.

## Why this exists

Most Cookie Chain app submissions in this round are swap terminals or
trading dashboards built around liquidity and price action. Family Cookie
is not one of those. It is built around a single mechanism: real money
moving toward a real goal, gated by a device passkey (secp256r1, verified
on-chain through Solana's own secp256r1 precompile and a WebAuthn-shaped
signature, not a seed phrase and not a routine wallet approval). The
on-chain program has zero trading instructions in it.

## What is live and proven right now

- App: `https://family-cookie-tjscode.netlify.app`
- Source: `https://github.com/OlatundeOlabanj/family-cookie`
- Cookie Chain program ID: `6tyoXrDQiqs6PCfc94sP1vV5v4h81DsWXaU5uCpwke9w`
- Cookie Chain RPC: `https://rpc.cookiescan.io`

The program is deployed and confirmed working on Cookie Chain. Four
separate `init_family_vault` calls were sent directly against it from a
plain Node and Anchor client, with no browser and no wallet extension in
the path, and all four landed as confirmed transactions:

- `5zjd9FsESFk7Emji3mEJqgeTBSrrYKmn7oKgXwQ9JpNhJBwxHxWkex5gdY6Gxef1PrxMDJrQM8xyJ319X1usxJww`
- `4pxikS9UDU3fJfR8T4foA1jM1Pagb4riXLT9tifVSwTjffpmrZrt3oJXt7e2diGWS9HCx1ZHnewuq6PEwhagg8bo`
- `384kxfpCyEfRPH3UarHbW5tTqjFBZKuK1ZcUqfcYoBAM6w3Tih8MZ5cRqvzdDjPy2riEfyEHFDKSnJNU9sjPqera`
- `277NcJ37LamcaHPm8FxjQaJhd2ybsNr4K7Sa5xPs9ahPpg9T2oYNa5XUsXBmtM6EBTdWXB7mDZGCkVgPfV78wbjN`

The passkey verification itself is real and already proven working end to
end on Solana devnet: `tests/04_passkey_flow.test.ts` registers a real
secp256r1 device key, signs a real WebAuthn-shaped challenge, and the
on-chain program verifies that signature through Solana's secp256r1
precompile before moving funds. That test also confirms the program
correctly rejects a signature from an unregistered device
(`UnauthorizedContributor`).

## Known issue: wallet-extension flow currently fails on Cookie Chain

The `contribute` and `init_family_vault` flow fails when triggered through
the Nightly wallet extension in the browser, even with the "Cookie" custom
network selected in Nightly and the app's own RPC connection correctly
pointed at `https://rpc.cookiescan.io`. Nightly's own popup shows
`"ProgramAccountNotFound"` and reports that its simulation of the
transaction would fail, for a program that is provably deployed and
working, as shown by the four signatures above.

This was diagnosed as follows, not guessed at:

1. `scripts/test-cookiechain-direct.ts` calls `init_family_vault` using
   the exact same Anchor program setup as the working devnet test, sent
   directly against Cookie Chain's RPC with no wallet involved. It
   succeeds every time.
2. `scripts/test-cookiechain-walletlike.ts` rebuilds the same call the way
   a wallet adapter actually constructs one: a v0 versioned transaction,
   an explicit blockhash fetch, and a client-side simulation before
   sending, the same shape Nightly's own popup runs before asking the
   user to approve. This also succeeds every time, with a clean
   simulation and a clean program log.
3. `frontend/js/wallet.js` was found to previously use the Wallet
   Standard's `signAndSendTransaction` feature, which hands the actual
   broadcast to the wallet itself, keyed on a `chain` identifier the app
   supplies. Cookie Chain has no standard chain identifier in the Wallet
   Standard's enum (only `mainnet`, `devnet`, `testnet`, and `localnet`
   are defined), so the code fell back to a literal `"solana:mainnet"`
   string. That fallback has been removed. The app now only asks the
   wallet to sign, then submits the signed transaction itself through the
   app's own `connection`, which is confirmed correct by points 1 and 2
   above.
4. A follow-up hypothesis, raised in code review: maybe the fix in point
   3 is one layer short, the app still doesn't pass a `chain` value at
   all to `signTransaction`, and some wallets use that value to decide
   what to preview/simulate internally before showing the approve
   dialog, even for a plain sign. Tested directly rather than argued
   about: `wallet.js` now inspects the connected wallet's own live
   `chains` array and passes through any single non-standard entry it
   finds there, logging exactly what it sees on every sign attempt.
   Confirmed via the browser console on a live, working deploy:

   ```
   [wallet] signing with chain: (none resolved — wallet reported only
   standard chains, or more than one non-standard chain)
   raw wallet.chains: ['solana:mainnet', 'solana:mainnet-beta',
   'solana:testnet', 'solana:devnet']
   ```

   Nightly's own Wallet Standard object reports exactly these four
   standard cluster names, and only these four, regardless of which
   custom network ("Cookie") is actually selected in its UI. There is no
   fifth, Cookie-Chain-specific value anywhere in what Nightly exposes.
   That closes this hypothesis with an answer rather than a shrug: there
   is no correct `chain` value this app (or any dApp) could pass to
   steer Nightly's internal simulation toward the right network, because
   Nightly does not expose one through the API surface available to a
   website. A `verifyConnectionGenesis()` check was still added as
   defense-in-depth (confirms the app's own `connection` is genuinely
   talking to Cookie Chain, comparing against its real genesis hash,
   `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2`), but it addresses a
   different, narrower risk than the one being chased here.

After that fix, and after the follow-up in point 4, the failure persists
unchanged, which means it is no longer inside this codebase, and there is
no further angle available to test from the dApp side. Nightly's own
popup fails its own simulation before this code is even reached, for a
program proven live on the exact RPC endpoint Nightly's custom network is
supposedly pointed at, and Nightly gives this app no information about
its internal network state to work with. The most likely remaining cause
is inside Nightly's own handling of custom SVM networks, something no
code change on this side can reach or fix. Other Cookie Chain
submissions built around this same class of risk independently: Cookie
Payouts notes that "wallets that broadcast through their own RPC would
send the transaction to Solana, where it never lands", and Cookie Bakery
notes "a wallet-side send would land on the wrong chain" for the same
reason, so this is a known shape of problem across more than one team
building on Cookie Chain through Nightly, not an isolated one.

This is being raised directly with Nightly and in the Cookie Chain
Telegram, with the two diagnostic scripts, the four working signatures,
and the console output above attached as proof that the program, the RPC
endpoint, and the app's own signing logic are not at fault.

## Architecture

### On-chain program (`programs/family-wallet/src`)

- `state.rs`: `FamilyVault`, `SavingsGoal`, `RecurringContributionDelegate`,
  `KeyRotationRequest`, `FeeConfig`
- `passkey.rs`: secp256r1 signature verification against the WebAuthn
  authenticator data and client data JSON supplied with each
  passkey-gated instruction
- `token_transfer.rs`: SPL `TransferChecked` CPI, both a plain `invoke`
  variant for user-signed transfers and an `invoke_signed` variant for
  PDA-authorized transfers used by the recurring contribution delegate
- `instructions/`: `init_family_vault`, `init_savings_goal`, `contribute`,
  `withdraw`, `authorize_recurring_delegate`,
  `execute_recurring_contribution`, `request_key_rotation`,
  `approve_key_rotation`, `init_fee_config`

### Frontend (`frontend/`)

Plain HTML, CSS, and JavaScript, no framework. Wallet connection goes
through the Solana Wallet Standard, with Nightly as the primary supported
wallet.

- `js/config.js`: cluster configuration for both Solana devnet and Cookie
  Chain, including the separate WebSocket host Cookie Chain uses
  (`wss://ws.cookiescan.io`, distinct from its RPC host)
- `js/wallet.js`: Wallet Standard discovery and the sign-then-submit flow
  described above
- `js/anchor.js`: builds and submits the actual program instructions
- `js/passkey.js`: browser WebAuthn calls for registering and asserting
  the device passkey
- `js/app.js`: page state and UI wiring for the dashboard

### Diagnostic scripts (`scripts/`)

- `test-cookiechain-direct.ts`: minimal direct call to `init_family_vault`
  against Cookie Chain, bypassing the browser entirely
- `test-cookiechain-walletlike.ts`: the same call built the way a wallet
  adapter builds one, versioned transaction, explicit blockhash, and a
  client-side simulation before sending

Both take the signer keypair from `~/.config/solana/cookiechain-deployer.json`
and print the complete raw success or error response, nothing caught or
simplified.

## Running this locally

```bash
npm install
npm test                          # Anchor test suite, devnet
npm run test:cookiechain-direct       # direct diagnostic against Cookie Chain
npm run test:cookiechain-walletlike   # wallet-shaped diagnostic against Cookie Chain
```

The frontend is static and can be served from `frontend/` with any static
file server, or deployed as is to Netlify, which is how the live
deployment above is hosted (`netlify.toml` is included in the repo).

## What is not built yet

- The recurring contribution scheduler runs on-demand through
  `execute_recurring_contribution` rather than as an automated cron job.
- CookieScan does not currently expose a documented public API, so the
  in-app contribution history is read directly from the chain's own RPC
  rather than through a CookieScan integration.
- A swap step for converting USDC or SOL into COOK before depositing
  (the optional v2 direction mentioned in the original bounty scope) has
  not been built, in favor of fully proving the core deposit and
  passkey-verification path first.
