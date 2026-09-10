// Family Cookie frontend config.
// Made by TJS Code

// Program ID is the same across every cluster below (see Anchor.toml).
export const PROGRAM_ID = "6apQZUxBwpBbFNiBpYzGeMBQJ8328xrrsQ3aRcQhM2Av";

// Hosting is decided: this must match the four `expected_origin`
// literals in programs/family-wallet/src/instructions/*.rs
// (contribute, withdraw, authorize_recurring_delegate,
// cancel_recurring_delegate) exactly, or every passkey-authorized
// transaction fails with InvalidPasskeyProof, on any cluster. If the
// hosting URL ever changes, update this AND those four literals
// together, then rebuild and redeploy before relying on the
// contribute/withdraw flow anywhere.
export const EXPECTED_ORIGIN = "https://family-cookie-tjscode.netlify.app";

export const CLUSTERS = {
  devnet: {
    label: "Solana Devnet",
    rpcUrl: "https://api.devnet.solana.com",
    // From scripts/constants.ts - already used by the existing test suite.
    goalMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    goalMintDecimals: 6,
    goalMintLabel: "USDC (devnet)",
    explorerTxUrl: (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
    explorerAddressUrl: (addr) => `https://explorer.solana.com/address/${addr}?cluster=devnet`,
  },
  cookiechain: {
    label: "Cookie Chain",
    rpcUrl: "https://rpc.cookiescan.io",
    // TODO-CONFIRM: Cookie Chain's real token landscape is unknown from
    // here. Two open questions before this cluster is usable for real:
    //   1. Does Cookie Chain's SVM fork support the secp256r1 precompile
    //      (program id Secp256r1SigVerify1111111111111111111111111)?
    //      contribute/withdraw/authorize_recurring_delegate/
    //      cancel_recurring_delegate all depend on it. Cheapest check:
    //      query that program id against https://rpc.cookiescan.io
    //      with getAccountInfo before spending real COOK on a deploy.
    //   2. What SPL mint should a savings goal actually be denominated
    //      in on Cookie Chain - a bridged/native USDC, or wrapped COOK?
    //      Placeholder below is NOT a real deployed mint.
    goalMint: "TODO_CONFIRM_COOKIE_CHAIN_GOAL_MINT",
    goalMintDecimals: 6,
    goalMintLabel: "TBD",
    explorerTxUrl: (sig) => `https://cookiescan.io/tx/${sig}`,
    explorerAddressUrl: (addr) => `https://cookiescan.io/address/${addr}`,
  },
};

export const DEFAULT_CLUSTER = "devnet";

// Anchor discriminator prefix bytes are computed at runtime by the
// bundled @coral-xyz/anchor BorshInstructionCoder from js/idl.js, not
// hardcoded here, so they always match whatever the IDL actually says.
