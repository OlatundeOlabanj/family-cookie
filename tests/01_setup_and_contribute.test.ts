import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { PublicKey, SystemProgram, Keypair, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  getProgram,
  loadTestWallet,
  deriveFeeConfigPda,
  deriveVaultPda,
  deriveGoalPda,
  deriveWalletAuthorityPda,
  ensureAta,
  generateDeviceKeypair,
} from "./helpers";
import { DEVNET_USDC_MINT, USDC_DECIMALS } from "../scripts/constants";

// REWRITTEN against the current calling convention. The original
// version of this file called init_savings_goal with the mint as a
// 5th *instruction argument* (the real handler takes 4 args (name,
// target_amount, currency, deadline) and expects `mint` as an
// *account*, alongside `associated_token_program`, which this file was
// also missing). It also called init_family_vault with only 5 args
// and treated `primary`/`partner` as plain wallet Pubkeys; the real
// vault stores each as a 33-byte secp256r1 *passkey device* pubkey
// (registered contributors sign via WebAuthn/secp256r1, not a normal
// Solana keypair; see programs/family-wallet/src/passkey.rs), and
// takes a dedicated `vault_seed` as its first argument rather than
// reusing a contributor's own pubkey.
describe("family-wallet: setup + manual contribution", () => {
  const { program, provider } = getProgram();
  const connection = provider.connection;
  const mainWallet = (provider.wallet as anchor.Wallet).payer;

  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");

  // A fresh vault per test run, exactly like 04_passkey_flow.test.ts:
  // vault_seed is deliberately just a throwaway nonce (see the doc
  // comment on FamilyVault.vault_seed in state.rs), so there's nothing
  // to persist/idempotency-check across runs the way the old
  // primary-pubkey-as-seed convention allowed.
  const vaultSeedKp = Keypair.generate();
  const primaryDevice = generateDeviceKeypair();
  // Partner's device isn't exercised in this file (no contribute/
  // withdraw call is made against it here), so a fixed placeholder
  // compressed-point-shaped value is enough to satisfy the [u8; 33]
  // account layout.
  const partnerDevicePlaceholder = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 7)]);

  const [feeConfigPda] = deriveFeeConfigPda();
  const [vaultPda] = deriveVaultPda(vaultSeedKp.publicKey);
  const [goalPda] = deriveGoalPda(vaultPda, 0);

  let feeDestinationUsdcAta: PublicKey;
  let goalUsdcAta: PublicKey;

  before(async () => {
    feeDestinationUsdcAta = await ensureAta(
      connection,
      feeDestinationOwner,
      DEVNET_USDC_MINT,
      feeDestinationOwner.publicKey
    );
  });

  it("initializes the fee config (idempotent, skips if it already exists)", async () => {
    // fee_config is a true program-wide singleton (seeds = [b"fee_config"]),
    // so, unlike the vault/goal below, it genuinely can already exist
    // from a prior run, and this idempotency check is still correct.
    if (await connection.getAccountInfo(feeConfigPda)) {
      console.log("  fee_config already initialized, skipping");
      return;
    }
    await program.methods
      .initFeeConfig(new anchor.BN(1_000), new anchor.BN(0))
      .accounts({
        admin: provider.wallet.publicKey,
        feeConfig: feeConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("initializes the family vault with registered primary/partner passkey devices", async () => {
    await program.methods
      .initFamilyVault(
        vaultSeedKp.publicKey,
        Array.from(primaryDevice.compressedPubkey),
        Array.from(partnerDevicePlaceholder),
        guardian.publicKey,
        { standard: {} },
        feeDestinationUsdcAta
      )
      .accounts({
        backendAuthority: mainWallet.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultAccount: any = await program.account.familyVault.fetch(vaultPda);
    expect(Buffer.from(vaultAccount.primaryContributorDevice)).to.deep.equal(
      primaryDevice.compressedPubkey
    );
    expect(vaultAccount.guardian.toBase58()).to.equal(guardian.publicKey.toBase58());
  });

  it("initializes the savings goal in USDC", async () => {
    goalUsdcAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, goalPda, true);
    const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    await program.methods
      .initSavingsGoal(
        "Family Trip",
        new anchor.BN(100 * 10 ** USDC_DECIMALS),
        { usdc: {} },
        new anchor.BN(oneYearFromNow)
      )
      .accounts({
        backendAuthority: mainWallet.publicKey,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const goalAccount: any = await program.account.savingsGoal.fetch(goalPda);
    expect(goalAccount.targetAmount.toString()).to.equal(
      (100 * 10 ** USDC_DECIMALS).toString()
    );
  });

  // The old "primary can contribute manually" test here exercised
  // exactly the same instruction, with the same account shape, as
  // 04_passkey_flow.test.ts's "contribute: a real passkey signature
  // moves funds into the goal" test. There is no distinct manual/
  // non-passkey contribution path anymore; every contribute() call
  // is passkey-authorized, so that coverage is not duplicated here;
  // it lives solely in 04_passkey_flow.test.ts.

  it("rejects contribute() called with a device_role that isn't 0 (primary) or 1 (partner)", async () => {
    // Distinct from 04's "wrong device" rejection test: that one uses
    // a *valid* device_role (0) with an impostor signature, caught by
    // verify_passkey_authorization's pubkey comparison. This one uses
    // an out-of-range device_role, which contribute()'s handler
    // rejects in its role->pubkey match *before* it ever looks at the
    // passkey proof, so no real secp256r1 signature is needed here.
    const invalidDeviceRole = 2;
    const [walletAuthorityPda] = deriveWalletAuthorityPda(vaultPda, invalidDeviceRole);

    // A distinct, real token account, owned by neither the goal nor
    // fee_destination; reusing feeDestinationUsdcAta here previously
    // caused the *same account* to be passed as two different named
    // accounts (fee_destination and contributor_token_account) in one
    // instruction, which fails Anchor's own account validation before
    // the handler's device_role check ever runs. Guardian already has
    // devnet SOL to pay for its own ATA if it doesn't exist yet.
    const guardianUsdcAta = await ensureAta(connection, guardian, DEVNET_USDC_MINT, guardian.publicKey);

    try {
      await program.methods
        .contribute(
          invalidDeviceRole,
          new anchor.BN(1 * 10 ** USDC_DECIMALS),
          USDC_DECIMALS,
          Buffer.from([0]),
          Buffer.from([0])
        )
        .accounts({
          payer: mainWallet.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          feeConfig: feeConfigPda,
          vault: vaultPda,
          goal: goalPda,
          goalTokenAccount: goalUsdcAta,
          feeDestination: feeDestinationUsdcAta,
          contributorTokenAccount: guardianUsdcAta,
          walletAuthority: walletAuthorityPda,
          mint: DEVNET_USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("expected UnauthorizedContributor error");
    } catch (err: any) {
      const message = err.toString();
      if (!message.includes("UnauthorizedContributor")) {
        // Surface the full error if the failure mode isn't the one we
        // expect, instead of a chai-truncated one-liner, so a future
        // failure here is actually debuggable in one shot.
        console.log("Full error from contribute() rejection test:\n", message);
      }
      expect(message).to.include("UnauthorizedContributor");
    }
  });
});
