// Server-side equation rendering with MathJax 3 (SVG output, glyphs as paths,
// so images look identical everywhere and need no installed fonts).

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mathjax } = require("mathjax-full/js/mathjax.js");
const { TeX } = require("mathjax-full/js/input/tex.js");
const { MathML } = require("mathjax-full/js/input/mathml.js");
const { SVG } = require("mathjax-full/js/output/svg.js");
const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
const { AllPackages } = require("mathjax-full/js/input/tex/AllPackages.js");

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const texDocument = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages.filter((p) => p !== "bussproofs") }),
  OutputJax: new SVG({ fontCache: "none" }),
});
const mathmlDocument = mathjax.document("", {
  InputJax: new MathML(),
  OutputJax: new SVG({ fontCache: "none" }),
});

const PX_PER_PT = 96 / 72;

export class RenderError extends Error {
  constructor(message) {
    super(message);
    this.name = "RenderError";
  }
}

/**
 * Render LaTeX or MathML to a standalone SVG string.
 * prefs: { sizePt, color, display } (validated by parsePrefs).
 * Returns { svg, widthPx, heightPx, baselinePx }.
 */
export function renderSvg({ latex, mathml, prefs }) {
  const em = prefs.sizePt * PX_PER_PT;
  const options = { display: prefs.display, em, ex: em / 2, containerWidth: 80 * em };
  let node;
  try {
    if (typeof mathml === "string") node = mathmlDocument.convert(mathml, options);
    else if (typeof latex === "string") node = texDocument.convert(latex, options);
    else throw new RenderError("Provide latex or mathml");
  } catch (error) {
    // MathJax 3.2.2 throws TypeErrors on some inputs (e.g. control characters)
    // instead of producing <merror>; report them as input errors.
    if (error instanceof RenderError) throw error;
    throw new RenderError(`MathJax could not render the input: ${error.message}`);
  }

  const svgNode = adaptor.firstChild(node);
  // MathJax reports TeX errors as an <merror> rendered in red, not an exception.
  const errorNode = adaptor.tags(svgNode, "g").find((g) => adaptor.getAttribute(g, "data-mml-node") === "merror");
  if (errorNode) {
    const title = adaptor.getAttribute(errorNode, "data-mjx-error") ?? "invalid input";
    throw new RenderError(`MathJax could not parse the input: ${title}`);
  }

  // Convert ex-based dimensions to pixels so the SVG works as an <img>/PNG source.
  const exPx = em / 2;
  const toPx = (value) => (value?.endsWith("ex") ? parseFloat(value) * exPx : parseFloat(value ?? "0"));
  const widthPx = Math.ceil(toPx(adaptor.getAttribute(svgNode, "width")));
  const heightPx = Math.ceil(toPx(adaptor.getAttribute(svgNode, "height")));
  const valign = /vertical-align:\s*(-?[\d.]+)ex/.exec(adaptor.getAttribute(svgNode, "style") ?? "");
  const baselinePx = valign ? Math.round(-parseFloat(valign[1]) * exPx) : 0;
  adaptor.setAttribute(svgNode, "width", `${widthPx}px`);
  adaptor.setAttribute(svgNode, "height", `${heightPx}px`);
  adaptor.setAttribute(svgNode, "color", prefs.color);
  adaptor.setAttribute(svgNode, "xmlns", "http://www.w3.org/2000/svg");
  adaptor.removeAttribute(svgNode, "style");

  const svg = adaptor.outerHTML(svgNode).replace(/currentColor/g, prefs.color);
  return { svg, widthPx, heightPx, baselinePx };
}
