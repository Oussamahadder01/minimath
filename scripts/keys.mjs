#!/usr/bin/env node
// Create the license signing key pair.
//   private -> service-data/signing-key.pem   (stays with the license service)
//   public  -> config/license-public.pem      (ships with the app/helper)
// Refuses to overwrite an existing key unless --force is given, because
// replacing it invalidates every activation already issued.

import { generateKeyPairSync } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../src/config.mjs";

const force = process.argv.includes("--force");
const privatePath = join(config.serviceDataDir, "signing-key.pem");
const publicPath = config.publicKeyPath;

const exists = await access(privatePath).then(() => true, () => false);
if (exists && !force) {
  console.error(`${privatePath} already exists. Re-run with --force to replace it (existing activations stop verifying).`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
await mkdir(dirname(privatePath), { recursive: true });
await mkdir(dirname(publicPath), { recursive: true });
await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }));
console.log(`private key: ${privatePath}\npublic key:  ${publicPath}`);
