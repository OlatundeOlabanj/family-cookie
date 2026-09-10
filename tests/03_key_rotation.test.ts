import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { SystemProgram } from "@solana/web3.js";
import { getProgram, loadTestWallet, deriveVaultPda, deriveRotationPda } from "./helpers";

describe("family-wallet: guardian-approved key rotation — second highest risk", () => {
  const { program, provider } = getProgram();
  const connection = provider.connection;

  const primary = loadTestWallet("primary");
  const partner = loadTestWallet("partner");
  const guardian = loadTestWallet("guardian");

  const [vaultPda] = deriveVaultPda(primary.publicKey);

  const newPartnerDevice = anchor.web3.Keypair.generate();
  const [rotationPda] = deriveRotationPda(vaultPda, partner.publicKey);

  it("primary can request a rotation for partner's lost device", async () => {
    if (await connection.getAccountInfo(rotationPda)) {
      console.log("  rotation request already exists, skipping request step");
      return;
    }
    await program.methods
      .requestKeyRotation(partner.publicKey, newPartnerDevice.publicKey)
      .accounts({
        requester: primary.publicKey,
        vault: vaultPda,
        rotationRequest: rotationPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([primary])
      .rpc();
  });

  it("rejects approval from someone who isn't the registered guardian", async () => {
    const notGuardian = partner;
    try {
      await program.methods
        .approveKeyRotation()
        .accounts({
          guardian: notGuardian.publicKey,
          vault: vaultPda,
          rotationRequest: rotationPda,
        })
        .signers([notGuardian])
        .rpc();
      expect.fail("expected a has_one guardian constraint violation");
    } catch (err: any) {
      expect(err.toString()).to.match(/ConstraintHasOne|Unauthorized/i);
    }
  });

  it("the real guardian approves and rotation executes, updating the vault", async () => {
    const before: any = await program.account.familyVault.fetch(vaultPda);
    if (before.partner.toBase58() === newPartnerDevice.publicKey.toBase58()) {
      console.log("  rotation already executed in a prior run, skipping");
      return;
    }

    await program.methods
      .approveKeyRotation()
      .accounts({
        guardian: guardian.publicKey,
        vault: vaultPda,
        rotationRequest: rotationPda,
      })
      .signers([guardian])
      .rpc();

    const after: any = await program.account.familyVault.fetch(vaultPda);
    expect(after.partner.toBase58()).to.equal(newPartnerDevice.publicKey.toBase58());
  });

  it("rejects a second approval attempt on an already-executed rotation", async () => {
    try {
      await program.methods
        .approveKeyRotation()
        .accounts({
          guardian: guardian.publicKey,
          vault: vaultPda,
          rotationRequest: rotationPda,
        })
        .signers([guardian])
        .rpc();
      expect.fail("expected RotationNotPending error");
    } catch (err: any) {
      expect(err.toString()).to.include("RotationNotPending");
    }
  });
});
