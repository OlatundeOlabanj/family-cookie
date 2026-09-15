// Family Cookie frontend config.
// Made by TJS Code

// Program ID is the same across every cluster below (see Anchor.toml).
export const PROGRAM_ID = "6tyoXrDQiqs6PCfc94sP1vV5v4h81DsWXaU5uCpwke9w";

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
    // No bridged stablecoin exists on Cookie Chain; native COOK is the
    // only genuinely liquid currency, so goals are denominated in
    // wrapped-native COOK via the standard SVM native-mint sentinel.
    goalMint: "So11111111111111111111111111111111111111112",
    goalMintDecimals: 6,
    goalMintLabel: "COOK",
    explorerTxUrl: (sig) => `https://cookiescan.io/tx/${sig}`,
    explorerAddressUrl: (addr) => `https://cookiescan.io/address/${addr}`,
  },
};

export const DEFAULT_CLUSTER = "devnet";

// Anchor discriminator prefix bytes are computed at runtime by the
// bundled @coral-xyz/anchor BorshInstructionCoder from js/idl.js, not
// hardcoded here, so they always match whatever the IDL actually says.
