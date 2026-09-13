import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, createTransferInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
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

describe("family-wallet: passkey-authorized flow (contribute, withdraw, recurring)", () => {
  const { program, provider } = getProgram();
  const connection = provider.connection;
  const mainWallet = (provider.wallet as anchor.Wallet).payer;

  const bank = loadTestWallet("bank"); // dedicated funding source, not a persona wallet
  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");

  const device = generateDeviceKeypair();
  const partnerDevicePubkey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 1)]);

  const vaultSeedKp = Keypair.generate();
  const [vaultPda] = deriveVaultPda(vaultSeedKp.publicKey);
  const [goalPda] = deriveGoalPda(vaultPda, 0);
  const [feeConfigPda] = deriveFeeConfigPda();
  const [walletAuthorityPda] = deriveWalletAuthorityPda(vaultPda, DEVICE_ROLE_PRIMARY);
  const [delegatePda] = deriveDelegatePda(goalPda);

  let feeDestinationUsdcAta: PublicKey;
  let goalUsdcAta: PublicKey;
  let walletAuthorityUsdcAta: PublicKey;

  before(async () => {
    feeDestinationUsdcAta = await ensureAta(connection, feeDestinationOwner, DEVNET_USDC_MINT, feeDestinationOwner.publicKey);

    await program.methods
      .initFamilyVault(
        vaultSeedKp.publicKey,
        Array.from(device.compressedPubkey),
        Array.from(partnerDevicePubkey),
        guardian.publicKey,
        { standard: {} },
        feeDestinationUsdcAta
      )
      .accounts({ backendAuthority: mainWallet.publicKey, vault: vaultPda, systemProgram: SystemProgram.programId })
      .rpc();

    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    goalUsdcAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, goalPda, true);

    const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;
    await program.methods
      .initSavingsGoal("Passkey Flow Test Goal", new anchor.BN(1000 * 10 ** USDC_DECIMALS), { usdc: {} }, new anchor.BN(oneYearFromNow))
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

    walletAuthorityUsdcAta = await ensureAta(connection, mainWallet, DEVNET_USDC_MINT, walletAuthorityPda);
    const fundAmount = 3 * 10 ** USDC_DECIMALS;
    const bankAta = await ensureAta(connection, bank, DEVNET_USDC_MINT, bank.publicKey);
    await provider.sendAndConfirm(
      new Transaction().add(createTransferInstruction(bankAta, walletAuthorityUsdcAta, bank.publicKey, fundAmount)),
      [bank]
    );
  });

  it("contribute: a real passkey signature moves funds from the personal wallet into the goal", async () => {
    const amount = 1 * 10 ** USDC_DECIMALS;
    const placeholder = await program.methods
      .contribute(DEVICE_ROLE_PRIMARY, new anchor.BN(amount), USDC_DECIMALS, Buffer.from([0]), Buffer.from([0]))
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        feeConfig: feeConfigPda,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        feeDestination: feeDestinationUsdcAta,
        contributorTokenAccount: walletAuthorityUsdcAta,
        walletAuthority: walletAuthorityPda,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const proof = await signForInstruction(placeholder, 1 + 8 + 1, device.privateKey, device.compressedPubkey);
    const realIx = await program.methods
      .contribute(DEVICE_ROLE_PRIMARY, new anchor.BN(amount), USDC_DECIMALS, proof.authenticatorData, proof.clientDataJson)
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        feeConfig: feeConfigPda,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        feeDestination: feeDestinationUsdcAta,
        contributorTokenAccount: walletAuthorityUsdcAta,
        walletAuthority: walletAuthorityPda,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const before = await getAccount(connection, goalUsdcAta);
    await provider.sendAndConfirm(new Transaction().add(proof.precompileIx).add(realIx));
    const after = await getAccount(connection, goalUsdcAta);
    expect(Number(after.amount) - Number(before.amount)).to.equal(amount);
  });

  it("contribute: rejects a real signature claiming the wrong device", async () => {
    const amount = 1 * 10 ** USDC_DECIMALS;
    const placeholder = await program.methods
      .contribute(DEVICE_ROLE_PRIMARY, new anchor.BN(amount), USDC_DECIMALS, Buffer.from([0]), Buffer.from([0]))
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        feeConfig: feeConfigPda,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        feeDestination: feeDestinationUsdcAta,
        contributorTokenAccount: walletAuthorityUsdcAta,
        walletAuthority: walletAuthorityPda,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    // sign with a DIFFERENT device than the one registered as primary
    const impostor = generateDeviceKeypair();
    const proof = await signForInstruction(placeholder, 1 + 8 + 1, impostor.privateKey, impostor.compressedPubkey);
    const realIx = await program.methods
      .contribute(DEVICE_ROLE_PRIMARY, new anchor.BN(amount), USDC_DECIMALS, proof.authenticatorData, proof.clientDataJson)
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        feeConfig: feeConfigPda,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        feeDestination: feeDestinationUsdcAta,
        contributorTokenAccount: walletAuthorityUsdcAta,
        walletAuthority: walletAuthorityPda,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    try {
      await provider.sendAndConfirm(new Transaction().add(proof.precompileIx).add(realIx));
      expect.fail("expected UnauthorizedContributor error");
    } catch (err: any) {
      expect(err.toString()).to.match(/UnauthorizedContributor/);
    }
  });

  it("withdraw: a real passkey signature moves funds from the goal back to the personal wallet", async () => {
    const amount = 0.5 * 10 ** USDC_DECIMALS;
    const placeholder = await program.methods
      .withdraw(DEVICE_ROLE_PRIMARY, new anchor.BN(amount), USDC_DECIMALS, Buffer.from([0]), Buffer.from([0]))
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        destinationTokenAccount: walletAuthorityUsdcAta,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const proof = await signForInstruction(placeholder, 1 + 8 + 1, device.privateKey, device.compressedPubkey);
    const realIx = await program.methods
      .withdraw(DEVICE_ROLE_PRIMARY, new anchor.BN(amount), USDC_DECIMALS, proof.authenticatorData, proof.clientDataJson)
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        goalTokenAccount: goalUsdcAta,
        destinationTokenAccount: walletAuthorityUsdcAta,
        mint: DEVNET_USDC_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const before = await getAccount(connection, goalUsdcAta);
    await provider.sendAndConfirm(new Transaction().add(proof.precompileIx).add(realIx));
    const after = await getAccount(connection, goalUsdcAta);
    expect(Number(before.amount) - Number(after.amount)).to.equal(amount);
  });

  it("authorize_recurring_delegate: real passkey signature creates the schedule and grants real SPL Approve authority", async () => {
    const amountPerPeriod = 1 * 10 ** USDC_DECIMALS;
    const nextRunAt = Math.floor(Date.now() / 1000) + 1;
    const placeholder = await program.methods
      .authorizeRecurringDelegate(DEVICE_ROLE_PRIMARY, new anchor.BN(amountPerPeriod), { weekly: {} }, new anchor.BN(nextRunAt), Buffer.from([0]), Buffer.from([0]))
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
      .authorizeRecurringDelegate(DEVICE_ROLE_PRIMARY, new anchor.BN(amountPerPeriod), { weekly: {} }, new anchor.BN(nextRunAt), proof.authenticatorData, proof.clientDataJson)
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
    const tokenAccountInfo = await getAccount(connection, walletAuthorityUsdcAta);
    expect(tokenAccountInfo.delegate?.toBase58()).to.equal(delegatePda.toBase58());
    expect(tokenAccountInfo.delegatedAmount.toString()).to.equal((amountPerPeriod * 100).toString());
  });

  it("cancel_recurring_delegate: real passkey signature closes the schedule", async () => {
    const placeholder = await program.methods
      .cancelRecurringDelegate(DEVICE_ROLE_PRIMARY, Buffer.from([0]), Buffer.from([0]))
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
      })
      .instruction();
    const proof = await signForInstruction(placeholder, 1, device.privateKey, device.compressedPubkey);
    const realIx = await program.methods
      .cancelRecurringDelegate(DEVICE_ROLE_PRIMARY, proof.authenticatorData, proof.clientDataJson)
      .accounts({
        payer: mainWallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        vault: vaultPda,
        goal: goalPda,
        delegate: delegatePda,
      })
      .instruction();

    await provider.sendAndConfirm(new Transaction().add(proof.precompileIx).add(realIx));
    const closedInfo = await connection.getAccountInfo(delegatePda);
    expect(closedInfo).to.be.null;
  });
});
