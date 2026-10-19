#!/usr/bin/env node
// MiniMath license helper — the counterpart of MathType's System\MathTypeLib.exe.
//
// The app spawns this process and talks to it with one JSON object per line
// over stdin/stdout ("PipeCom"):
//   -> {"id":1,"command":"getLicenseState"}
//   <- {"id":1,"ok":true,"result":{"state":"trial","daysLeft":29,...}}
// stdout carries protocol lines only; diagnostics go to stderr.
//
// The helper owns everything licensing-related: trial clock, product key,
// activation with the license service, offline token verification, and
// opt-in telemetry. The editor never sees the token or the signing scheme.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { APP_NAME, APP_VERSION, config } from "../config.mjs";
import { maskProductKey, normalizeProductKey } from "../license/product-key.mjs";
import { verifyToken } from "../license/token.mjs";

const DAY_MS = 86_400_000;
const MAX_LINE_BYTES = 1_000_000;
const MAX_QUEUED_EVENTS = 200;
const TELEMETRY_FLUSH_MS = 60_000;
const SERVICE_TIMEOUT_MS = 8_000;

const log = (...parts) => process.stderr.write(`[mtlib] ${parts.join(" ")}\n`);

class HelperError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- storage

const storePath = () => join(config.helperHome, "license.json");

async function loadStore() {
  let store = {};
  try {
    store = JSON.parse(await readFile(storePath(), "utf8"));
    if (typeof store !== "object" || store === null) store = {};
  } catch (error) {
    if (error.code !== "ENOENT") log(`license.json unreadable (${error.message}); starting a fresh store`);
  }
  let changed = false;
  if (typeof store.installId !== "string") {
    store.installId = randomUUID();
    changed = true;
  }
  if (typeof store.trialStartedAt !== "string" || Number.isNaN(Date.parse(store.trialStartedAt))) {
    store.trialStartedAt = config.now().toISOString();
    changed = true;
  }
  if (typeof store.telemetry !== "object" || store.telemetry === null) {
    store.telemetry = { enabled: false };
    changed = true;
  }
  if (changed) await saveStore(store);
  return store;
}

async function saveStore(store) {
  await mkdir(config.helperHome, { recursive: true });
  const target = storePath();
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

// ---------------------------------------------------------------- license

/** Stable, non-reversible machine identifier sent at activation. */
export function machineHash() {
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = "";
  }
  return createHash("sha256")
    .update(["minimath-machine", hostname(), user, process.platform, process.arch].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

async function readPublicKey() {
  try {
    return await readFile(config.publicKeyPath, "utf8");
  } catch {
    return null;
  }
}

async function licenseState(store) {
  const machine = machineHash();
  const base = { trialDays: config.trialDays, machine, productKey: maskProductKey(store.productKey) };
  let warning;
  if (store.token) {
    const publicKey = await readPublicKey();
    const checked = publicKey ? verifyToken(store.token, publicKey) : { ok: false, error: "no public key configured" };
    if (checked.ok && checked.payload.machine === machine && checked.payload.key === store.productKey) {
      return { ...base, state: "licensed", daysLeft: null, licensedTo: checked.payload.email ?? null };
    }
    warning = checked.ok ? "stored license belongs to another machine or key" : `stored license rejected: ${checked.error}`;
  }
  const started = Date.parse(store.trialStartedAt);
  const now = config.now().getTime();
  // A clock set before the trial began is treated as day 0, not as extra days.
  const daysUsed = Math.max(0, Math.floor((now - started) / DAY_MS));
  const daysLeft = Math.max(0, config.trialDays - daysUsed);
  return { ...base, state: daysLeft > 0 ? "trial" : "expired", daysLeft, ...(warning ? { warning } : {}) };
}

async function callService(path, body) {
  let response;
  try {
    response = await fetch(`${config.licenseServiceUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HelperError("service_unavailable", `License service unreachable at ${config.licenseServiceUrl}: ${error.message}`);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new HelperError(payload?.error?.code ?? "service_error", payload?.error?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

// ---------------------------------------------------------------- telemetry

const queue = [];

function sanitizeProps(props) {
  const clean = {};
  if (typeof props !== "object" || props === null) return clean;
  for (const [key, value] of Object.entries(props).slice(0, 10)) {
    if (!/^[A-Za-z][\w.-]{0,39}$/.test(key)) continue;
    if (typeof value === "string") clean[key] = value.slice(0, 100);
    else if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === "boolean") clean[key] = value;
  }
  return clean;
}

async function flushTelemetry(store) {
  if (!store.telemetry.enabled || queue.length === 0) return { sent: 0 };
  const batch = queue.splice(0, queue.length);
  try {
    await callService("/v1/events", { installId: store.installId, app: APP_NAME, appVersion: APP_VERSION, events: batch });
    return { sent: batch.length };
  } catch (error) {
    queue.unshift(...batch.slice(-(MAX_QUEUED_EVENTS - queue.length)));
    throw error;
  }
}

// ---------------------------------------------------------------- commands

let watchdog = null;

function watchParent(pid) {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        log(`parent ${pid} is gone; exiting`);
        process.exit(0);
      }
    }
  }, 2_000);
  watchdog.unref();
}

async function handle(store, message) {
  switch (message.command) {
    case "ping":
      return { pong: true, version: APP_VERSION };
    case "setParentPID": {
      const pid = message.parentPID;
      if (!Number.isInteger(pid) || pid <= 0) throw new HelperError("bad_request", "parentPID must be a positive integer");
      watchParent(pid);
      return { watching: pid };
    }
    case "getLicenseState":
      return licenseState(store);
    case "getProductKey":
      return { productKey: maskProductKey(store.productKey) };
    case "activate": {
      const key = normalizeProductKey(message.productKey);
      if (!key) throw new HelperError("invalid_key", "That is not a valid MiniMath product key (MM1-XXXXXX-XXXXX).");
      const publicKey = await readPublicKey();
      if (!publicKey) throw new HelperError("not_configured", "No license public key is installed; run `npm run keys`.");
      const machine = machineHash();
      const reply = await callService("/v1/activate", { productKey: key, machine, app: APP_NAME, appVersion: APP_VERSION });
      const checked = verifyToken(reply?.token, publicKey);
      if (!checked.ok) throw new HelperError("bad_token", `License service returned an unverifiable token: ${checked.error}`);
      if (checked.payload.machine !== machine || checked.payload.key !== key) {
        throw new HelperError("bad_token", "License service returned a token for a different machine or key.");
      }
      store.productKey = key;
      store.token = reply.token;
      await saveStore(store);
      return licenseState(store);
    }
    case "deactivate": {
      if (!store.productKey) return { released: false, state: await licenseState(store) };
      let released = false;
      let warning;
      try {
        released = (await callService("/v1/deactivate", { productKey: store.productKey, machine: machineHash() }))?.released === true;
      } catch (error) {
        warning = `Removed locally, but the service could not release this machine's seat: ${error.message}`;
      }
      delete store.productKey;
      delete store.token;
      await saveStore(store);
      return { released, ...(warning ? { warning } : {}), state: await licenseState(store) };
    }
    case "getTelemetryConsent":
      return { enabled: store.telemetry.enabled === true };
    case "setTelemetryConsent": {
      if (typeof message.enabled !== "boolean") throw new HelperError("bad_request", "enabled must be a boolean");
      store.telemetry.enabled = message.enabled;
      if (!message.enabled) queue.length = 0;
      await saveStore(store);
      return { enabled: store.telemetry.enabled };
    }
    case "track": {
      if (!store.telemetry.enabled) return { queued: false };
      if (typeof message.event !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(message.event)) {
        throw new HelperError("bad_request", "event must be a short snake_case name");
      }
      if (queue.length >= MAX_QUEUED_EVENTS) queue.shift();
      queue.push({ name: message.event, at: config.now().toISOString(), props: sanitizeProps(message.props) });
      return { queued: true };
    }
    case "flushTelemetry":
      return flushTelemetry(store);
    case "shutdown":
      setImmediate(() => shutdown(store, 0));
      return { stopping: true };
    default:
      throw new HelperError("unknown_command", `Unknown command ${JSON.stringify(message.command)}`);
  }
}

let stopping = false;
async function shutdown(store, code) {
  if (stopping) return;
  stopping = true;
  try {
    await flushTelemetry(store);
  } catch (error) {
    log(`telemetry not sent at shutdown: ${error.message}`);
  }
  process.exit(code);
}

function reply(object) {
  process.stdout.write(`${JSON.stringify(object)}\n`);
}

async function main() {
  const store = await loadStore();
  const flusher = setInterval(() => {
    flushTelemetry(store).catch((error) => log(`telemetry flush failed: ${error.message}`));
  }, TELEMETRY_FLUSH_MS);
  flusher.unref();

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Requests are handled strictly in order, like MathType's blocking PipeCom.
  let chain = Promise.resolve();
  lines.on("line", (line) => {
    chain = chain.then(async () => {
      if (line.trim() === "") return;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        reply({ id: null, ok: false, error: { code: "bad_request", message: "message too large" } });
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        reply({ id: null, ok: false, error: { code: "bad_request", message: "message is not JSON" } });
        return;
      }
      const id = message?.id ?? null;
      try {
        reply({ id, ok: true, result: await handle(store, message ?? {}) });
      } catch (error) {
        const code = error instanceof HelperError ? error.code : "internal_error";
        if (code === "internal_error") log(error.stack ?? String(error));
        reply({ id, ok: false, error: { code, message: error.message } });
      }
    });
  });
  // The parent closing our stdin is the primary "parent went away" signal;
  // the PID watchdog only covers parents that leak the pipe to other processes.
  lines.on("close", () => chain.then(() => shutdown(store, 0)));
}

main().catch((error) => {
  log(error.stack ?? String(error));
  process.exit(1);
});
