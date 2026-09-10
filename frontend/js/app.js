// App orchestration. Made by TJS Code
import { CLUSTERS, DEFAULT_CLUSTER, EXPECTED_ORIGIN, PROGRAM_ID } from "./config.js";
import { discoverWallets } from "./wallet.js";
import {
  createVaultAndGoal,
  fundWalletAuthority,
  contributeToGoal,
  fetchGoal,
  fetchGoalBalance,
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

// --- Cluster select ------------------------------------------------------

function populateClusterSelect() {
  const select = el("cluster-select");
  select.innerHTML = "";
  for (const [key, cfg] of Object.entries(CLUSTERS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = cfg.label;
    select.appendChild(opt);
  }
  select.value = state.clusterKey;
  select.addEventListener("change", () => {
    state.clusterKey = select.value;
    state.connection = new web3.Connection(currentCluster().rpcUrl, "confirmed");
    el("program-link").href = currentCluster().explorerAddressUrl(PROGRAM_ID);
    resetFlowUI();
    if (state.wallet) tryRestoreForCurrentWallet();
  });
}

// --- Wallet connect ------------------------------------------------------

function renderWalletPicker(handles) {
  const list = el("wallet-picker-list");
  list.innerHTML = "";
  if (handles.length === 0) {
    el("wallet-picker-desc").textContent =
      "No Wallet Standard wallet detected. This build requires Nightly - install it from nightly.app and reload.";
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
  try {
    clearStatusBanner();
    await handle.connect();
    state.wallet = handle;
    el("wallet-picker-panel").classList.add("hidden");
    onWalletConnected();
  } catch (err) {
    const described = describeTransactionError(err);
    showStatusBanner(described.kind === "rejected" ? "warn" : "error", described.message);
  }
}

function onWalletConnected() {
  el("status-dot").classList.add("connected");
  el("wallet-address").textContent = truncate(state.wallet.publicKey.toBase58());
  el("connect-btn").classList.add("hidden");
  el("disconnect-btn").classList.remove("hidden");
  el("app-main").classList.remove("hidden");
  tryRestoreForCurrentWallet();
}

function tryRestoreForCurrentWallet() {
  if (restore()) {
    revealPostCreateSteps();
    refreshGoalDisplay();
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
  el("app-main").classList.add("hidden");
  clearStatusBanner();
}

// --- Flow UI ------------------------------------------------------------

function resetFlowUI() {
  el("step-fund").classList.add("hidden");
  el("step-contribute").classList.add("hidden");
  el("vault-details").classList.add("hidden");
  el("step-create").classList.remove("hidden");
  el("step-create").classList.add("active");
}

function revealPostCreateSteps() {
  el("step-fund").classList.remove("hidden");
  el("step-contribute").classList.remove("hidden");
  el("vault-details").classList.remove("hidden");
  el("step-create").classList.remove("active");
  el("step-create").classList.add("done");
  el("detail-vault").textContent = state.vaultPda.toBase58();
  el("detail-goal").textContent = state.goalPda.toBase58();
  el("detail-goal-ata").textContent = state.goalTokenAccount.toBase58();
}

function setTxStatus(idPrefix, text, done = false) {
  const box = el(`${idPrefix}-status`);
  box.classList.remove("hidden");
  box.innerHTML = done
    ? `<span>${text}</span>`
    : `<span class="spinner"></span><span>${text}</span>`;
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
  } catch (err) {
    // Non-fatal - balance display just stays at its last known value.
  }
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
    revealPostCreateSteps();
    refreshGoalDisplay();
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
  setTxStatus("contribute", "Building transaction");

  try {
    setTxStatus("contribute", "Waiting for your browser's passkey prompt");
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
  populateClusterSelect();
  state.connection = new web3.Connection(currentCluster().rpcUrl, "confirmed");
  el("program-link").href = currentCluster().explorerAddressUrl(PROGRAM_ID);

  el("connect-btn").addEventListener("click", () => {
    const handles = discoverWallets();
    if (handles.length === 1) {
      connectWith(handles[0]);
    } else {
      renderWalletPicker(handles);
    }
  });
  el("disconnect-btn").addEventListener("click", disconnect);
  el("create-btn").addEventListener("click", handleCreate);
  el("fund-btn").addEventListener("click", handleFund);
  el("contribute-btn").addEventListener("click", handleContribute);
}

init();
