#!/usr/bin/env node
// Build the Word add-in site and manifest (see scripts/lib/addin.mjs).
//   --manifest-only   only write src-tauri/addin/manifest.xml
import { buildAddin } from "./lib/addin.mjs";

buildAddin({ site: !process.argv.includes("--manifest-only") }).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
