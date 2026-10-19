#!/usr/bin/env node
// Entry point for the MiniMath app server (`npm start`, and the process the
// desktop shell launches).
import { runServer } from "../src/server/app.mjs";

runServer().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
