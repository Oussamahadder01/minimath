// Product keys look like MM1-7K2QXD-9P4WF: a fixed prefix, then 10 Crockford
// base32 characters, the last of which is a checksum so typos are caught
// locally before any network request.

import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "MM1";

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 1);
  return ALPHABET[sum % ALPHABET.length];
}

export function normalizeProductKey(input) {
  if (typeof input !== "string") return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!compact.startsWith(PREFIX) || compact.length !== PREFIX.length + 11) return null;
  const chars = compact.slice(PREFIX.length);
  if (![...chars].every((c) => ALPHABET.includes(c))) return null;
  if (checksum(chars.slice(0, 10)) !== chars[10]) return null;
  return `${PREFIX}-${chars.slice(0, 6)}-${chars.slice(6)}`;
}

export function generateProductKey() {
  let body = "";
  for (let i = 0; i < 10; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  const chars = body + checksum(body);
  return `${PREFIX}-${chars.slice(0, 6)}-${chars.slice(6)}`;
}

/** Display form that never reveals the whole key, e.g. MM1-******-*9P4WF. */
export function maskProductKey(key) {
  if (!key) return "";
  return `${key.slice(0, 4)}******-${key.slice(-5)}`;
}
