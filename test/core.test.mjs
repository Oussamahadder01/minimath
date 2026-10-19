import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createEquation, parseEquationFile, parsePrefs } from "../src/shared/eqfile.mjs";
import { ommlPackage } from "../src/shared/omml-package.mjs";
import { MathMLParseError, parseMathML, serializeMathML, textContent } from "../src/shared/mathml.mjs";
import { translateMathML, validateRuleSet } from "../src/shared/translator.mjs";
import { generateProductKey, maskProductKey, normalizeProductKey } from "../src/license/product-key.mjs";
import { signToken, verifyToken } from "../src/license/token.mjs";
import { generateKeyPairSync } from "node:crypto";

const rules = (id) => JSON.parse(readFileSync(new URL(`../src/shared/translators/${id}.json`, import.meta.url), "utf8"));
const LATEX = rules("latex");
const ASCII = rules("asciimath");
const SPEECH = rules("speech");

// MathLive's output for x = (-b ± √(b²-4ac)) / 2a, including invisible times.
const QUADRATIC =
  "<mrow><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><mrow><msup><mi>b</mi><mn>2</mn></msup>" +
  "<mo>−</mo><mn>4</mn><mo>&#x2062;</mo><mi>a</mi><mo>&#x2062;</mo><mi>c</mi></mrow></msqrt></mrow><mrow><mn>2</mn><mo>&#x2062;</mo><mi>a</mi></mrow></mfrac></mrow>";

test("parser wraps fragments, decodes entities and strips namespace prefixes", () => {
  const tree = parseMathML('<m:math xmlns:m="http://www.w3.org/1998/Math/MathML"><m:mi>&alpha;</m:mi></m:math>'.replace("&alpha;", "&#x3B1;"));
  assert.equal(tree.name, "math");
  assert.equal(tree.children[0].name, "mi");
  assert.equal(textContent(tree), "α");
  const fragment = parseMathML("<mi>x</mi><mo>&lt;</mo><mn>1</mn>");
  assert.equal(fragment.name, "math");
  assert.equal(textContent(fragment), "x<1");
});

test("parser rejects malformed MathML with an offset", () => {
  assert.throws(() => parseMathML("<mrow><mi>x</mrow>"), MathMLParseError);
  assert.throws(() => parseMathML("<mi>x"), /Unclosed element/);
  assert.throws(() => parseMathML("<mi>&bogus;</mi>"), /Unknown entity/);
});

test("serializer round-trips and controls the namespace form", () => {
  const tree = parseMathML(QUADRATIC);
  const attr = serializeMathML(tree, { namespace: "attr", display: true });
  assert.match(attr, /^<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML" display="block">/);
  assert.deepEqual(parseMathML(attr).children, tree.children);
  assert.match(serializeMathML(tree, { namespace: "prefix" }), /^<m:math xmlns:m=.*<m:mfrac>/);
  assert.match(serializeMathML(parseMathML("<mi>a&amp;b</mi>")), /a&amp;b/);
});

test("LaTeX translator", () => {
  assert.equal(translateMathML(QUADRATIC, LATEX).output, "x=\\frac{-b\\pm\\sqrt{b^{2}-4ac}}{2a}");
  const sum = "<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><msup><mi>i</mi><mn>2</mn></msup>";
  assert.equal(translateMathML(sum, LATEX).output, "\\sum_{i=1}^{n}i^{2}");
  assert.equal(translateMathML("<mi>sin</mi><mo>&#x2061;</mo><mi>θ</mi>", LATEX).output, "\\sin\\theta");
  assert.equal(translateMathML("<mi>sin</mi><mi>x</mi>", LATEX).output, "\\sin x", "control words are separated from letters");
  assert.equal(translateMathML("<mover><mi>v</mi><mo>→</mo></mover>", LATEX).output, "\\vec{v}");
  assert.equal(translateMathML("<mi>sgn</mi>", LATEX).output, "\\operatorname{sgn}");
  assert.equal(translateMathML("<mtext>50% & up</mtext>", LATEX).output, "\\text{50\\% \\& up}");
  const matrix = "<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable>";
  assert.equal(translateMathML(matrix, LATEX).output, "\\begin{matrix}a & b \\\\ c & d\\end{matrix}");
});

test("AsciiMath and speech translators", () => {
  assert.equal(translateMathML(QUADRATIC, ASCII).output, "x=(-b+-sqrt(b^2-4 a c))/(2 a)");
  assert.equal(
    translateMathML(QUADRATIC, SPEECH).output,
    "x equals the fraction minus b plus or minus the square root of b squared minus 4 a c end root over 2 a end fraction",
  );
});

test("OMML translator emits well-formed Office Math", () => {
  const omml = translateMathML(QUADRATIC, rules("omml"));
  assert.deepEqual(omml.errors, []);
  assert.match(omml.output, /^<m:oMath xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math">/);
  assert.match(omml.output, /<m:f><m:num>.*<m:rad><m:radPr><m:degHide m:val="1"\/><\/m:radPr><m:deg\/><m:e>.*<\/m:den><\/m:f>/);
  assert.ok(!omml.output.includes("⁢"), "invisible operators are dropped");
  // Well-formed: the output parses as XML and text is escaped.
  // (parseMathML wraps any non-<math> root, so the oMath element is its child.)
  assert.equal(parseMathML(omml.output).children[0].name, "oMath");
  const escaped = translateMathML("<mtext>a &amp; b &lt; c</mtext>", rules("omml")).output;
  assert.match(escaped, /<m:t xml:space="preserve">a &amp; b &lt; c<\/m:t>/);
  const pkg = ommlPackage(omml.output, { display: true });
  assert.match(pkg, /<w:p><m:oMathPara><m:oMath /);
  assert.throws(() => ommlPackage("<w:p/>", { display: false }), /Expected an <m:oMath> element/);
});

test("Word add-in manifest is rendered for its published address", async () => {
  const { parseAddinUrl, renderManifest } = await import("../scripts/lib/addin.mjs");
  assert.throws(() => parseAddinUrl("http://example.com"), /HTTPS/);
  assert.throws(() => parseAddinUrl("not a url"), /not a URL/);
  const target = parseAddinUrl("https://Someone.github.io/minimath/");
  assert.deepEqual(target, { base: "https://someone.github.io/minimath", origin: "https://someone.github.io" });

  const template = readFileSync(new URL("../office/manifest.xml", import.meta.url), "utf8");
  const manifest = renderManifest(template, target);
  assert.ok(!manifest.includes("localhost"), "no dev URLs remain");
  assert.match(manifest, /<AppDomain>https:\/\/someone\.github\.io<\/AppDomain>/);
  assert.match(manifest, /<SourceLocation DefaultValue="https:\/\/someone\.github\.io\/minimath\/office\/taskpane\.html" \/>/);
  // Still well-formed XML, with the Id the Windows installer hook registers.
  const parsed = parseMathML(manifest).children[0];
  assert.equal(parsed.name, "OfficeApp");
  const hooks = readFileSync(new URL("../src-tauri/windows/hooks.nsh", import.meta.url), "utf8");
  const id = textContent(parsed.children.find((c) => c.name === "Id"));
  assert.ok(hooks.includes(`"${id}"`), "installer hook registers the manifest's add-in Id");
  assert.throws(() => renderManifest("<OfficeApp/>", target), /template AppDomain/);
});

test("unsupported constructs are reported, not dropped silently", () => {
  const result = translateMathML("<mi>x</mi><mmultiscripts><mi>X</mi></mmultiscripts>", LATEX);
  assert.equal(result.output, "x\\text{?}");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /mmultiscripts/);
  const warned = translateMathML("<mi>☃</mi>", LATEX);
  assert.equal(warned.output, "☃");
  assert.match(warned.warnings[0].message, /U\+2603/);
});

test("rule sets are validated", () => {
  for (const r of [LATEX, ASCII, SPEECH, rules("omml")]) assert.equal(validateRuleSet(r), r);
  assert.throws(() => validateRuleSet({ id: "x", name: "X", elements: { mi: { variants: [] } } }), /needs a string template/);
  assert.throws(() => validateRuleSet({ id: "x", name: "X" }), /missing "elements"/);
});

test("equation files round-trip and reject bad input", () => {
  const doc = createEquation({ latex: "x^2", mathml: "<math><msup><mi>x</mi><mn>2</mn></msup></math>", prefs: { sizePt: 18 } });
  const parsed = parseEquationFile(JSON.stringify(doc));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.prefs.sizePt, 18);
  assert.equal(parsed.value.latex, "x^2");
  assert.match(parseEquationFile("{").error, /not valid JSON/);
  assert.match(parseEquationFile(JSON.stringify({ ...doc, version: 9 })).error, /unsupported version/);
  assert.match(parseEquationFile(JSON.stringify({ ...doc, mathml: "<mi>" })).error, /mathml is malformed/);
  assert.match(parseEquationFile(JSON.stringify({ ...doc, prefs: { color: "red" } })).error, /#rrggbb/);
  assert.equal(parsePrefs({ sizePt: 500 }).ok, false);
});

test("product keys carry a checksum and normalize common typos", () => {
  const key = generateProductKey();
  assert.match(key, /^MM1-[0-9A-Z]{6}-[0-9A-Z]{5}$/);
  assert.equal(normalizeProductKey(key.toLowerCase().replace(/-/g, " ")), key);
  const broken = key.slice(0, -1) + (key.endsWith("0") ? "1" : "0");
  assert.equal(normalizeProductKey(broken), null);
  assert.equal(normalizeProductKey("hello"), null);
  assert.equal(maskProductKey(key), `MM1-******-${key.slice(-5)}`);
});

test("tokens verify only with the right key and untampered payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const priv = privateKey.export({ type: "pkcs8", format: "pem" });
  const pub = publicKey.export({ type: "spki", format: "pem" });
  const token = signToken({ v: 1, key: "MM1-AAAAAA-AAAAA", machine: "m" }, priv);
  assert.deepEqual(verifyToken(token, pub).payload.machine, "m");
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.equal(verifyToken(token, other).ok, false);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ v: 1, key: "MM1-AAAAAA-AAAAA", machine: "evil" })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${sig}`, pub).ok, false);
  assert.equal(verifyToken(`${body}`, pub).ok, false);
  assert.equal(verifyToken(null, pub).ok, false);
});
