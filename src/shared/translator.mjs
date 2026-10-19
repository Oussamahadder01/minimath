// Rule-driven MathML -> text translator, modelled on MathType's .tdl files:
// every output language is a data file (src/shared/translators/*.json) of
// templates keyed by MathML element, plus character/function tables. The
// engine itself knows nothing about LaTeX, AsciiMath or speech.
//
// Template placeholders
//   #1 #2 ...   translation of the n-th element child
//   #g1 #g*     same, wrapped in the rule set's group delimiters unless the
//               translation is already a single token
//   #*          all children, joined with the rule's `join` string
//   #text       the token's text, escaped with `textEscapes`
//   #chars      the token's text, each character mapped through `chars`
//   #fn         `functions[text]`, else `defaultFunction` with #text filled in
//   #accN       `accents[text of child N]`
//   #@name      value of attribute `name` (empty when absent)
//
// Variant conditions (`when`): attribute equality, plus
//   $multi: bool        token text has more than one character
//   $text: string       token text equals
//   $childText: {N: s}  child N's text equals s
//   $accent: N          child N's text has an entry in `accents`
//   $baseOperator: bool first child is <mo>, or an <mi> listed in `functions`

import { parseMathML, textContent } from "./mathml.mjs";

const PLACEHOLDER = /#text|#chars|#fn|#acc(\d+)|#@([A-Za-z][\w-]*)|#(g?)(\d+|\*)/g;
const TOKEN_ELEMENTS = new Set(["mi", "mn", "mo", "mtext", "ms", "mspace"]);

export function validateRuleSet(rules) {
  const problems = [];
  for (const key of ["id", "name", "elements"]) {
    if (!(key in rules)) problems.push(`missing "${key}"`);
  }
  if (rules.group && !(Array.isArray(rules.group) && rules.group.length === 2)) {
    problems.push(`"group" must be a [open, close] pair`);
  }
  for (const [name, rule] of Object.entries(rules.elements ?? {})) {
    if (typeof rule === "string") continue;
    if (typeof rule !== "object" || rule === null || typeof rule.template !== "string") {
      problems.push(`element "${name}" needs a string template`);
      continue;
    }
    for (const [index, variant] of (rule.variants ?? []).entries()) {
      if (typeof variant.template !== "string" || typeof variant.when !== "object") {
        problems.push(`element "${name}" variant ${index} needs "when" and "template"`);
      }
    }
  }
  if (problems.length) throw new Error(`Invalid translator "${rules.id ?? "?"}": ${problems.join("; ")}`);
  return rules;
}

function codePoints(text) {
  return Array.from(text);
}

function elementChildren(node) {
  return node.children.filter((c) => c.type === "element");
}

class Translation {
  constructor(rules) {
    this.rules = rules;
    this.errors = [];
    this.warnings = [];
  }

  isSingleToken(text) {
    if (codePoints(text).length === 1) return true;
    if (this.rules.separateWords === "controlWords") return /^\\([A-Za-z]+|.)$/.test(text);
    // Word-based syntaxes (AsciiMath) treat a whole name or number as one token.
    return /^([A-Za-z]+|[0-9]+(\.[0-9]+)?)$/.test(text);
  }

  group(text) {
    const [open, close] = this.rules.group ?? ["", ""];
    return text === "" || this.isSingleToken(text) ? text : `${open}${text}${close}`;
  }

  // Concatenate pieces, separating tokens that would otherwise merge.
  join(pieces, separator = "") {
    let out = "";
    for (const piece of pieces) {
      if (piece === "") continue;
      if (out !== "" && separator !== "") {
        out += separator;
      } else if (out !== "" && this.needsSpace(out, piece)) {
        out += " ";
      }
      out += piece;
    }
    return out;
  }

  needsSpace(left, right) {
    if (this.rules.separateWords === "controlWords") return /\\[A-Za-z]+$/.test(left) && /^[A-Za-z]/.test(right);
    if (this.rules.separateWords === "letters") return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z]/.test(right);
    return false;
  }

  mapChars(text, path) {
    const chars = this.rules.chars ?? {};
    return this.join(
      codePoints(text).map((ch) => {
        if (ch in chars) return chars[ch];
        if (ch.codePointAt(0) > 0x7e && this.rules.warnUnmappedCharacters) {
          const hex = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
          this.warnings.push({ path, message: `No translation for character U+${hex} "${ch}"; passed through.` });
        }
        return ch;
      }),
    );
  }

  escapeText(text) {
    const escapes = this.rules.textEscapes ?? {};
    return codePoints(text)
      .map((ch) => escapes[ch] ?? ch)
      .join("");
  }

  matches(when, node) {
    const kids = elementChildren(node);
    for (const [key, expected] of Object.entries(when)) {
      switch (key) {
        case "$multi":
          if ((codePoints(textContent(node).trim()).length > 1) !== expected) return false;
          break;
        case "$text":
          if (textContent(node).trim() !== expected) return false;
          break;
        case "$childText":
          for (const [index, value] of Object.entries(expected)) {
            const child = kids[Number(index) - 1];
            if (!child || textContent(child).trim() !== value) return false;
          }
          break;
        case "$accent": {
          const child = kids[expected - 1];
          if (!child || !((textContent(child).trim()) in (this.rules.accents ?? {}))) return false;
          break;
        }
        case "$baseOperator": {
          const base = kids[0];
          const text = base ? textContent(base).trim() : "";
          const isOperator =
            base !== undefined &&
            (base.name === "mo" || (base.name === "mi" && text in (this.rules.functions ?? {})));
          if (isOperator !== expected) return false;
          break;
        }
        default:
          if (String(node.attrs[key] ?? "") !== String(expected)) return false;
      }
    }
    return true;
  }

  translate(node, path = "") {
    if (node.type === "text") return this.mapChars(node.value, path);
    const here = path ? `${path}/${node.name}` : node.name;
    const rule = this.rules.elements[node.name];
    if (rule === undefined) {
      this.errors.push({ path: here, message: `No translation available for <${node.name}> in "${this.rules.name}".` });
      return this.rules.errorPlaceholder ?? "";
    }
    const normalized = typeof rule === "string" ? { template: rule } : rule;
    const variant = (normalized.variants ?? []).find((v) => this.matches(v.when, node));
    return this.expand(variant ? variant.template : normalized.template, node, normalized.join ?? "", here);
  }

  expand(template, node, joinWith, path) {
    const kids = elementChildren(node);
    const text = TOKEN_ELEMENTS.has(node.name) ? textContent(node).trim() : "";
    const pieces = [];
    let last = 0;
    for (const m of template.matchAll(PLACEHOLDER)) {
      pieces.push(template.slice(last, m.index));
      last = m.index + m[0].length;
      const [whole, accentIndex, attrName, grouped, childRef] = m;
      if (whole === "#text") pieces.push(this.escapeText(text));
      else if (whole === "#chars") pieces.push(this.mapChars(text, path));
      else if (whole === "#fn") {
        const fn = this.rules.functions?.[text];
        pieces.push(fn ?? (this.rules.defaultFunction ?? "#text").replace("#text", this.escapeText(text)));
      } else if (accentIndex !== undefined) {
        const child = kids[Number(accentIndex) - 1];
        pieces.push(child ? (this.rules.accents?.[textContent(child).trim()] ?? "") : "");
      } else if (attrName !== undefined) {
        pieces.push(node.attrs[attrName] ?? "");
      } else if (childRef === "*") {
        const all = this.join(
          node.children.map((c) => this.translate(c, path)),
          joinWith,
        );
        pieces.push(grouped ? this.group(all) : all);
      } else {
        const child = kids[Number(childRef) - 1];
        if (!child) {
          this.errors.push({ path, message: `<${node.name}> is missing child ${childRef}.` });
          pieces.push(this.rules.errorPlaceholder ?? "");
        } else {
          const value = this.translate(child, path);
          pieces.push(grouped ? this.group(value) : value);
        }
      }
    }
    pieces.push(template.slice(last));
    return this.join(pieces);
  }
}

/**
 * Translate MathML (string or parsed tree) with a rule set.
 * Returns { output, errors, warnings }; errors mark constructs the rule set
 * cannot express, so callers can refuse or flag the result like MathType's
 * "No translation available" messages.
 */
export function translateMathML(mathml, rules) {
  const tree = typeof mathml === "string" ? parseMathML(mathml) : mathml;
  const run = new Translation(rules);
  let output = run.translate(tree);
  if (rules.collapseWhitespace) output = output.replace(/\s+/g, " ");
  output = output.trim();
  return { output, errors: run.errors, warnings: run.warnings };
}
