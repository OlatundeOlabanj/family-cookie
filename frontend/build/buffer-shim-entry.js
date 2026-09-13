// Sets window.Buffer before anything else loads. Split into its own
// script/bundle deliberately: ES module evaluation order means a
// trailing `window.Buffer = Buffer` inside a bundle that also imports
// @solana/web3.js, @coral-xyz/anchor, @solana/spl-token, and
// @wallet-standard/core runs AFTER those imports' own module bodies
// have already executed - and some of that code references bare
// Buffer during its own evaluation, before the assignment ever runs.
// A separate, first-loaded script sidesteps the ordering problem
// entirely instead of depending on where a line sits in one bundle.
import { Buffer } from "buffer";
window.Buffer = Buffer;
