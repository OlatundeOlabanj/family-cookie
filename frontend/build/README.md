# Vendor bundle build

Regenerates js/vendor/fw-vendor.bundle.js - the bundled @coral-xyz/anchor,
@solana/web3.js, @solana/spl-token, and @wallet-standard/core, exposed as
window.FW_VENDOR. Bundled locally rather than loaded from a CDN at runtime,
so the app doesn't depend on a third-party CDN staying up.

Run after changing any vendored dependency version:

    npm install
    npx esbuild vendor-entry.js --bundle --format=iife --platform=browser \
      --target=es2020 --minify \
      --define:process.env.NODE_ENV='"production"' \
      --outfile=../js/vendor/fw-vendor.bundle.js

node_modules/ is not checked in - run npm install first.
