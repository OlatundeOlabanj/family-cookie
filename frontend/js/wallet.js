// Wallet connection via the Solana Wallet Standard, with Nightly as the
// required wallet (per Nightly's own docs: docs.nightly.app/docs/solana).
// Made by TJS Code

const { web3 } = window.FW_VENDOR;

const CONNECT_FEATURES = ["standard:connect", "solana:connect"];
const DISCONNECT_FEATURES = ["standard:disconnect", "solana:disconnect"];
const SIGN_TX_FEATURES = ["standard:signTransaction", "solana:signTransaction"];
const SIGN_AND_SEND_FEATURES = ["standard:signAndSendTransaction", "solana:signAndSendTransaction"];

function firstFeature(wallet, keys) {
  for (const key of keys) {
    if (wallet.features && wallet.features[key]) return { key, feature: wallet.features[key] };
  }
  return null;
}

function isSolanaCapable(wallet) {
  const chains = wallet.chains || [];
  const hasSolanaChain = chains.some((c) => c.startsWith("solana:"));
  const hasConnect = !!firstFeature(wallet, CONNECT_FEATURES);
  const hasSign = !!firstFeature(wallet, SIGN_TX_FEATURES) || !!firstFeature(wallet, SIGN_AND_SEND_FEATURES);
  return hasSolanaChain && hasConnect && hasSign;
}

// Wraps a raw Wallet Standard wallet object into one consistent shape
// the rest of the app uses, regardless of which feature-key flavor the
// wallet implements.
class WalletHandle {
  constructor(standardWallet) {
    this.raw = standardWallet;
    this.name = standardWallet.name || "Unknown wallet";
    this.icon = standardWallet.icon || null;
    this.publicKey = null;
    this._account = null;
  }

  async connect({ silent = false } = {}) {
    const { feature } = firstFeature(this.raw, CONNECT_FEATURES);
    const result = await feature.connect({ silent });
    const accounts = result.accounts || [];
    if (accounts.length === 0) throw new Error("No account returned by wallet.");
    this._account = accounts[0];
    this.publicKey = new web3.PublicKey(this._account.address ? bytesToBase58Pubkey(this._account) : this._account.publicKey);
    return this.publicKey;
  }

  async disconnect() {
    const found = firstFeature(this.raw, DISCONNECT_FEATURES);
    if (found) {
      try {
        await found.feature.disconnect();
      } catch (_) {
        // Some wallets don't require/support an explicit disconnect call.
      }
    }
    this.publicKey = null;
    this._account = null;
  }

  // Signs and submits a Transaction, returns the base58 signature.
  async signAndSendTransaction(transaction, connection) {
    const sendFeature = firstFeature(this.raw, SIGN_AND_SEND_FEATURES);
    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });

    if (sendFeature) {
      const chain = await resolveSolanaChain(this.raw);
      const [result] = await sendFeature.feature.signAndSendTransaction({
        account: this._account,
        transaction: serialized,
        chain,
      });
      return bytesToBase58(result.signature);
    }

    const signFeature = firstFeature(this.raw, SIGN_TX_FEATURES);
    if (!signFeature) throw new Error(`${this.name} does not expose a supported signing feature.`);
    const [result] = await signFeature.feature.signTransaction({
      account: this._account,
      transaction: serialized,
    });
    const signedTx = web3.Transaction.from(result.signedTransaction);
    const rawTx = signedTx.serialize();
    return await connection.sendRawTransaction(rawTx, { skipPreflight: false });
  }
}

// Wallet Standard accounts can carry either a raw `publicKey` byte
// array or an `address` string depending on wallet implementation
// version; this normalizes to bytes for PublicKey construction.
function bytesToBase58Pubkey(account) {
  if (account.publicKey) return account.publicKey;
  throw new Error("Account has no publicKey bytes.");
}

function bytesToBase58(bytes) {
  return window.FW_VENDOR.anchor.utils.bytes.bs58.encode(Buffer.from(bytes));
}

async function resolveSolanaChain(rawWallet) {
  const chains = rawWallet.chains || [];
  const solanaChain = chains.find((c) => c.startsWith("solana:"));
  if (solanaChain) return solanaChain;
  // Fall back to mainnet chain id string if the wallet didn't advertise one -
  // most standard wallets accept this even when targeting devnet/custom RPCs,
  // since the actual network is determined by the Connection used to send.
  return "solana:mainnet";
}

// Discovers every Solana-capable Wallet Standard wallet currently
// registered in the page (Nightly, and any others the user has
// installed), de-duplicated by name.
export function discoverWallets() {
  const { getWallets } = window.FW_VENDOR;
  const { get } = getWallets();
  const found = get().filter(isSolanaCapable);

  const handles = found.map((w) => new WalletHandle(w));

  // Fallback path straight from Nightly's own docs, in case Nightly's
  // Wallet Standard registration hasn't fired yet for some reason but
  // the injected object is already present.
  const alreadyHasNightly = handles.some((h) => h.name.toLowerCase().includes("nightly"));
  if (!alreadyHasNightly && window.nightly && window.nightly.solana) {
    handles.push(wrapLegacyNightly(window.nightly.solana));
  }

  // Nightly first, since it's the required wallet for this build.
  handles.sort((a, b) => {
    const aNightly = a.name.toLowerCase().includes("nightly");
    const bNightly = b.name.toLowerCase().includes("nightly");
    if (aNightly && !bNightly) return -1;
    if (bNightly && !aNightly) return 1;
    return 0;
  });

  return handles;
}

// Wraps the direct `window.nightly.solana` object (Nightly docs'
// "Accessing the nightly object directly" fallback) into the same
// WalletHandle-shaped interface used everywhere else.
function wrapLegacyNightly(nightlySolana) {
  const shim = {
    name: "Nightly",
    icon: null,
    chains: ["solana:mainnet", "solana:devnet"],
    features: nightlySolana.features || {},
  };
  return new WalletHandle(shim);
}

export function isWalletStandardAvailable() {
  return !!(window.FW_VENDOR && window.FW_VENDOR.getWallets);
}
