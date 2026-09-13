import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { SystemProgram, Keypair } from "@solana/web3.js";
import {
  getProgram,
  loadTestWallet,
  deriveVaultPda,
  deriveRotationPda,
  generateDeviceKeypair,
} from "./helpers";

const DEVICE_ROLE_PARTNER = 1;

// REWRITTEN against the current calling convention. request_key_rotation
// now takes (device_role: u8, new_device_pubkey: [u8; 33]); the old
// version called it with (partner.publicKey, newPartnerDevice.publicKey),
// i.e. a plain Ed25519 Pubkey standing in for both a role selector and
// a 33-byte secp256r1 device key, neither of which matches the real
// handler. The accounts object also used `requester`, which isn't a
// field on RequestKeyRotation (it's `backend_authority`; this
// instruction is deliberately backend-signed, not passkey-verified;
// see the doc comment on RequestKeyRotation in the program source).
// approve_key_rotation's signature/accounts were already correct
// against the current API and needed no changes.
describe("family-wallet: guardian-approved key rotation, second highest risk", () => {
  const { program, provider } = getProgram();
  const mainWallet = (provider.wallet as anchor.Wallet).payer;

  const guardian = loadTestWallet("guardian");
  const feeDestinationOwner = loadTestWallet("fee-destination");
  const primaryDevice = generateDeviceKeypair();
  const partnerDevice = generateDeviceKeypair();
  const newPartnerDevice = generateDeviceKeypair();

  const vaultSeedKp = Keypair.generate();
  const [vaultPda] = deriveVaultPda(vaultSeedKp.publicKey);
  const [rotationPda] = deriveRotationPda(vaultPda, DEVICE_ROLE_PARTNER);

  before(async () => {
    // This file never moves tokens; only vault/rotation state matters
    // for key rotation, so fee_destination is just some real token-
    // account-shaped address to satisfy init_family_vault's layout,
    // not something this file exercises.
    await program.methods
      .initFamilyVault(
        vaultSeedKp.publicKey,
        Array.from(primaryDevice.compressedPubkey),
        Array.from(partnerDevice.compressedPubkey),
        guardian.publicKey,
        { standard: {} },
        feeDestinationOwner.publicKey
      )
      .accounts({
        backendAuthority: mainWallet.publicKey,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  });

  it("backend authority can request a rotation for partner's lost device", async () => {
    await program.methods
      .requestKeyRotation(DEVICE_ROLE_PARTNER, Array.from(newPartnerDevice.compressedPubkey))
      .accounts({
        backendAuthority: mainWallet.publicKey,
        vault: vaultPda,
        rotationRequest: rotationPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const rotation: any = await program.account.keyRotationRequest.fetch(rotationPda);
    expect(rotation.deviceRole).to.equal(DEVICE_ROLE_PARTNER);
  });

  it("rejects approval from someone who isn't the registered guardian", async () => {
    const notGuardian = loadTestWallet("partner");
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
    expect(Buffer.from(after.partnerDevice)).to.deep.equal(newPartnerDevice.compressedPubkey);
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
