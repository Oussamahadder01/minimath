#!/usr/bin/env node
// Prepare src-tauri for building: write the Word add-in manifest, copy a
// Node.js binary into src-tauri/binaries/ so installers ship their own
// runtime, and make sure the license public key exists (the bundle includes config/).
//
// By default the running Node.js is bundled. Set MINIMATH_NODE_BINARY to
// bundle another one, e.g. an x64 Node.js when building an Intel Mac app on
// an Apple Silicon machine.

import { access, chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT, config } from "../src/config.mjs";
import { buildAddin } from "./lib/addin.mjs";

// The Word add-in manifest the app registers; MINIMATH_ADDIN_URL selects its host.
await buildAddin({ site: false });

const source = process.env.MINIMATH_NODE_BINARY ?? process.execPath;
const target = join(PROJECT_ROOT, "src-tauri", "binaries", process.platform === "win32" ? "node.exe" : "node");
await mkdir(join(target, ".."), { recursive: true });
const [sourceInfo, existing] = await Promise.all([stat(source), stat(target).catch(() => null)]);
if (!existing || existing.size !== sourceInfo.size || existing.mtimeMs < sourceInfo.mtimeMs) {
  await copyFile(source, target);
  if (process.platform !== "win32") await chmod(target, 0o755);
  console.log(`Bundling Node.js from ${source} as ${target}`);
} else {
  console.log(`Node.js runtime already prepared at ${target}`);
}

try {
  await access(config.publicKeyPath);
} catch {
  console.error(`Missing ${config.publicKeyPath}. Run \`npm run keys\` before building the desktop app.`);
  process.exit(1);
}
