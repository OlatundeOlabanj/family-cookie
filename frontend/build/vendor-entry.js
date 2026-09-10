// Vendor bundle entry point. Bundled with esbuild into a single IIFE
// so the app can be plain HTML/CSS/JS with no build step of its own
// and no runtime dependency on a third party CDN staying up.
// Made by TJS Code
import * as web3 from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import { getWallets } from "@wallet-standard/core";
import { Buffer } from "buffer";

window.Buffer = Buffer;
window.FW_VENDOR = { web3, anchor, splToken, getWallets };
