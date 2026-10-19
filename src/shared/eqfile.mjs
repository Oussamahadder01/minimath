// The .mmeq equation document: MiniMath's counterpart to MTEF.
// MathType keeps one binary record stream (MTEF) as the source of truth and
// embeds preferences in it. MiniMath keeps the editor source (LaTeX, which
// MathLive round-trips losslessly), the interchange form (MathML, which all
// translators consume), and the style preferences used to render it.

import { parseMathML } from "./mathml.mjs";

export const EQUATION_FORMAT = "minimath-equation";
export const EQUATION_VERSION = 1;

export const DEFAULT_PREFS = Object.freeze({
  name: "Default",
  sizePt: 12,
  color: "#000000",
  display: true,
});

function fail(message) {
  return { ok: false, error: message };
}

/** Validate untrusted preferences, filling defaults for absent fields. */
export function parsePrefs(raw) {
  if (raw === undefined) return { ok: true, value: { ...DEFAULT_PREFS } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("prefs must be an object");
  const prefs = { ...DEFAULT_PREFS };
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.length > 80) return fail("prefs.name must be a short string");
    prefs.name = raw.name;
  }
  if (raw.sizePt !== undefined) {
    if (typeof raw.sizePt !== "number" || !(raw.sizePt >= 4 && raw.sizePt <= 144)) {
      return fail("prefs.sizePt must be a number from 4 to 144");
    }
    prefs.sizePt = raw.sizePt;
  }
  if (raw.color !== undefined) {
    if (typeof raw.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(raw.color)) return fail("prefs.color must be #rrggbb");
    prefs.color = raw.color.toLowerCase();
  }
  if (raw.display !== undefined) {
    if (typeof raw.display !== "boolean") return fail("prefs.display must be a boolean");
    prefs.display = raw.display;
  }
  return { ok: true, value: prefs };
}

export function createEquation({ latex, mathml, prefs, app = "MiniMath" }) {
  return {
    format: EQUATION_FORMAT,
    version: EQUATION_VERSION,
    latex,
    mathml,
    prefs: { ...DEFAULT_PREFS, ...prefs },
    savedWith: app,
    savedAt: new Date().toISOString(),
  };
}

/** Parse and validate a .mmeq document. Returns { ok, value } or { ok: false, error }. */
export function parseEquationFile(text) {
  if (typeof text !== "string") return fail("equation file must be text");
  if (text.length > 1_000_000) return fail("equation file is larger than 1 MB");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return fail(`not valid JSON: ${error.message}`);
  }
  if (typeof doc !== "object" || doc === null) return fail("equation file must be a JSON object");
  if (doc.format !== EQUATION_FORMAT) return fail(`unknown format ${JSON.stringify(doc.format)}`);
  if (doc.version !== EQUATION_VERSION) return fail(`unsupported version ${JSON.stringify(doc.version)}`);
  if (typeof doc.latex !== "string") return fail("latex must be a string");
  if (typeof doc.mathml !== "string") return fail("mathml must be a string");
  try {
    parseMathML(doc.mathml);
  } catch (error) {
    return fail(`mathml is malformed: ${error.message}`);
  }
  const prefs = parsePrefs(doc.prefs);
  if (!prefs.ok) return prefs;
  return {
    ok: true,
    value: {
      format: EQUATION_FORMAT,
      version: EQUATION_VERSION,
      latex: doc.latex,
      mathml: doc.mathml,
      prefs: prefs.value,
      savedWith: typeof doc.savedWith === "string" ? doc.savedWith : null,
      savedAt: typeof doc.savedAt === "string" ? doc.savedAt : null,
    },
  };
}
