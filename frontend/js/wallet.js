// Wallet connection via the Solana Wallet Standard, with Nightly as the
// required wallet (per Nightly's own docs: docs.nightly.app/docs/solana).
// Made by TJS Code

const { web3 } = window.FW_VENDOR;

const CONNECT_FEATURES = ["standard:connect", "solana:connect"];
const DISCONNECT_FEATURES = ["standard:disconnect", "solana:disconnect"];
const SIGN_TX_FEATURES = ["standard:signTransaction", "solana:signTransaction"];

// The Wallet Standard's CAIP-style chain enum only defines these four.
// "solana:mainnet-beta" is not part of that enum, but is a long-standing
// alternate name Solana tooling has used for mainnet — included here so
// it's correctly recognized as standard, not mistaken for a genuine
// custom-network identifier. Confirmed necessary: Nightly's real wallet
// object reports exactly these four standard names and nothing else,
// even when its custom Cookie Chain network is the one actually active
// (checked directly in devtools, not assumed) — see resolveNonStandardChain().
const STANDARD_SOLANA_CHAINS = ["solana:mainnet", "solana:mainnet-beta", "solana:devnet", "solana:testnet", "solana:localnet"];

// NOTE: deliberately not using "standard:signAndSendTransaction" /
// "solana:signAndSendTransaction" anywhere in this file. See the long
// comment on WalletHandle.signAndSendTransaction() below for why.

// If a connected wallet self-reports a chain id outside the standard
// four, that's very likely its own identifier for a custom SVM network
// the user added (Cookie Chain, in our case) — return it so we can pass
// it explicitly to signTransaction() instead of passing nothing and
// leaving the wallet to guess/default internally. Returns null if the
// wallet only reports standard chains (nothing to disambiguate) or
// reports more than one non-standard chain (ambiguous, don't guess).
function resolveNonStandardChain(chains) {
  const nonStandard = (chains || []).filter((c) => !STANDARD_SOLANA_CHAINS.includes(c) && c.startsWith("solana:"));
  return nonStandard.length === 1 ? nonStandard[0] : null;
}

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
  // Only signTransaction is actually used to send anything (see
  // signAndSendTransaction() below) — a wallet that can only
  // sign-and-send-in-one-step isn't usable here, since that step is
  // exactly what routes transactions to the wrong network for Cookie
  // Chain. Require signTransaction explicitly rather than accepting
  // either, so an incompatible wallet is filtered out at discovery time
  // instead of failing later mid-transaction.
  const hasSign = !!firstFeature(wallet, SIGN_TX_FEATURES);
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
    // Read once at construction, from whatever this wallet object
    // actually reports right now — never hardcoded. See
    // resolveNonStandardChain() above for why this matters.
    this._chains = standardWallet.chains || [];
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

  // Signs a Transaction and submits it via OUR OWN `connection`, then
  // returns the base58 signature.
  //
  // IMPORTANT — do not "simplify" this back to using the Wallet
  // Standard's "signAndSendTransaction" feature, even though Nightly
  // exposes it and it looks like less code. That feature has the WALLET
  // choose which RPC to broadcast to, via a `chain` id it's given —
  // the `connection` argument below is irrelevant to that path, not a
  // fallback for it.
  //
  // The Wallet Standard's chain enum only defines
  // "solana:mainnet" / "solana:devnet" / "solana:testnet" /
  // "solana:localnet". There is no standard chain id for Cookie Chain
  // (or any other custom SVM network), so there is no correct value to
  // pass as `chain` — any guess or fallback (a literal "solana:mainnet"
  // was here before) can silently broadcast to the wrong network,
  // regardless of what's selected in the wallet's own UI or what
  // `connection` is configured for. That was confirmed to be the actual
  // cause of contribute/withdraw/init working when called directly via
  // Anchor (see scripts/test-cookiechain-direct.ts and
  // scripts/test-cookiechain-walletlike.ts, both 100% successful against
  // Cookie Chain) but misbehaving when routed through Nightly.
  //
  // Signing only, then sending via `connection.sendRawTransaction`,
  // keeps the destination network fully determined by `connection`
  // (i.e. by CLUSTERS in config.js) end to end, with no wallet-side
  // routing in between.
  async signAndSendTransaction(transaction, connection) {
    const signFeature = firstFeature(this.raw, SIGN_TX_FEATURES);
    if (!signFeature) {
      throw new Error(
        `${this.name} does not expose a signTransaction feature. This app ` +
        `requires it so transactions are submitted via Cookie Chain's own ` +
        `RPC instead of being routed by the wallet.`
      );
    }
    const serialized = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });

    // If this wallet self-reports a single non-standard chain id (its
    // own identifier for whatever custom network the user has added —
    // Cookie Chain, presumably), pass it explicitly. Some wallets use
    // this to decide which network to preview/simulate against before
    // showing the approve dialog, even for a plain sign (not
    // sign-and-send) request; leaving it unset lets the wallet fall
    // back to whatever network it's internally defaulted to, which is
    // exactly the class of bug this file already fixed once for the
    // send path. We do NOT guess or hardcode a value here — only ever
    // the wallet's own live self-report.
    const chain = resolveNonStandardChain(this._chains);
    const signInput = { account: this._account, transaction: serialized };
    if (chain) signInput.chain = chain;
    if (window?.console?.debug) {
      console.debug("[wallet] signing with chain:", chain || "(none resolved — wallet reported only standard chains, or more than one non-standard chain)", "raw wallet.chains:", this._chains);
    }

    const [result] = await signFeature.feature.signTransaction(signInput);
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
//
// IMPORTANT: this used to hardcode chains as ["solana:mainnet",
// "solana:devnet"] — a real bug, flagged in code review, now fixed.
// That hardcoded list meant this shim actively lied about supporting
// only mainnet/devnet, with no way to ever resolve Cookie Chain as a
// non-standard chain id (see resolveNonStandardChain() above), even if
// the legacy object had a way to tell us the real answer.
//
// We don't yet know Nightly's exact non-standard property name for
// "what network is currently active" from documentation alone — the
// candidates below are a best-effort guess at common patterns other
// injected wallet objects use. If NONE of them exist on the live
// object, `chains` falls back to empty, which is honest (we don't
// know) rather than wrong (we do know, incorrectly).
//
// To find the real property: open devtools console on the app with
// Nightly connected and run `window.nightly.solana` to inspect it, or
// check the console.debug output this file now logs on every sign
// attempt (see signAndSendTransaction above) — it prints exactly what
// chains array a connected wallet is reporting.
function wrapLegacyNightly(nightlySolana) {
  const guessedChain =
    nightlySolana.network ||
    nightlySolana.chain ||
    nightlySolana._network ||
    null;

  // IMPORTANT: chains must never be empty here, even when guessedChain
  // is unknown — an empty array fails isSolanaCapable()'s
  // hasSolanaChain check above and silently removes Nightly from the
  // wallet list entirely (a real regression, caught in testing).
  // "solana:mainnet" is used ONLY as a safe placeholder to keep
  // discovery working; resolveNonStandardChain() treats it as a
  // standard chain and ignores it, so it can never be mistakenly used
  // as a real chain id when signing — that still only happens when
  // guessedChain resolves to something real.
  const shim = {
    name: "Nightly",
    icon: null,
    chains: guessedChain ? [guessedChain] : ["solana:mainnet"],
    features: nightlySolana.features || {},
  };
  return new WalletHandle(shim);
}

export function isWalletStandardAvailable() {
  return !!(window.FW_VENDOR && window.FW_VENDOR.getWallets);
}

// Tells "no wallet extension at all" apart from "a wallet is present but
// isn't passing the Solana-capability filter" (missing chains, missing a
// required feature, etc). Without this, both cases produce the same empty
// discoverWallets() list and look identical to the user — see Cookie
// Bakery's own documented warning about exactly this failure mode with
// their VITE_WALLET_CHAIN filter, same root shape of problem here.
export function hasAnyInjectedWallet() {
  if (isWalletStandardAvailable()) {
    const { getWallets } = window.FW_VENDOR;
    const { get } = getWallets();
    if (get().length > 0) return true;
  }
  return !!(window.nightly && window.nightly.solana);
}

// Sanity check on OUR OWN connection, not on what Nightly internally
// believes (there's no standard way to ask a wallet that). Confirms
// `connection` is actually talking to the genesis it claims to be,
// catching config drift or a misconfigured RPC before any transaction
// is built against it. Call once after constructing the Connection in
// app.js, e.g.:
//
//   const ok = await verifyConnectionGenesis(state.connection, currentCluster().expectedGenesisHash);
//   if (!ok) { /* show a banner, refuse to let the user proceed */ }
//
// `expectedGenesisHash` must be filled in per cluster in config.js. To
// get Cookie Chain's real value, run once:
//   curl -s https://rpc.cookiescan.io -X POST -H "Content-Type: application/json" \
//     -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
// and hardcode the result. Left unset (null), this check is skipped
// rather than silently comparing against a made-up value.
export async function verifyConnectionGenesis(connection, expectedGenesisHash) {
  if (!expectedGenesisHash) return true; // not configured yet — skip, don't fail closed on a guess
  const actual = await connection.getGenesisHash();
  const ok = actual === expectedGenesisHash;
  if (!ok) {
    console.error(`[wallet] connection genesis mismatch: expected ${expectedGenesisHash}, got ${actual}`);
  }
  return ok;
}
