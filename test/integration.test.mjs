// Real processes end to end: license service + app server + license helper,
// each with isolated data directories and an ephemeral port.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateProductKey } from "../src/license/product-key.mjs";

const HELPER = fileURLToPath(new URL("../src/helper/mtlib.mjs", import.meta.url));
let workDir;
let serviceServer;
let serviceUrl;
let baseEnv;
const apps = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

async function startApp(extraEnv = {}) {
  const { createApp } = await import("../src/server/app.mjs");
  const app = await createApp({ helperEnv: { ...baseEnv, ...extraEnv } });
  const server = createServer(app.handler);
  const url = await listen(server);
  apps.push({ app, server });
  const call = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json", "x-minimath": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { url, call, app };
}

async function serviceCall(path, body) {
  const response = await fetch(`${serviceUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "minimath-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const serviceData = join(workDir, "service");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(serviceData, { recursive: true });
  await writeFile(join(serviceData, "signing-key.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
  await writeFile(join(workDir, "public.pem"), publicKey.export({ type: "spki", format: "pem" }));

  const { createLicenseService, saveKeyDatabase } = await import("../src/services/license-service.mjs");
  const keys = {};
  baseEnv = { ...process.env, MINIMATH_PUBLIC_KEY: join(workDir, "public.pem") };
  baseEnv.KEY_OK = generateProductKey();
  baseEnv.KEY_ONE_SEAT = generateProductKey();
  keys[baseEnv.KEY_OK] = { email: "ada@example.com", maxMachines: 2, activations: [] };
  keys[baseEnv.KEY_ONE_SEAT] = { email: null, maxMachines: 1, activations: [{ machine: "f".repeat(32), activatedAt: "x" }] };
  await saveKeyDatabase(serviceData, { keys });
  serviceServer = await createLicenseService({ dataDir: serviceData });
  serviceUrl = await listen(serviceServer);
  baseEnv.MINIMATH_LICENSE_URL = serviceUrl;
  baseEnv.MINIMATH_SERVICE_DATA = serviceData;
});

after(async () => {
  for (const { app, server } of apps) {
    server.close();
    await app.helper.close();
  }
  serviceServer?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("trial, activation, offline verification and deactivation", async () => {
  const home = join(workDir, "home-activate");
  const { call } = await startApp({ MINIMATH_HOME: home });

  const trial = await call("GET", "/api/license");
  assert.equal(trial.status, 200);
  assert.equal(trial.body.state, "trial");
  assert.equal(trial.body.daysLeft, 30);

  const malformed = await call("POST", "/api/license/activate", { productKey: "MM1-NOPE" });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, "invalid_key");

  const unknown = await call("POST", "/api/license/activate", { productKey: generateProductKey() });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "key_not_found");

  const full = await call("POST", "/api/license/activate", { productKey: baseEnv.KEY_ONE_SEAT });
  assert.equal(full.status, 409);
  assert.equal(full.body.error.code, "too_many_machines");

  const activated = await call("POST", "/api/license/activate", { productKey: baseEnv.KEY_OK.toLowerCase() });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal(activated.body.state, "licensed");
  assert.equal(activated.body.licensedTo, "ada@example.com");
  assert.ok(!JSON.stringify(activated.body).includes(baseEnv.KEY_OK), "full key is never echoed back");

  // The token is stored locally and keeps verifying without the service.
  const stored = JSON.parse(await readFile(join(home, "license.json"), "utf8"));
  assert.equal(stored.productKey, baseEnv.KEY_OK);
  assert.match(stored.token, /^[\w-]+\.[\w-]+$/);

  const db = JSON.parse(await readFile(join(baseEnv.MINIMATH_SERVICE_DATA, "keys.json"), "utf8"));
  assert.equal(db.keys[baseEnv.KEY_OK].activations.length, 1);

  const released = await call("POST", "/api/license/deactivate", {});
  assert.equal(released.body.released, true);
  assert.equal(released.body.state.state, "trial");
});

test("a tampered local token falls back to the trial", async () => {
  const home = join(workDir, "home-tamper");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "license.json"),
    JSON.stringify({ installId: "00000000-0000-4000-8000-000000000000", trialStartedAt: new Date().toISOString(), telemetry: { enabled: false }, productKey: baseEnv.KEY_OK, token: "e30.AAAA" }),
  );
  const { call } = await startApp({ MINIMATH_HOME: home });
  const state = await call("GET", "/api/license");
  assert.equal(state.body.state, "trial");
  assert.match(state.body.warning, /signature does not verify/);
});

test("an expired trial blocks premium exports but keeps LaTeX", async () => {
  const home = join(workDir, "home-expired");
  const first = await startApp({ MINIMATH_HOME: home, MINIMATH_NOW: "2026-01-01T00:00:00Z" });
  assert.equal((await first.call("GET", "/api/license")).body.daysLeft, 30);
  const later = await startApp({ MINIMATH_HOME: home, MINIMATH_NOW: "2026-02-15T00:00:00Z" });
  assert.equal((await later.call("GET", "/api/license")).body.state, "expired");

  const mathml = "<math><mi>x</mi></math>";
  assert.equal((await later.call("POST", "/api/translate", { translator: "latex", mathml })).status, 200);
  const blocked = await later.call("POST", "/api/translate", { translator: "asciimath", mathml });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.error.code, "license_required");
  assert.equal((await later.call("POST", "/api/render", { latex: "x" })).status, 402);
  assert.equal((await first.call("POST", "/api/render", { latex: "x" })).status, 200);
});

test("render, translate and request guards", async () => {
  const { call, url } = await startApp({ MINIMATH_HOME: join(workDir, "home-api") });
  const svg = await call("POST", "/api/render", { latex: "\\frac{a}{b}", prefs: { sizePt: 24, color: "#ff0000", display: true } });
  assert.equal(svg.status, 200);
  assert.match(svg.body.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg.body.svg, /#ff0000/);
  assert.ok(svg.body.widthPx > 10 && svg.body.heightPx > 10);

  assert.equal((await call("POST", "/api/render", { latex: "\\frac{" })).status, 422);
  assert.equal((await call("POST", "/api/render", { latex: "\u000cx" })).status, 400);
  assert.equal((await call("POST", "/api/render", { latex: "x", prefs: { sizePt: 1 } })).status, 400);
  assert.equal((await call("POST", "/api/translate", { translator: "latex", mathml: "<mi>" })).status, 400);
  assert.equal((await call("POST", "/api/translate", { translator: "nope", mathml: "<mi>x</mi>" })).status, 404);

  const list = await call("GET", "/api/translators");
  assert.deepEqual(list.body.translators.map((t) => t.id), ["latex", "asciimath", "speech", "omml"]);

  const noHeader = await fetch(`${url}/api/telemetry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(noHeader.status, 403);
  const page = await fetch(`${url}/`);
  assert.match(await page.text(), /<math-field/);
  assert.equal((await fetch(`${url}/web/..%2f..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${url}/vendor/mathlive/mathlive.min.mjs`)).status, 200);
});

test("telemetry is opt-in and reaches the service", async () => {
  const { call } = await startApp({ MINIMATH_HOME: join(workDir, "home-telemetry") });
  assert.equal((await call("GET", "/api/telemetry")).body.enabled, false);
  assert.equal((await call("POST", "/api/telemetry/event", { event: "ignored_event" })).body.queued, false);
  await call("POST", "/api/telemetry", { enabled: true });
  assert.equal((await call("POST", "/api/telemetry/event", { event: "export", props: { format: "png", secret: { nested: 1 } } })).body.queued, true);
  // Flushing happens on helper shutdown.
  await apps.at(-1).app.helper.close();
  const lines = (await readFile(join(baseEnv.MINIMATH_SERVICE_DATA, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const exported = lines.find((e) => e.name === "export");
  assert.deepEqual(exported.props, { format: "png" });
  assert.equal(lines.some((e) => e.name === "ignored_event"), false);
});

function spawnHelper(env) {
  const child = spawn(process.execPath, [HELPER], { env: { ...baseEnv, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const replies = [];
  const waiters = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else replies.push(message);
  });
  const send = (message) =>
    new Promise((resolve) => {
      waiters.push(resolve);
      child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
    });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, send, exited };
}

test("helper protocol: errors are structured and ids are echoed", async () => {
  const helper = spawnHelper({ MINIMATH_HOME: join(workDir, "home-proto") });
  assert.deepEqual(await helper.send("not json"), { id: null, ok: false, error: { code: "bad_request", message: "message is not JSON" } });
  const unknown = await helper.send({ id: 7, command: "selfDestruct" });
  assert.equal(unknown.id, 7);
  assert.equal(unknown.error.code, "unknown_command");
  assert.equal((await helper.send({ id: 8, command: "ping" })).result.pong, true);
  helper.child.stdin.end();
  assert.equal(await helper.exited, 0, "closing stdin stops the helper");
});

test("helper exits when the parent it watches is gone", async () => {
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  const helper = spawnHelper({ MINIMATH_HOME: join(workDir, "home-watchdog") });
  const reply = await helper.send({ id: 1, command: "setParentPID", parentPID: parent.pid });
  assert.equal(reply.result.watching, parent.pid);
  // stdin stays open: only the watchdog can end this helper.
  const code = await Promise.race([helper.exited, new Promise((r) => setTimeout(() => r("timeout"), 8_000))]);
  assert.equal(code, 0);
});
