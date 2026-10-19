// One place for paths, ports and URLs. Every value can be overridden with an
// environment variable so tests and deployments never touch the defaults.

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_NAME = "MiniMath";
export const APP_VERSION = "0.1.2";

function userDataRoot() {
  if (process.platform === "win32") return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export const config = {
  /** Where the license helper keeps license.json (trial start, token, consent). */
  get helperHome() {
    return process.env.MINIMATH_HOME ?? join(userDataRoot(), APP_NAME);
  },
  /** Public half of the service signing key; written by `npm run keys`. */
  get publicKeyPath() {
    return process.env.MINIMATH_PUBLIC_KEY ?? join(PROJECT_ROOT, "config", "license-public.pem");
  },
  get licenseServiceUrl() {
    return (process.env.MINIMATH_LICENSE_URL ?? "http://127.0.0.1:5180").replace(/\/+$/, "");
  },
  get trialDays() {
    const days = Number(process.env.MINIMATH_TRIAL_DAYS ?? 30);
    return Number.isInteger(days) && days >= 0 ? days : 30;
  },
  /** Test hook: pretend the current time is this ISO instant. */
  now() {
    return process.env.MINIMATH_NOW ? new Date(process.env.MINIMATH_NOW) : new Date();
  },
  get serviceDataDir() {
    return process.env.MINIMATH_SERVICE_DATA ?? join(PROJECT_ROOT, "service-data");
  },
  get servicePort() {
    return Number(process.env.MINIMATH_SERVICE_PORT ?? 5180);
  },
  get appPort() {
    return Number(process.env.MINIMATH_PORT ?? 5178);
  },
  get appHttpsPort() {
    return Number(process.env.MINIMATH_HTTPS_PORT ?? 5179);
  },
  /** TLS files for the Office add-in (Office requires HTTPS). */
  get devCertDir() {
    return process.env.MINIMATH_CERT_DIR ?? join(homedir(), ".office-addin-dev-certs");
  },
};
