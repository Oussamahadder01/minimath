#!/usr/bin/env node
// Entry point for the MiniMath license service (`npm run service`).
import { runLicenseService } from "../src/services/license-service.mjs";

runLicenseService().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
