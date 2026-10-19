// MiniMath license service: the server side of activation and telemetry.
//
//   POST /v1/activate   {productKey, machine}  -> {token}   (Ed25519-signed)
//   POST /v1/deactivate {productKey, machine}  -> {released}
//   POST /v1/events     {installId, events[]}  -> {accepted} (opt-in telemetry)
//   GET  /healthz
//
// State lives in plain JSON files under service-data/ so it is easy to
// inspect; swap in a database before running this for real customers.

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { config } from "../config.mjs";
import { normalizeProductKey } from "../license/product-key.mjs";
import { signToken } from "../license/token.mjs";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_BATCH = 200;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function loadKeyDatabase(dataDir) {
  try {
    const db = JSON.parse(await readFile(join(dataDir, "keys.json"), "utf8"));
    if (typeof db?.keys !== "object" || db.keys === null) throw new Error("keys.json has no keys object");
    return db;
  } catch (error) {
    if (error.code === "ENOENT") return { keys: {} };
    throw error;
  }
}

export async function saveKeyDatabase(dataDir, db) {
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, "keys.json");
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

async function readJsonBody(request) {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) {
    throw new ApiError(415, "unsupported_media_type", "Send application/json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "too_large", "Request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_request", "Body is not JSON");
  }
}

function requireMachine(body) {
  if (typeof body?.machine !== "string" || !/^[0-9a-f]{32}$/.test(body.machine)) {
    throw new ApiError(400, "invalid_request", "machine must be a 32-character hex hash");
  }
  return body.machine;
}

function requireKey(body) {
  const key = normalizeProductKey(body?.productKey);
  if (!key) throw new ApiError(400, "invalid_key", "That is not a valid MiniMath product key.");
  return key;
}

export async function createLicenseService({ dataDir = config.serviceDataDir } = {}) {
  const privateKey = await readFile(join(dataDir, "signing-key.pem"), "utf8").catch(() => {
    throw new Error(`No signing key in ${dataDir}. Run \`npm run keys\` first.`);
  });
  // Serialize every read-modify-write of keys.json.
  let writes = Promise.resolve();
  const withDatabase = (fn) => {
    const run = writes.then(async () => {
      const db = await loadKeyDatabase(dataDir);
      const result = await fn(db);
      if (result?.dirty) await saveKeyDatabase(dataDir, db);
      return result.value;
    });
    writes = run.catch(() => {});
    return run;
  };

  const routes = {
    "GET /healthz": async () => ({ ok: true }),

    "POST /v1/activate": async (body) => {
      const key = requireKey(body);
      const machine = requireMachine(body);
      return withDatabase((db) => {
        const record = db.keys[key];
        if (!record || record.revoked) throw new ApiError(404, "key_not_found", "This product key is not registered.");
        record.activations ??= [];
        const existing = record.activations.find((a) => a.machine === machine);
        if (!existing && record.activations.length >= (record.maxMachines ?? 2)) {
          throw new ApiError(409, "too_many_machines", `This key is already active on ${record.activations.length} machine(s). Deactivate one first.`);
        }
        const now = new Date().toISOString();
        if (existing) existing.lastActivatedAt = now;
        else record.activations.push({ machine, activatedAt: now, lastActivatedAt: now });
        const payload = { v: 1, iss: "minimath-license-service", key, machine, email: record.email ?? null, iat: now };
        return { dirty: true, value: { token: signToken(payload, privateKey), activations: record.activations.length } };
      });
    },

    "POST /v1/deactivate": async (body) => {
      const key = requireKey(body);
      const machine = requireMachine(body);
      return withDatabase((db) => {
        const record = db.keys[key];
        if (!record) return { dirty: false, value: { released: false } };
        const before = record.activations?.length ?? 0;
        record.activations = (record.activations ?? []).filter((a) => a.machine !== machine);
        return { dirty: record.activations.length !== before, value: { released: record.activations.length !== before } };
      });
    },

    "POST /v1/events": async (body) => {
      if (typeof body?.installId !== "string" || !/^[0-9a-f-]{36}$/.test(body.installId)) {
        throw new ApiError(400, "invalid_request", "installId must be a UUID");
      }
      if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS_PER_BATCH) {
        throw new ApiError(400, "invalid_request", `events must be an array of at most ${MAX_EVENTS_PER_BATCH}`);
      }
      const received = new Date().toISOString();
      const lines = body.events
        .filter((e) => typeof e?.name === "string" && e.name.length <= 40)
        .map((e) =>
          JSON.stringify({
            received,
            installId: body.installId,
            appVersion: typeof body.appVersion === "string" ? body.appVersion.slice(0, 20) : null,
            name: e.name,
            at: typeof e.at === "string" ? e.at.slice(0, 40) : null,
            props: typeof e.props === "object" && e.props !== null ? e.props : {},
          }),
        );
      if (lines.length) {
        await mkdir(dataDir, { recursive: true });
        await appendFile(join(dataDir, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");
      }
      return { accepted: lines.length };
    },
  };

  return createServer(async (request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    };
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      const route = routes[`${request.method} ${path}`];
      if (!route) throw new ApiError(404, "not_found", `No route for ${request.method} ${path}`);
      const body = request.method === "POST" ? await readJsonBody(request) : undefined;
      send(200, await route(body));
    } catch (error) {
      if (error instanceof ApiError) send(error.status, { error: { code: error.code, message: error.message } });
      else {
        process.stderr.write(`[license-service] ${error.stack ?? error}\n`);
        send(500, { error: { code: "internal_error", message: "Internal error" } });
      }
    }
  });
}

/** Entry point: bin/license-service.mjs. */
export async function runLicenseService() {
  const server = await createLicenseService();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.servicePort, "127.0.0.1", resolve);
  });
  console.log(`MiniMath license service on http://127.0.0.1:${server.address().port} (data: ${config.serviceDataDir})`);
  return server;
}
