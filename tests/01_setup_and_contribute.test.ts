import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import {
  getProgram,
  loadTestWallet,
  deriveFeeConfigPda,
  deriveVaultPda,
  deriveGoalPda,
  ensureAta,
} from "./helpers";
import { DEVNET_USDC_MINT, USDC_DECIMALS } from "../scripts/constants";

describe("family-wallet: setup + manual contribution", () => {
  const { program, provider } = getProgram();
  const connection = provider.connection;

  const primary = loadTestWallet("primary");
  const partner = loadTestWallet("partner");
  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");

  const [feeConfigPda] = deriveFeeConfigPda();
  const [vaultPda] = deriveVaultPda(primary.publicKey);
  const [goalPda] = deriveGoalPda(vaultPda, 0);

  let primaryUsdcAta: PublicKey;
  let partnerUsdcAta: PublicKey;
  let feeDestinationUsdcAta: PublicKey;
  let goalUsdcAta: PublicKey;

  before(async () => {
    primaryUsdcAta = await ensureAta(connection, primary, DEVNET_USDC_MINT, primary.publicKey);
    partnerUsdcAta = await ensureAta(connection, partner, DEVNET_USDC_MINT, partner.publicKey);
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

  it("initializes the fee config (idempotent — skips if it already exists)", async () => {
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

  it("initializes the family vault (idempotent)", async () => {
    if (await connection.getAccountInfo(vaultPda)) {
      console.log("  vault already initialized, skipping");
      return;
    }
    await program.methods
      .initFamilyVault(
        primary.publicKey,
        partner.publicKey,
        guardian.publicKey,
        { standard: {} },
        feeDestinationUsdcAta
      )
      .accounts({
        backendAuthority: provider.wallet.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("initializes the savings goal in USDC (idempotent)", async () => {
    if (await connection.getAccountInfo(goalPda)) {
      console.log("  goal already initialized, skipping");
      return;
    }
    const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    await program.methods
      .initSavingsGoal(
        "Family Trip",
        new anchor.BN(100 * 10 ** USDC_DECIMALS),
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

  it("primary can contribute manually", async () => {
    const before = await getAccount(connection, goalUsdcAta);
    const amount = 1 * 10 ** USDC_DECIMALS;

    await program.methods
      .contribute(new anchor.BN(amount), USDC_DECIMALS)
      .accounts({
        contributor: primary.publicKey,
        feeConfig: feeConfigPda,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        feeDestination: feeDestinationUsdcAta,
        contributorTokenAccount: primaryUsdcAta,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([primary])
      .rpc();

    const after = await getAccount(connection, goalUsdcAta);
    expect(Number(after.amount) - Number(before.amount)).to.equal(amount);
  });

  it("rejects contributions from someone who isn't primary or partner", async () => {
    try {
      await program.methods
        .contribute(new anchor.BN(1 * 10 ** USDC_DECIMALS), USDC_DECIMALS)
        .accounts({
          contributor: guardian.publicKey,
          feeConfig: feeConfigPda,
          vault: vaultPda,
          goal: goalPda,
          goalTokenAccount: goalUsdcAta,
          feeDestination: feeDestinationUsdcAta,
          contributorTokenAccount: partnerUsdcAta,
          mint: DEVNET_USDC_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([guardian])
        .rpc();
      expect.fail("expected UnauthorizedContributor error");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedContributor");
    }
  });
});
