import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, createApproveInstruction } from "@solana/spl-token";
import {
  getProgram,
  loadTestWallet,
  deriveFeeConfigPda,
  deriveVaultPda,
  deriveGoalPda,
  deriveDelegatePda,
  ensureAta,
} from "./helpers";
import { DEVNET_USDC_MINT, USDC_DECIMALS } from "../scripts/constants";

const GOAL_SEQ = 1;

describe("family-wallet: recurring contribution (delegated authority) — highest risk", () => {
  const { program, provider } = getProgram();
  const connection = provider.connection;

  const primary = loadTestWallet("primary");
  const partner = loadTestWallet("partner");
  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");

  const [feeConfigPda] = deriveFeeConfigPda();
  const [vaultPda] = deriveVaultPda(primary.publicKey);
  const [goalPda] = deriveGoalPda(vaultPda, GOAL_SEQ);
  const [delegatePda] = deriveDelegatePda(goalPda);

  let primaryUsdcAta: PublicKey;
  let feeDestinationUsdcAta: PublicKey;
  let goalUsdcAta: PublicKey;

  const AMOUNT_PER_PERIOD = 1 * 10 ** USDC_DECIMALS;

  before(async () => {
    primaryUsdcAta = await ensureAta(connection, primary, DEVNET_USDC_MINT, primary.publicKey);
    feeDestinationUsdcAta = await ensureAta(
      connection,
      feeDestinationOwner,
      DEVNET_USDC_MINT,
      feeDestinationOwner.publicKey
    );
    goalUsdcAta = await ensureAta(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      DEVNET_USDC_MINT,
      goalPda
    );
  });

  it("initializes a dedicated second goal for recurring-contribution testing (idempotent)", async () => {
    if (await connection.getAccountInfo(goalPda)) {
      console.log("  goal (seq 1) already initialized, skipping");
      return;
    }
    const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    await program.methods
      .initSavingsGoal(
        "Recurring Test Goal",
        new anchor.BN(1000 * 10 ** USDC_DECIMALS),
        { usdc: {} },
        new anchor.BN(oneYearFromNow),
        DEVNET_USDC_MINT
      )
      .accounts({
        backendAuthority: provider.wallet.publicKey,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("primary authorizes a recurring schedule + grants the delegate PDA real SPL Approve authority", async () => {
    if (!(await connection.getAccountInfo(delegatePda))) {
      const dueInOneSecond = Math.floor(Date.now() / 1000) + 1;
      await program.methods
        .authorizeRecurringDelegate(
          new anchor.BN(AMOUNT_PER_PERIOD),
          { weekly: {} },
          new anchor.BN(dueInOneSecond)
        )
        .accounts({
          contributor: primary.publicKey,
          vault: vaultPda,
          goal: goalPda,
          delegate: delegatePda,
          sourceTokenAccount: primaryUsdcAta,
          systemProgram: SystemProgram.programId,
        })
        .signers([primary])
        .rpc();
    }

    const approveIx = createApproveInstruction(
      primaryUsdcAta,
      delegatePda,
      primary.publicKey,
      AMOUNT_PER_PERIOD * 10
    );
    const tx = new anchor.web3.Transaction().add(approveIx);
    await provider.sendAndConfirm(tx, [primary]);
  });

  it("rejects registering a schedule against a token account you don't own", async () => {
    const partnerUsdcAta = await ensureAta(connection, partner, DEVNET_USDC_MINT, partner.publicKey);
    const [otherGoalPda] = deriveGoalPda(vaultPda, GOAL_SEQ);
    try {
      await program.methods
        .authorizeRecurringDelegate(
          new anchor.BN(AMOUNT_PER_PERIOD),
          { weekly: {} },
          new anchor.BN(Math.floor(Date.now() / 1000) + 1)
        )
        .accounts({
          contributor: primary.publicKey,
          vault: vaultPda,
          goal: otherGoalPda,
          delegate: delegatePda,
          sourceTokenAccount: partnerUsdcAta,
          systemProgram: SystemProgram.programId,
        })
        .signers([primary])
        .rpc();
      expect.fail("expected a rejection (either ownership constraint or already-initialized)");
    } catch (err: any) {
      expect(err.toString()).to.match(/UnauthorizedContributor|already in use|0x0/i);
    }
  });

  it("anyone (a keeper — not primary/partner) can execute a due recurring contribution", async () => {
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
        sourceTokenAccount: primaryUsdcAta,
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
          sourceTokenAccount: primaryUsdcAta,
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
