// App orchestration (dashboard page). Made by TJS Code
import { CLUSTERS, DEFAULT_CLUSTER, EXPECTED_ORIGIN, PROGRAM_ID } from "./config.js";
import { discoverWallets, verifyConnectionGenesis, hasAnyInjectedWallet } from "./wallet.js";
import {
  createVaultAndGoal,
  fundWalletAuthority,
  contributeToGoal,
  fetchGoal,
  fetchGoalBalance,
  fetchGoalActivity,
  authorizeRecurring,
  cancelRecurring,
  fetchRecurringDelegate,
  describeTransactionError,
} from "./anchor.js";

const { web3 } = window.FW_VENDOR;

const el = (id) => document.getElementById(id);
const rpId = window.location.hostname || "localhost";

let state = {
  clusterKey: DEFAULT_CLUSTER,
  connection: null,
  wallet: null, // WalletHandle
  vaultPda: null,
  goalPda: null,
  goalTokenAccount: null,
  credentialId: null, // Uint8Array
};

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function b64ToBytes(b64) {
  return new Uint8Array(atob(b64).split("").map((c) => c.charCodeAt(0)));
}

function storageKey() {
  return `fw:${state.clusterKey}:${state.wallet.publicKey.toBase58()}`;
}

function persist() {
  if (!state.wallet || !state.vaultPda) return;
  localStorage.setItem(
    storageKey(),
    JSON.stringify({
      vaultPda: state.vaultPda.toBase58(),
      goalPda: state.goalPda.toBase58(),
      goalTokenAccount: state.goalTokenAccount.toBase58(),
      credentialId: bytesToB64(state.credentialId),
    })
  );
}

function restore() {
  const raw = localStorage.getItem(storageKey());
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw);
    state.vaultPda = new web3.PublicKey(saved.vaultPda);
    state.goalPda = new web3.PublicKey(saved.goalPda);
    state.goalTokenAccount = new web3.PublicKey(saved.goalTokenAccount);
    state.credentialId = b64ToBytes(saved.credentialId);
    return true;
  } catch (_) {
    return false;
  }
}

function currentCluster() {
  return CLUSTERS[state.clusterKey];
}

function truncate(addr) {
  return addr.slice(0, 4) + "…" + addr.slice(-4);
}

// --- Banners -----------------------------------------------------------

function showStatusBanner(kind, message) {
  const banner = el("status-banner");
  const cls = kind === "error" ? "banner-error" : kind === "warn" ? "banner-warn" : "banner-info";
  banner.className = `banner ${cls}`;
  banner.innerHTML = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v5M10 13.5v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>${message}</span>`;
}
function clearStatusBanner() {
  el("status-banner").className = "hidden";
}

function checkOriginBanner() {
  const actual = window.location.origin;
  if (actual !== EXPECTED_ORIGIN) {
    el("origin-banner").classList.remove("hidden");
    el("origin-banner-text").textContent =
      `This page is served from ${actual}, but the deployed program expects passkey requests from ${EXPECTED_ORIGIN}. ` +
      `Contribute, withdraw, and the recurring-delegate instructions will fail with InvalidPasskeyProof until EXPECTED_ORIGIN in js/config.js and the matching expected_origin literals in the Rust program agree with wherever this is actually hosted, and the program is rebuilt and redeployed.`;
  } else {
    el("origin-banner").classList.add("hidden");
  }
}

// --- Network control (compact icon + menu, replaces the old dropdown) ---

function populateNetworkMenu() {
  const menu = el("network-menu");
  menu.innerHTML = "";
  for (const [key, cfg] of Object.entries(CLUSTERS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = cfg.label;
    btn.className = key === state.clusterKey ? "active" : "";
    btn.addEventListener("click", () => {
      state.clusterKey = key;
      state.connection = new web3.Connection(currentCluster().rpcUrl, {
        commitment: "confirmed",
        wsEndpoint: currentCluster().wsUrl,
      });
      verifyConnectionGenesis(state.connection, currentCluster().expectedGenesisHash).then((ok) => {
        if (!ok) console.error(`Connection genesis mismatch on ${currentCluster().label} — check config.js`);
      });
      el("program-link").href = currentCluster().explorerAddressUrl(PROGRAM_ID);
      menu.classList.add("hidden");
      populateNetworkMenu();
      resetFlowUI();
      if (state.wallet) tryRestoreForCurrentWallet();
    });
    menu.appendChild(btn);
  }
}

function setupNetworkControl() {
  const btn = el("network-icon-btn");
  const menu = el("network-menu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== btn) {
      menu.classList.add("hidden");
    }
  });
}

// --- Wallet connect ------------------------------------------------------

function renderWalletPicker(handles) {
  const list = el("wallet-picker-list");
  list.innerHTML = "";
  if (handles.length === 0) {
    // Distinguish "nothing installed" from "something's installed but
    // doesn't report what this app needs" — otherwise both show the exact
    // same empty state, which looks like Nightly is missing even when it
    // isn't, and there's nothing the user can act on differently.
    el("wallet-picker-desc").textContent = hasAnyInjectedWallet()
      ? "A wallet extension is installed, but it isn't reporting the Solana capabilities this app needs. If that's Nightly, try reconnecting or check its network settings, or install Nightly from nightly.app if it's a different wallet."
      : "No Wallet Standard wallet detected. This build requires Nightly - install it from nightly.app and reload.";
    el("wallet-picker-panel").classList.remove("hidden");
    return;
  }
  handles.forEach((handle) => {
    const btn = document.createElement("button");
    btn.className = "wallet-option";
    btn.type = "button";
    const isNightly = handle.name.toLowerCase().includes("nightly");
    btn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="6" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2 9h16" stroke="currentColor" stroke-width="1.5"/></svg><span>${handle.name}</span>${isNightly ? '<span class="required-badge">Required</span>' : ""}`;
    btn.addEventListener("click", () => connectWith(handle));
    list.appendChild(btn);
  });
  el("wallet-picker-panel").classList.remove("hidden");
}

async function connectWith(handle) {
  const btn = el("connect-btn");
  const originalLabel = btn.innerHTML;
  try {
    clearStatusBanner();
    btn.disabled = true;
    btn.textContent = "Waiting for wallet...";
    await withTimeout(handle.connect(), 30000, "Wallet did not respond within 30 seconds. Check that it's unlocked and try again.");
    state.wallet = handle;
    el("wallet-picker-panel").classList.add("hidden");
    onWalletConnected();
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
    btn.disabled = false;
    btn.innerHTML = originalLabel;
  }
}

function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
}

function onWalletConnected() {
  el("status-dot").classList.add("connected");
  el("wallet-address").textContent = truncate(state.wallet.publicKey.toBase58());
  el("connect-btn").classList.add("hidden");
  el("disconnect-btn").classList.remove("hidden");
  el("connect-placeholder").classList.add("hidden");
  el("app-main").classList.remove("hidden");
  const bar = document.querySelector(".wallet-status");
  if (bar) {
    bar.classList.add("just-connected");
    setTimeout(() => bar.classList.remove("just-connected"), 1600);
  }
  tryRestoreForCurrentWallet();
}

function tryRestoreForCurrentWallet() {
  if (restore()) {
    showGoalDashboard();
    refreshGoalDisplay();
    refreshRecurringStatus();
  } else {
    el("step-create").classList.remove("hidden");
    el("goal-dashboard").classList.add("hidden");
  }
}

function disconnect() {
  if (state.wallet) state.wallet.disconnect().catch(() => {});
  state.wallet = null;
  state.vaultPda = null;
  state.goalPda = null;
  state.goalTokenAccount = null;
  state.credentialId = null;
  el("status-dot").classList.remove("connected");
  el("wallet-address").textContent = "Not connected";
  el("connect-btn").classList.remove("hidden");
  el("disconnect-btn").classList.add("hidden");
  el("connect-placeholder").classList.remove("hidden");
  el("app-main").classList.add("hidden");
  clearStatusBanner();
}

// --- Flow UI ------------------------------------------------------------

function resetFlowUI() {
  el("step-create").classList.remove("hidden");
  el("goal-dashboard").classList.add("hidden");
}

function showGoalDashboard() {
  el("step-create").classList.add("hidden");
  el("goal-dashboard").classList.remove("hidden");
  el("detail-vault").textContent = state.vaultPda.toBase58();
  el("detail-goal").textContent = state.goalPda.toBase58();
  el("detail-goal-ata").textContent = state.goalTokenAccount.toBase58();
}

function setTxStatus(idPrefix, text) {
  const box = el(`${idPrefix}-status`);
  box.classList.remove("hidden");
  box.innerHTML = `<span class="spinner"></span><span>${text}</span>`;
}
function setTxLink(idPrefix, signature) {
  const box = el(`${idPrefix}-status`);
  const url = currentCluster().explorerTxUrl(signature);
  box.innerHTML = `<span>Confirmed.</span> <a class="tx-link" href="${url}" target="_blank" rel="noopener">View transaction</a>`;
}

async function refreshGoalDisplay() {
  if (!state.goalPda) return;
  try {
    const [goal, balance] = await Promise.all([
      fetchGoal(state.connection, state.wallet, state.goalPda),
      fetchGoalBalance(state.connection, state.goalTokenAccount),
    ]);
    const decimals = currentCluster().goalMintDecimals;
    const current = balance.uiAmount ?? Number(balance.amount) / 10 ** decimals;
    const target = Number(goal.targetAmount) / 10 ** decimals;
    el("goal-current").textContent = current.toLocaleString();
    el("goal-target-readout").textContent = target.toLocaleString();
    el("goal-currency-label").textContent = currentCluster().goalMintLabel;
    const pct = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    el("goal-progress-fill").style.width = `${pct}%`;
    el("goal-progress-badge").textContent = `${Math.round(pct)}% funded`;
  } catch (err) {
    // Non-fatal - display just stays at its last known value.
  }
  refreshActivity();
}

async function refreshActivity() {
  if (!state.goalTokenAccount) return;
  const list = el("activity-list");
  const empty = el("activity-empty");
  try {
    const decimals = currentCluster().goalMintDecimals;
    const events = await fetchGoalActivity(state.connection, state.goalTokenAccount);
    el("contribution-count").textContent = String(events.length);
    if (events.length === 0) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    list.innerHTML = events
      .map((event) => {
        const amount = (Number(event.amountRaw) / 10 ** decimals).toLocaleString();
        const when = event.blockTime
          ? new Date(event.blockTime * 1000).toLocaleString()
          : "Pending timestamp";
        const url = currentCluster().explorerTxUrl(event.signature);
        return `<div class="activity-item"><span class="amount">+${amount} ${currentCluster().goalMintLabel}</span><span class="when">${when} - <a href="${url}" target="_blank" rel="noopener">view</a></span></div>`;
      })
      .join("");
  } catch (err) {
    // Non-fatal - the progress readout above is the source of truth either way.
  }
}

// --- Recurring tab ---------------------------------------------------

function frequencyLabel(freqEnum) {
  if (freqEnum && freqEnum.monthly) return "Monthly";
  if (freqEnum && freqEnum.weekly) return "Weekly";
  return "Unknown";
}

async function refreshRecurringStatus() {
  if (!state.goalPda) return;
  try {
    const result = await fetchRecurringDelegate(state.connection, state.wallet, state.goalPda);
    const statusBox = el("recurring-status-box");
    const setupForm = el("recurring-setup-form");
    const cancelBtn = el("cancel-recurring-btn");
    if (result.exists) {
      const decimals = currentCluster().goalMintDecimals;
      const amount = (Number(result.account.amountPerPeriod) / 10 ** decimals).toLocaleString();
      el("recurring-amount").textContent = `${amount} ${currentCluster().goalMintLabel}`;
      el("recurring-frequency").textContent = frequencyLabel(result.account.frequency);
      el("recurring-next-run").textContent = new Date(Number(result.account.nextRunAt) * 1000).toLocaleString();
      statusBox.classList.remove("hidden");
      setupForm.classList.add("hidden");
      cancelBtn.classList.remove("hidden");
    } else {
      statusBox.classList.add("hidden");
      setupForm.classList.remove("hidden");
      cancelBtn.classList.add("hidden");
    }
  } catch (err) {
    // Non-fatal - leave whatever state was last shown.
  }
}

async function handleAuthorizeRecurring() {
  const amountUi = parseFloat(el("recurring-amount-input").value);
  const frequency = el("recurring-frequency-input").value;
  if (!Number.isFinite(amountUi) || amountUi <= 0) return showStatusBanner("warn", "Enter an amount per period greater than zero.");

  const cluster = currentCluster();
  const periodSeconds = frequency === "monthly" ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60;
  const nextRunUnixSeconds = Math.floor(Date.now() / 1000) + periodSeconds;

  clearStatusBanner();
  el("authorize-recurring-btn").disabled = true;
  setTxStatus("recurring-tx", "Waiting for your browser's passkey prompt");

  try {
    const result = await authorizeRecurring({
      connection: state.connection,
      walletHandle: state.wallet,
      vaultPda: state.vaultPda,
      goalPda: state.goalPda,
      goalMint: cluster.goalMint,
      amountUi,
      decimals: cluster.goalMintDecimals,
      frequency,
      nextRunUnixSeconds,
      credentialId: state.credentialId,
      rpId,
    });
    setTxLink("recurring-tx", result.signature);
    refreshRecurringStatus();
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
    el("recurring-tx-status").classList.add("hidden");
  } finally {
    el("authorize-recurring-btn").disabled = false;
  }
}

async function handleCancelRecurring() {
  clearStatusBanner();
  el("cancel-recurring-btn").disabled = true;
  setTxStatus("recurring-tx", "Waiting for your browser's passkey prompt");

  try {
    const result = await cancelRecurring({
      connection: state.connection,
      walletHandle: state.wallet,
      vaultPda: state.vaultPda,
      goalPda: state.goalPda,
      credentialId: state.credentialId,
      rpId,
    });
    setTxLink("recurring-tx", result.signature);
    refreshRecurringStatus();
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
    el("recurring-tx-status").classList.add("hidden");
  } finally {
    el("cancel-recurring-btn").disabled = false;
  }
}

// --- Tabs ------------------------------------------------------------

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      el(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "activity") refreshActivity();
      if (btn.dataset.tab === "recurring") refreshRecurringStatus();
    });
  });
}

// --- Step handlers --------------------------------------------------------

async function handleCreate() {
  const name = el("goal-name").value.trim();
  const targetUi = parseFloat(el("goal-target").value);
  const deadlineStr = el("goal-deadline").value;
  if (!name) return showStatusBanner("warn", "Give the goal a name.");
  if (!Number.isFinite(targetUi) || targetUi <= 0) return showStatusBanner("warn", "Enter a target amount greater than zero.");
  if (!deadlineStr) return showStatusBanner("warn", "Pick a deadline.");

  const deadlineUnix = Math.floor(new Date(deadlineStr).getTime() / 1000);
  const cluster = currentCluster();
  clearStatusBanner();
  el("create-btn").disabled = true;
  setTxStatus("create", "Waiting for your browser's passkey prompt");

  try {
    const result = await createVaultAndGoal({
      connection: state.connection,
      walletHandle: state.wallet,
      goalMint: cluster.goalMint,
      goalMintDecimals: cluster.goalMintDecimals,
      goalName: name,
      targetAmountUi: targetUi,
      deadlineUnixSeconds: deadlineUnix,
      rpId,
    });
    setTxStatus("create", "Confirming on-chain");
    state.vaultPda = result.vaultPda;
    state.goalPda = result.goalPda;
    state.goalTokenAccount = result.goalTokenAccount;
    state.credentialId = result.credentialId;
    persist();
    setTxLink("create", result.signature);
    showGoalDashboard();
    refreshGoalDisplay();
    refreshRecurringStatus();
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
    el("create-status").classList.add("hidden");
  } finally {
    el("create-btn").disabled = false;
  }
}

async function handleFund() {
  const amountUi = parseFloat(el("fund-amount").value);
  if (!Number.isFinite(amountUi) || amountUi <= 0) return showStatusBanner("warn", "Enter an amount greater than zero.");

  const cluster = currentCluster();
  clearStatusBanner();
  el("fund-btn").disabled = true;
  setTxStatus("fund", "Waiting for wallet approval");

  try {
    const result = await fundWalletAuthority({
      connection: state.connection,
      walletHandle: state.wallet,
      vaultPda: state.vaultPda,
      goalMint: cluster.goalMint,
      amountUi,
      decimals: cluster.goalMintDecimals,
    });
    setTxLink("fund", result.signature);
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
    el("fund-status").classList.add("hidden");
  } finally {
    el("fund-btn").disabled = false;
  }
}

async function handleContribute() {
  const amountUi = parseFloat(el("contribute-amount").value);
  if (!Number.isFinite(amountUi) || amountUi <= 0) return showStatusBanner("warn", "Enter an amount greater than zero.");

  const cluster = currentCluster();
  clearStatusBanner();
  el("contribute-btn").disabled = true;
  setTxStatus("contribute", "Waiting for your browser's passkey prompt");

  try {
    const result = await contributeToGoal({
      connection: state.connection,
      walletHandle: state.wallet,
      vaultPda: state.vaultPda,
      goalPda: state.goalPda,
      goalTokenAccount: state.goalTokenAccount,
      goalMint: cluster.goalMint,
      amountUi,
      decimals: cluster.goalMintDecimals,
      credentialId: state.credentialId,
      rpId,
    });
    setTxStatus("contribute", "Confirming on-chain");
    setTxLink("contribute", result.signature);
    refreshGoalDisplay();
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
    el("contribute-status").classList.add("hidden");
  } finally {
    el("contribute-btn").disabled = false;
  }
}

// --- Init ------------------------------------------------------------

function init() {
  checkOriginBanner();
  populateNetworkMenu();
  setupNetworkControl();
  setupTabs();
  state.connection = new web3.Connection(currentCluster().rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: currentCluster().wsUrl,
  });
  verifyConnectionGenesis(state.connection, currentCluster().expectedGenesisHash).then((ok) => {
    if (!ok) console.error(`Connection genesis mismatch on ${currentCluster().label} — check config.js`);
  });
  el("program-link").href = currentCluster().explorerAddressUrl(PROGRAM_ID);

  el("connect-btn").addEventListener("click", () => {
    try {
      const handles = discoverWallets();
      if (handles.length === 1) {
        connectWith(handles[0]);
      } else {
        renderWalletPicker(handles);
      }
    } catch (err) {
      showStatusBanner("error", `Could not check for installed wallets: ${err.message || err}`);
    }
  });
  el("disconnect-btn").addEventListener("click", disconnect);
  el("create-btn").addEventListener("click", handleCreate);
  el("fund-btn").addEventListener("click", handleFund);
  el("contribute-btn").addEventListener("click", handleContribute);
  el("authorize-recurring-btn").addEventListener("click", handleAuthorizeRecurring);
  el("cancel-recurring-btn").addEventListener("click", handleCancelRecurring);
}

init();
