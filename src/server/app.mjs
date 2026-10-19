// MiniMath local app server: serves the editor UI and the Office add-in,
// renders equations, runs translators, and is the only owner of the license
// helper process. Binds to 127.0.0.1 only.

import { readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join, resolve, sep } from "node:path";
import { APP_VERSION, PROJECT_ROOT, config } from "../config.mjs";
import { RenderError, renderSvg } from "../render/mathjax.mjs";
import { parsePrefs } from "../shared/eqfile.mjs";
import { MathMLParseError } from "../shared/mathml.mjs";
import { translateMathML, validateRuleSet } from "../shared/translator.mjs";
import { HelperClient, HelperReplyError, HelperUnavailableError } from "./helper-client.mjs";
import { loadSettings, parseSettings, saveSettings } from "./settings.mjs";

const HELPER_ERROR_STATUS = {
  helper_unavailable: 503,
  service_unavailable: 503,
  not_configured: 503,
  key_not_found: 404,
  too_many_machines: 409,
  internal_error: 500,
};
const MAX_BODY_BYTES = 1_000_000;
const MAX_SOURCE_CHARS = 20_000;
const LICENSE_CACHE_MS = 30_000;
const FREE_TRANSLATORS = new Set(["latex"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".xml": "application/xml; charset=utf-8",
};

// URL prefix -> directory. Anything outside these trees is never served.
const STATIC_ROOTS = {
  "/web/": join(PROJECT_ROOT, "web"),
  "/shared/": join(PROJECT_ROOT, "src", "shared"),
  "/office/": join(PROJECT_ROOT, "office"),
  "/vendor/mathlive/": join(PROJECT_ROOT, "node_modules", "mathlive"),
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function loadTranslators() {
  const dir = join(PROJECT_ROOT, "src", "shared", "translators");
  const translators = new Map();
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
    const rules = validateRuleSet(JSON.parse(await readFile(join(dir, file), "utf8")));
    translators.set(rules.id, rules);
  }
  // Display order comes from the rule files, not from file names.
  return new Map([...translators].sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99)));
}

async function loadPresets() {
  const dir = join(PROJECT_ROOT, "prefs");
  const presets = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = parsePrefs(JSON.parse(await readFile(join(dir, file), "utf8")));
    if (!parsed.ok) throw new Error(`prefs/${file}: ${parsed.error}`);
    presets.push({ id: file.replace(/\.json$/, ""), ...parsed.value });
  }
  return presets;
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

function requireSource(body) {
  const { latex, mathml } = body ?? {};
  for (const [name, value] of [["latex", latex], ["mathml", mathml]]) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > MAX_SOURCE_CHARS) {
      throw new ApiError(400, "invalid_request", `${name} must be a string of at most ${MAX_SOURCE_CHARS} characters`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new ApiError(400, "invalid_request", `${name} contains control characters`);
    }
  }
  if (latex === undefined && mathml === undefined) throw new ApiError(400, "invalid_request", "Provide latex or mathml");
  return { latex, mathml };
}

export async function createApp({ helperEnv = process.env } = {}) {
  const translators = await loadTranslators();
  const presets = await loadPresets();
  const helper = new HelperClient({ env: helperEnv });
  let licenseCache = null;

  async function license(force = false) {
    if (!force && licenseCache && Date.now() - licenseCache.at < LICENSE_CACHE_MS) return licenseCache.value;
    const value = await helper.send({ command: "getLicenseState" });
    licenseCache = { at: Date.now(), value };
    return value;
  }

  async function requireUsable(feature) {
    const state = await license();
    if (state.state === "expired") {
      throw new ApiError(402, "license_required", `Your trial has ended. Activate MiniMath to use ${feature}.`);
    }
  }

  const track = (event, props) => helper.send({ command: "track", event, props }).catch(() => {});

  const api = {
    "GET /api/health": async () => ({ ok: true, version: APP_VERSION }),
    "GET /api/translators": async () => ({
      translators: [...translators.values()].map(({ id, name, description }) => ({
        id,
        name,
        description,
        free: FREE_TRANSLATORS.has(id),
      })),
    }),
    "GET /api/prefs": async () => ({ presets }),
    "GET /api/settings": async () => loadSettings(),
    "POST /api/settings": async (body) => {
      const parsed = parseSettings({ ...(await loadSettings()), ...(body ?? {}) });
      if (!parsed.ok) throw new ApiError(400, "invalid_request", parsed.error);
      return saveSettings(parsed.value);
    },

    "POST /api/translate": async (body) => {
      const rules = translators.get(body?.translator);
      if (!rules) throw new ApiError(404, "unknown_translator", `No translator ${JSON.stringify(body?.translator)}`);
      const { mathml } = requireSource({ mathml: body?.mathml });
      if (mathml === undefined) throw new ApiError(400, "invalid_request", "mathml is required");
      if (!FREE_TRANSLATORS.has(rules.id)) await requireUsable(`the ${rules.name} translator`);
      try {
        const result = translateMathML(mathml, rules);
        track("translate", { translator: rules.id, ok: result.errors.length === 0 });
        return { translator: rules.id, ...result };
      } catch (error) {
        if (error instanceof MathMLParseError) throw new ApiError(400, "invalid_mathml", error.message);
        throw error;
      }
    },

    "POST /api/render": async (body) => {
      const source = requireSource(body);
      const prefs = parsePrefs(body?.prefs);
      if (!prefs.ok) throw new ApiError(400, "invalid_request", prefs.error);
      await requireUsable("image export");
      try {
        return renderSvg({ ...source, prefs: prefs.value });
      } catch (error) {
        if (error instanceof RenderError) throw new ApiError(422, "render_failed", error.message);
        throw error;
      }
    },

    "GET /api/license": async () => license(true),
    "POST /api/license/activate": async (body) => {
      const result = await helper.send({ command: "activate", productKey: body?.productKey });
      licenseCache = null;
      track("activate", { ok: true });
      return result;
    },
    "POST /api/license/deactivate": async () => {
      const result = await helper.send({ command: "deactivate" });
      licenseCache = null;
      return result;
    },
    "GET /api/telemetry": async () => helper.send({ command: "getTelemetryConsent" }),
    "POST /api/telemetry": async (body) => helper.send({ command: "setTelemetryConsent", enabled: body?.enabled }),
    "POST /api/telemetry/event": async (body) => helper.send({ command: "track", event: body?.event, props: body?.props }),
  };

  async function serveFile(response, filePath, extraHeaders = {}) {
    const data = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-cache",
      ...extraHeaders,
    });
    response.end(data);
  }

  async function serveStatic(response, pathname) {
    for (const [prefix, root] of Object.entries(STATIC_ROOTS)) {
      if (!pathname.startsWith(prefix)) continue;
      const target = resolve(root, decodeURIComponent(pathname.slice(prefix.length)));
      if (target !== root && !target.startsWith(root + sep)) return false;
      try {
        if (!(await stat(target)).isFile()) return false;
      } catch {
        return false;
      }
      await serveFile(response, target);
      return true;
    }
    return false;
  }

  function handler(request, response) {
    const sendJson = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    };
    (async () => {
      // DNS-rebinding guard: only answer requests addressed to this machine.
      const host = (request.headers.host ?? "").replace(/:\d+$/, "");
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) {
        throw new ApiError(421, "misdirected", "MiniMath only answers requests to localhost");
      }
      const { pathname } = new URL(request.url, "http://localhost");

      if (pathname.startsWith("/api/")) {
        // CSRF guard: browsers cannot add this header cross-origin without a
        // CORS preflight, which this server never approves.
        if (request.method === "POST" && request.headers["x-minimath"] !== "1") {
          throw new ApiError(403, "forbidden", "Missing X-MiniMath header");
        }
        const route = api[`${request.method} ${pathname}`];
        if (!route) throw new ApiError(404, "not_found", `No route for ${request.method} ${pathname}`);
        const body = request.method === "POST" ? await readJsonBody(request) : undefined;
        sendJson(200, await route(body));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw new ApiError(405, "method_not_allowed", "Use GET");
      if (pathname === "/" || pathname === "/index.html") {
        await serveFile(response, join(PROJECT_ROOT, "web", "index.html"));
        return;
      }
      if (!(await serveStatic(response, pathname))) throw new ApiError(404, "not_found", "Not found");
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ApiError) sendJson(error.status, { error: { code: error.code, message: error.message } });
      else if (error instanceof HelperUnavailableError || error instanceof HelperReplyError) {
        sendJson(HELPER_ERROR_STATUS[error.code] ?? 400, { error: { code: error.code, message: error.message } });
      } else {
        process.stderr.write(`[minimath] ${error.stack ?? error}\n`);
        sendJson(500, { error: { code: "internal_error", message: "Internal error" } });
      }
    });
  }

  return { handler, helper, translators, presets };
}

async function readDevCert() {
  try {
    const [cert, key] = await Promise.all([
      readFile(join(config.devCertDir, "localhost.crt")),
      readFile(join(config.devCertDir, "localhost.key")),
    ]);
    return { cert, key };
  } catch {
    return null;
  }
}

/** Start the HTTP (and, with dev certificates, HTTPS) servers. Entry point: bin/minimath-server.mjs. */
export async function runServer() {
  const app = await createApp();
  const http = createHttpServer(app.handler);
  const servers = [http];
  await new Promise((resolveListen, reject) => {
    http.once("error", reject);
    http.listen(config.appPort, "127.0.0.1", resolveListen);
  });
  const url = `http://127.0.0.1:${http.address().port}`;
  // Machine-readable readiness line: the Tauri shell waits for it.
  console.log(`MINIMATH_LISTENING ${url}`);
  console.log(`MiniMath ${APP_VERSION} is running at ${url}`);

  const tls = await readDevCert();
  if (tls) {
    const https = createHttpsServer(tls, app.handler);
    servers.push(https);
    https.on("error", (error) => console.error(`HTTPS (Office add-in) disabled: ${error.message}`));
    https.listen(config.appHttpsPort, "127.0.0.1", () => {
      console.log(`Office add-in endpoint: https://localhost:${https.address().port}/office/taskpane.html`);
    });
  } else {
    console.log(`Office add-in disabled: no dev certificate in ${config.devCertDir} (see README).`);
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const server of servers) server.close();
    await app.helper.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // When launched by the desktop shell, a closed stdin means the shell is gone.
  if (process.env.MINIMATH_EXIT_ON_STDIN_CLOSE === "1") {
    process.stdin.on("end", stop);
    process.stdin.on("close", stop);
    process.stdin.resume();
  }
}
