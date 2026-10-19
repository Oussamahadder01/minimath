// Activation tokens: base64url(JSON payload) "." base64url(Ed25519 signature).
// The license service signs; the helper verifies offline with the public key,
// so the app keeps working without network once activated.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

export function signToken(payload, privateKeyPem) {
  const body = b64url(JSON.stringify(payload));
  const signature = sign(null, Buffer.from(body), createPrivateKey(privateKeyPem));
  return `${body}.${b64url(signature)}`;
}

/** Returns { ok: true, payload } or { ok: false, error } — never throws on bad input. */
export function verifyToken(token, publicKeyPem) {
  if (typeof token !== "string" || token.length > 4096) return { ok: false, error: "token is not a string" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "token is not two dot-separated parts" };
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch (error) {
    return { ok: false, error: `public key unusable: ${error.message}` };
  }
  const [body, signature] = parts;
  let valid = false;
  try {
    valid = verify(null, Buffer.from(body), key, Buffer.from(signature, "base64url"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "signature does not verify" };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || payload.v !== 1) {
      return { ok: false, error: "unsupported token payload" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, error: "payload is not JSON" };
  }
}
