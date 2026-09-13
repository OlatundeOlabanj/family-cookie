import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
} from "@solana/spl-token";
import {
  getProgram,
  loadTestWallet,
  deriveFeeConfigPda,
  deriveVaultPda,
  deriveGoalPda,
  deriveWalletAuthorityPda,
  deriveDelegatePda,
  ensureAta,
  generateDeviceKeypair,
  signForInstruction,
} from "./helpers";
import { DEVNET_USDC_MINT, USDC_DECIMALS } from "../scripts/constants";

const DEVICE_ROLE_PRIMARY = 0;

// REWRITTEN against the current calling convention. authorize_recurring_
// delegate now takes (device_role, amount_per_period, frequency,
// next_run_at, authenticator_data, client_data_json) and is passkey-
// gated (the old convention called it with 3 args and a plain
// `contributor: Signer`, which no longer exists on this instruction.
// init_savings_goal had the same mint-as-argument bug as in
// 01_setup_and_contribute.test.ts. The execute_recurring_contribution
// calls further down were already correct against the current API,
// that instruction's signature/accounts haven't changed, so only the
// setup needed fixing.
describe("family-wallet: recurring contribution (delegated authority), highest risk", () => {
  const { program, provider } = getProgram();
  const connection = provider.connection;
  const mainWallet = (provider.wallet as anchor.Wallet).payer;

  const bank = loadTestWallet("bank"); // dedicated funding source, not a persona wallet
  const partner = loadTestWallet("partner");
  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");

  const device = generateDeviceKeypair();
  const partnerDevicePlaceholder = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 3)]);
  const vaultSeedKp = Keypair.generate();

  const [feeConfigPda] = deriveFeeConfigPda();
  const [vaultPda] = deriveVaultPda(vaultSeedKp.publicKey);
  const [goalPda] = deriveGoalPda(vaultPda, 0);
  const [walletAuthorityPda] = deriveWalletAuthorityPda(vaultPda, DEVICE_ROLE_PRIMARY);
  const [delegatePda] = deriveDelegatePda(goalPda);

  const AMOUNT_PER_PERIOD = 1 * 10 ** USDC_DECIMALS;

  let feeDestinationUsdcAta: PublicKey;
  let goalUsdcAta: PublicKey;
  let walletAuthorityUsdcAta: PublicKey;

  before(async () => {
    feeDestinationUsdcAta = await ensureAta(
      connection,
      feeDestinationOwner,
      DEVNET_USDC_MINT,
      feeDestinationOwner.publicKey
    );

    await program.methods
      .initFamilyVault(
        vaultSeedKp.publicKey,
        Array.from(device.compressedPubkey),
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

    goalUsdcAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, goalPda, true);
    const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    await program.methods
      .initSavingsGoal(
        "Recurring Test Goal",
        new anchor.BN(1000 * 10 ** USDC_DECIMALS),
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

    // Fund the device's wallet_authority PDA with just enough USDC to
    // cover this file's transfers. Only ONE test below actually moves
    // funds (the due-execution test; ScheduleNotDue and the redirect
    // test both fail before any transfer), and that one execution
    // moves AMOUNT_PER_PERIOD plus a small standard-tier fee, so 2x
    // AMOUNT_PER_PERIOD is ample headroom. Funded from `bank`, a
    // dedicated fuel wallet, not a persona, since vault/device setup
    // is fresh per run now (not idempotent/reused like the old
    // convention was), so this really does spend real funds every
    // single `anchor test` run. See the funding note in
    // check-funding.ts; re-run `npm run check-funding` periodically
    // and top up `bank` via the devnet USDC faucet if it's low.
    walletAuthorityUsdcAta = await ensureAta(connection, mainWallet, DEVNET_USDC_MINT, walletAuthorityPda);
    const bankAta = await ensureAta(connection, bank, DEVNET_USDC_MINT, bank.publicKey);
    await provider.sendAndConfirm(
      new Transaction().add(
        createTransferInstruction(
          bankAta,
          walletAuthorityUsdcAta,
          bank.publicKey,
          AMOUNT_PER_PERIOD * 2
        )
      ),
      [bank]
    );

    // Authorize the recurring schedule via a real passkey signature.
    // This exact instruction/assertion (authorize_recurring_delegate
    // succeeding and granting real SPL Approve authority) is already
    // covered by 04_passkey_flow.test.ts, so it isn't re-asserted as
    // its own "it" here; this call exists purely as setup, to get a
    // live delegate for the execute_recurring_contribution tests below.
    const dueInOneSecond = Math.floor(Date.now() / 1000) + 1;
    const placeholder = await program.methods
      .authorizeRecurringDelegate(
        DEVICE_ROLE_PRIMARY,
        new anchor.BN(AMOUNT_PER_PERIOD),
        { weekly: {} },
        new anchor.BN(dueInOneSecond),
        Buffer.from([0]),
        Buffer.from([0])
      )
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
        sourceTokenAccount: walletAuthorityUsdcAta,
        walletAuthority: walletAuthorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const proof = await signForInstruction(placeholder, 1 + 8 + 1 + 8, device.privateKey, device.compressedPubkey);
    const realIx = await program.methods
      .authorizeRecurringDelegate(
        DEVICE_ROLE_PRIMARY,
        new anchor.BN(AMOUNT_PER_PERIOD),
        { weekly: {} },
        new anchor.BN(dueInOneSecond),
        proof.authenticatorData,
        proof.clientDataJson
      )
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
        sourceTokenAccount: walletAuthorityUsdcAta,
        walletAuthority: walletAuthorityPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(proof.precompileIx).add(realIx));
  });

  it("rejects authorizing a schedule against a token account the signing device doesn't own", async () => {
    // The ownership `require!` in authorize_recurring_delegate's
    // handler runs before passkey verification, so this fails before
    // ever checking a signature, so no real proof needs to be built for
    // this call, just the real instruction/account shape.
    const partnerUsdcAta = await ensureAta(connection, partner, DEVNET_USDC_MINT, partner.publicKey);
    const [otherGoalPda] = deriveGoalPda(vaultPda, 1);
    const otherGoalUsdcAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, otherGoalPda, true);
    const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

    await program.methods
      .initSavingsGoal(
        "Ownership Check Goal",
        new anchor.BN(1000 * 10 ** USDC_DECIMALS),
        { usdc: {} },
        new anchor.BN(oneYearFromNow)
      )
      .accounts({
        backendAuthority: mainWallet.publicKey,
        vault: vaultPda,
        goal: otherGoalPda,
        goalTokenAccount: otherGoalUsdcAta,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    const [otherDelegatePda] = deriveDelegatePda(otherGoalPda);

    try {
      await program.methods
        .authorizeRecurringDelegate(
          DEVICE_ROLE_PRIMARY,
          new anchor.BN(AMOUNT_PER_PERIOD),
          { weekly: {} },
          new anchor.BN(Math.floor(Date.now() / 1000) + 1),
          Buffer.from([0]),
          Buffer.from([0])
        )
        .accounts({
          payer: mainWallet.publicKey,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
          vault: vaultPda,
          goal: otherGoalPda,
          delegate: otherDelegatePda,
          // owned by partner's own wallet, not the primary device's
          // wallet_authority PDA; this is the ownership mismatch.
          sourceTokenAccount: partnerUsdcAta,
          walletAuthority: walletAuthorityPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("expected UnauthorizedContributor error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedContributor");
    }
  });

  it("anyone (a keeper, not primary/partner) can execute a due recurring contribution", async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const before = await getAccount(connection, goalUsdcAta);

    await program.methods
      .executeRecurringContribution(USDC_DECIMALS)
      .accounts({
        keeper: provider.wallet.publicKey,
        feeConfig: feeConfigPda,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
        goalTokenAccount: goalUsdcAta,
        feeDestination: feeDestinationUsdcAta,
        sourceTokenAccount: walletAuthorityUsdcAta,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const after = await getAccount(connection, goalUsdcAta);
    expect(Number(after.amount) - Number(before.amount)).to.equal(AMOUNT_PER_PERIOD);
  });

  it("rejects a second execution before the next period is due (ScheduleNotDue)", async () => {
    try {
      await program.methods
        .executeRecurringContribution(USDC_DECIMALS)
        .accounts({
          keeper: provider.wallet.publicKey,
          feeConfig: feeConfigPda,
          vault: vaultPda,
          goal: goalPda,
          delegate: delegatePda,
          goalTokenAccount: goalUsdcAta,
          feeDestination: feeDestinationUsdcAta,
          sourceTokenAccount: walletAuthorityUsdcAta,
          mint: DEVNET_USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("expected ScheduleNotDue error");
    } catch (err: any) {
      expect(err.toString()).to.include("ScheduleNotDue");
    }
  });

  it("cannot redirect execution to a different source token account than the one registered", async () => {
    const partnerUsdcAta = await ensureAta(connection, partner, DEVNET_USDC_MINT, partner.publicKey);
    try {
      await program.methods
        .executeRecurringContribution(USDC_DECIMALS)
        .accounts({
          keeper: provider.wallet.publicKey,
          feeConfig: feeConfigPda,
          vault: vaultPda,
          goal: goalPda,
          delegate: delegatePda,
          goalTokenAccount: goalUsdcAta,
          feeDestination: feeDestinationUsdcAta,
          sourceTokenAccount: partnerUsdcAta,
          mint: DEVNET_USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("expected a ConstraintAddress error");
    } catch (err: any) {
      expect(err.toString()).to.match(/ConstraintAddress|Address/i);
    }
  });
});
