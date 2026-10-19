// Minimal, dependency-free MathML (XML subset) parser and serializer.
// Runs unchanged in Node and the browser so translators behave identically
// in tests, the server, and the Office add-in.

export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

const NAMED_ENTITIES = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
  InvisibleTimes: "⁢",
  ApplyFunction: "⁡",
  it: "⁢",
  af: "⁡",
  minus: "−",
  times: "×",
  pm: "±",
  infin: "∞",
  le: "≤",
  ge: "≥",
  ne: "≠",
};

export class MathMLParseError extends Error {
  constructor(message, offset) {
    super(`${message} (at offset ${offset})`);
    this.name = "MathMLParseError";
    this.offset = offset;
  }
}

function decodeEntities(text, offset) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff) throw new MathMLParseError(`Invalid character reference ${whole}`, offset);
      return String.fromCodePoint(code);
    }
    if (body in NAMED_ENTITIES) return NAMED_ENTITIES[body];
    throw new MathMLParseError(`Unknown entity ${whole}`, offset);
  });
}

function localName(qname) {
  const colon = qname.indexOf(":");
  return colon === -1 ? qname : qname.slice(colon + 1);
}

/**
 * Parse a MathML string into a tree of
 *   { type: "element", name, attrs, children } | { type: "text", value }.
 * Namespace prefixes (m:, mml:) are dropped; whitespace-only text between
 * elements is discarded because it is insignificant in presentation MathML.
 * A fragment without a <math> root is wrapped in one.
 */
export function parseMathML(source) {
  if (typeof source !== "string") throw new TypeError("MathML source must be a string");
  const root = { type: "element", name: "#document", attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = source.slice(i, textEnd);
      if (raw.trim() !== "") {
        stack[stack.length - 1].children.push({ type: "text", value: decodeEntities(raw, i) });
      }
      i = textEnd;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end === -1) throw new MathMLParseError("Unterminated comment", i);
      i = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end === -1) throw new MathMLParseError("Unterminated CDATA section", i);
      stack[stack.length - 1].children.push({ type: "text", value: source.slice(i + 9, end) });
      i = end + 3;
      continue;
    }
    if (source.startsWith("<?", i) || source.startsWith("<!", i)) {
      const end = source.indexOf(">", i);
      if (end === -1) throw new MathMLParseError("Unterminated declaration", i);
      i = end + 1;
      continue;
    }
    if (source[i + 1] === "/") {
      const end = source.indexOf(">", i);
      if (end === -1) throw new MathMLParseError("Unterminated end tag", i);
      const name = localName(source.slice(i + 2, end).trim());
      const open = stack.pop();
      if (open === root || open.name !== name) {
        throw new MathMLParseError(`Mismatched end tag </${name}>`, i);
      }
      i = end + 1;
      continue;
    }

    // Start tag.
    const tagMatch = /^<([A-Za-z_][\w.:-]*)/.exec(source.slice(i, i + 256));
    if (!tagMatch) throw new MathMLParseError("Malformed tag", i);
    let j = i + tagMatch[0].length;
    const attrs = {};
    const attrRe = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;
    for (;;) {
      attrRe.lastIndex = j;
      const m = attrRe.exec(source);
      if (!m) break;
      const attrName = m[1];
      if (attrName !== "xmlns" && !attrName.startsWith("xmlns:")) {
        attrs[localName(attrName)] = decodeEntities(m[3] ?? m[4], j);
      }
      j = attrRe.lastIndex;
    }
    while (j < n && /\s/.test(source[j])) j++;
    let selfClosing = false;
    if (source[j] === "/") {
      selfClosing = true;
      j++;
    }
    if (source[j] !== ">") throw new MathMLParseError(`Malformed start tag <${tagMatch[1]}>`, i);
    const element = { type: "element", name: localName(tagMatch[1]), attrs, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
    i = j + 1;
  }

  if (stack.length !== 1) {
    throw new MathMLParseError(`Unclosed element <${stack[stack.length - 1].name}>`, n);
  }
  const top = root.children.filter((c) => c.type === "element");
  if (top.length === 1 && top[0].name === "math" && root.children.length === 1) return top[0];
  return { type: "element", name: "math", attrs: {}, children: root.children };
}

/** Concatenated text content of a node. */
export function textContent(node) {
  if (node.type === "text") return node.value;
  return node.children.map(textContent).join("");
}

function escapeXml(text, attr) {
  let out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (attr) out = out.replace(/"/g, "&quot;");
  return out;
}

/**
 * Serialize a tree back to MathML. `namespace` controls the root:
 *   "attr"   -> <math xmlns="...">   (what Word and most consumers expect)
 *   "prefix" -> <m:math xmlns:m="..."> with every element prefixed
 *   "none"   -> <math>
 */
export function serializeMathML(node, { namespace = "attr", display } = {}) {
  const prefix = namespace === "prefix" ? "m:" : "";
  const walk = (current, isRoot) => {
    if (current.type === "text") return escapeXml(current.value, false);
    const attrs = { ...current.attrs };
    if (isRoot && display !== undefined) attrs.display = display ? "block" : "inline";
    let head = `<${prefix}${current.name}`;
    if (isRoot && namespace === "attr") head += ` xmlns="${MATHML_NS}"`;
    if (isRoot && namespace === "prefix") head += ` xmlns:m="${MATHML_NS}"`;
    for (const [key, value] of Object.entries(attrs)) head += ` ${key}="${escapeXml(String(value), true)}"`;
    if (current.children.length === 0) return `${head}/>`;
    return `${head}>${current.children.map((c) => walk(c, false)).join("")}</${prefix}${current.name}>`;
  };
  return walk(node, true);
}
