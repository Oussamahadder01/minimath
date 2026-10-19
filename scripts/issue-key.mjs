#!/usr/bin/env node
// Register a new product key with the license service's key database.
//   npm run issue-key -- --email someone@example.com [--machines 2]

import { parseArgs } from "node:util";
import { config } from "../src/config.mjs";
import { generateProductKey } from "../src/license/product-key.mjs";
import { loadKeyDatabase, saveKeyDatabase } from "../src/services/license-service.mjs";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    machines: { type: "string", default: "2" },
  },
});

const maxMachines = Number(values.machines);
if (!Number.isInteger(maxMachines) || maxMachines < 1 || maxMachines > 100) {
  console.error("--machines must be an integer from 1 to 100");
  process.exit(1);
}

const db = await loadKeyDatabase(config.serviceDataDir);
let key;
do key = generateProductKey();
while (db.keys[key]);
db.keys[key] = { email: values.email ?? null, maxMachines, createdAt: new Date().toISOString(), activations: [] };
await saveKeyDatabase(config.serviceDataDir, db);
console.log(key);
