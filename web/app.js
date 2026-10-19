// MiniMath editor UI. Editing happens in MathLive (LaTeX source); every change
// is converted to MathML, which feeds the translators and the exports.
// Inside the Tauri shell, clipboard and file operations go through native
// commands; in a plain browser they fall back to web APIs.

import { MathfieldElement } from "/vendor/mathlive/mathlive.min.mjs";
import { createEquation, parseEquationFile } from "/shared/eqfile.mjs";
import { parseMathML, serializeMathML } from "/shared/mathml.mjs";

MathfieldElement.fontsDirectory = "/vendor/mathlive/fonts";
MathfieldElement.soundsDirectory = null;

const native = window.__TAURI__?.core?.invoke ?? null;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ API

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json", "x-minimath": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function setStatus(message, kind = "") {
  const status = $("status");
  status.textContent = message;
  status.className = kind;
}

// ------------------------------------------------------------------ palette

const PALETTE = [
  {
    title: "Fractions & roots",
    items: [
      ["ᵃ⁄ᵦ", "\\frac{#@}{#?}", "Fraction"],
      ["a/b", "#@/#?", "Slash fraction"],
      ["√", "\\sqrt{#@}", "Square root"],
      ["ⁿ√", "\\sqrt[#?]{#@}", "Nth root"],
    ],
  },
  {
    title: "Scripts",
    items: [
      ["x²", "#@^{#?}", "Superscript"],
      ["x₂", "#@_{#?}", "Subscript"],
      ["x₂²", "#@_{#?}^{#?}", "Sub- and superscript"],
      ["x′", "#@'", "Prime"],
    ],
  },
  {
    title: "Big operators",
    items: [
      ["∑", "\\sum_{#?}^{#?}", "Summation"],
      ["∏", "\\prod_{#?}^{#?}", "Product"],
      ["∫", "\\int_{#?}^{#?}", "Integral"],
      ["∮", "\\oint", "Contour integral"],
      ["lim", "\\lim_{#?\\to #?}", "Limit"],
    ],
  },
  {
    title: "Fences & matrices",
    items: [
      ["( )", "\\left(#@\\right)", "Parentheses"],
      ["[ ]", "\\left[#@\\right]", "Brackets"],
      ["{ }", "\\left\\{#@\\right\\}", "Braces"],
      ["| |", "\\left|#@\\right|", "Absolute value"],
      ["(⋮)", "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}", "2×2 matrix"],
      ["{⋮", "\\begin{cases}#?&#?\\\\#?&#?\\end{cases}", "Cases"],
    ],
  },
  {
    title: "Accents",
    items: [
      ["x̂", "\\hat{#@}", "Hat"],
      ["x̄", "\\overline{#@}", "Overline"],
      ["x⃗", "\\vec{#@}", "Vector"],
      ["ẋ", "\\dot{#@}", "Dot"],
      ["x̃", "\\tilde{#@}", "Tilde"],
    ],
  },
  {
    title: "Greek",
    items: ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "sigma", "phi", "omega", "Gamma", "Delta", "Sigma", "Omega"].map(
      (name) => [
        { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", pi: "π", sigma: "σ", phi: "φ", omega: "ω", Gamma: "Γ", Delta: "Δ", Sigma: "Σ", Omega: "Ω" }[name],
        `\\${name}`,
        name,
      ],
    ),
  },
  {
    title: "Symbols",
    items: [
      ["±", "\\pm"], ["×", "\\times"], ["÷", "\\div"], ["·", "\\cdot"], ["≤", "\\le"], ["≥", "\\ge"],
      ["≠", "\\ne"], ["≈", "\\approx"], ["≡", "\\equiv"], ["∞", "\\infty"], ["→", "\\to"], ["⇒", "\\Rightarrow"],
      ["∈", "\\in"], ["∉", "\\notin"], ["⊂", "\\subset"], ["∪", "\\cup"], ["∩", "\\cap"], ["∂", "\\partial"],
      ["∇", "\\nabla"], ["∀", "\\forall"], ["∃", "\\exists"], ["ℝ", "\\mathbb{R}"],
    ],
  },
];

function buildPalette(editor) {
  const palette = $("palette");
  for (const group of PALETTE) {
    const box = document.createElement("div");
    box.className = "group";
    box.innerHTML = `<span class="group-title"></span><div class="group-buttons"></div>`;
    box.querySelector(".group-title").textContent = group.title;
    const buttons = box.querySelector(".group-buttons");
    for (const [label, latex, title] of group.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title ?? latex;
      button.addEventListener("mousedown", (event) => event.preventDefault()); // keep editor focus
      button.addEventListener("click", () => {
        editor.insert(latex, { selectionMode: "placeholder", format: "latex" });
        editor.focus();
      });
      buttons.append(button);
    }
    palette.append(box);
  }
}

// ------------------------------------------------------------------ state

const state = {
  latex: "",
  mathml: "",
  prefs: { name: "Document 12 pt", sizePt: 12, color: "#000000", display: true },
  presets: [],
  translators: [],
  activeTab: "latex",
  outputs: {},
  svg: null,
  license: null,
};

function currentMathML() {
  // MathLive emits presentation MathML without the <math> wrapper.
  const tree = parseMathML(state.mathml || "<math></math>");
  return serializeMathML(tree, { namespace: "attr", display: state.prefs.display });
}

function isEmpty() {
  return state.latex.trim() === "";
}

// ------------------------------------------------------------------ preview & translators

let updateTimer = null;
let updateSeq = 0;

function scheduleUpdate() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(update, 150);
}

async function update() {
  const seq = ++updateSeq;
  const preview = $("preview");
  if (isEmpty()) {
    state.svg = null;
    state.outputs = {};
    preview.innerHTML = "";
    renderOutput();
    return;
  }
  let mathml;
  try {
    mathml = currentMathML();
  } catch (error) {
    preview.innerHTML = `<span class="error"></span>`;
    preview.firstChild.textContent = `MathML conversion failed: ${error.message}`;
    return;
  }
  const [render, ...translations] = await Promise.allSettled([
    api("POST", "/api/render", { latex: state.latex, prefs: state.prefs }),
    ...state.translators.map((t) => api("POST", "/api/translate", { translator: t.id, mathml })),
  ]);
  if (seq !== updateSeq) return; // a newer edit superseded this one

  if (render.status === "fulfilled") {
    state.svg = render.value;
    preview.innerHTML = render.value.svg;
  } else {
    state.svg = null;
    preview.innerHTML = `<span class="error"></span>`;
    preview.firstChild.textContent = render.reason.message;
  }
  state.outputs = { mathml: { output: mathml, errors: [], warnings: [] } };
  state.translators.forEach((t, i) => {
    const r = translations[i];
    state.outputs[t.id] =
      r.status === "fulfilled" ? r.value : { output: "", errors: [{ message: r.reason.message }], warnings: [], blocked: r.reason.code === "license_required" };
  });
  renderOutput();
}

function buildTabs() {
  const tabs = $("tabs");
  tabs.innerHTML = "";
  const entries = [...state.translators.map((t) => ({ id: t.id, name: t.name, free: t.free })), { id: "mathml", name: "MathML", free: true }];
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "tab";
    button.dataset.id = entry.id;
    button.textContent = entry.name;
    button.setAttribute("aria-selected", String(entry.id === state.activeTab));
    button.addEventListener("click", () => {
      state.activeTab = entry.id;
      for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.id === entry.id));
      renderOutput();
    });
    tabs.append(button);
  }
}

function renderOutput() {
  const result = state.outputs[state.activeTab];
  $("output").value = result?.output ?? "";
  const issues = $("output-issues");
  issues.innerHTML = "";
  for (const [kind, list] of [["error", result?.errors ?? []], ["warning", result?.warnings ?? []]]) {
    for (const issue of list) {
      const li = document.createElement("li");
      li.className = kind;
      li.textContent = issue.message;
      issues.append(li);
    }
  }
}

// ------------------------------------------------------------------ export helpers

async function svgToPngBlob(svgResult, scale = 2) {
  const blob = new Blob([svgResult.svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "sync";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Could not rasterize the equation image"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(svgResult.widthPx * scale));
    canvas.height = Math.max(1, Math.ceil(svgResult.heightPx * scale));
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Put several representations on the clipboard at once. */
async function writeClipboard({ text, mathml, html, pngBlob }) {
  if (native) {
    await native("copy_equation", {
      formats: {
        text: text ?? null,
        mathml: mathml ?? null,
        html: html ?? null,
        pngBase64: pngBlob ? await blobToBase64(pngBlob) : null,
      },
    });
    return;
  }
  const items = {};
  if (text !== undefined) items["text/plain"] = new Blob([text], { type: "text/plain" });
  if (html !== undefined) items["text/html"] = new Blob([html], { type: "text/html" });
  if (pngBlob) items["image/png"] = pngBlob;
  await navigator.clipboard.write([new ClipboardItem(items)]);
}

async function saveFile({ name, extension, filterName, text, blob }) {
  if (native) {
    const path = await native("save_file", {
      defaultName: name,
      filterName,
      extensions: [extension],
      text: text ?? null,
      base64: blob ? await blobToBase64(blob) : null,
    });
    return path; // null when the user cancelled
  }
  const url = URL.createObjectURL(blob ?? new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

function requireEquation() {
  if (isEmpty()) throw new Error("Type an equation first.");
}

function requireRender() {
  requireEquation();
  if (!state.svg) throw new Error("The equation could not be rendered; fix the errors shown in the preview.");
}

function track(event, props) {
  api("POST", "/api/telemetry/event", { event, props }).catch(() => {});
}

const actions = {
  "copy-word": async () => {
    requireEquation();
    const mathml = currentMathML();
    // Word turns MathML on the clipboard into an editable Office Math equation.
    // No HTML flavor here: Word would prefer it and paste markup instead.
    await writeClipboard({ text: mathml, mathml });
    track("export", { format: "word" });
    return "Copied. Paste into Word with Ctrl+V to get an editable equation.";
  },
  "copy-image": async () => {
    requireRender();
    const pngBlob = await svgToPngBlob(state.svg);
    await writeClipboard({ pngBlob, text: state.latex });
    track("export", { format: "png_clipboard" });
    return "Image copied (PNG, 2× resolution).";
  },
  "copy-latex": async () => {
    requireEquation();
    // The editor source round-trips exactly; the translator tab offers the
    // MathML-derived LaTeX for comparison.
    await writeClipboard({ text: state.latex });
    track("export", { format: "latex" });
    return "LaTeX copied.";
  },
  "copy-output": async () => {
    const value = $("output").value;
    if (!value) throw new Error("Nothing to copy for this output.");
    await writeClipboard({ text: value });
    return "Output copied.";
  },
  "save-png": async () => {
    requireRender();
    const path = await saveFile({ name: "equation.png", extension: "png", filterName: "PNG image", blob: await svgToPngBlob(state.svg, 4) });
    if (path) track("export", { format: "png_file" });
    return path ? `Saved ${path}` : "Save cancelled.";
  },
  "save-svg": async () => {
    requireRender();
    const path = await saveFile({ name: "equation.svg", extension: "svg", filterName: "SVG image", text: state.svg.svg });
    return path ? `Saved ${path}` : "Save cancelled.";
  },
  "save-eq": async () => {
    requireEquation();
    const doc = createEquation({ latex: state.latex, mathml: currentMathML(), prefs: state.prefs });
    const path = await saveFile({ name: "equation.mmeq", extension: "mmeq", filterName: "MiniMath equation", text: `${JSON.stringify(doc, null, 2)}\n` });
    return path ? `Saved ${path}` : "Save cancelled.";
  },
  "open-eq": async () => {
    if (native) {
      const file = await native("open_file", { filterName: "MiniMath equation", extensions: ["mmeq"] });
      if (!file) return "Open cancelled.";
      return loadEquationText(file.contents, file.path);
    }
    $("open-input").click();
    return null;
  },
};

function loadEquationText(text, label) {
  const parsed = parseEquationFile(text);
  if (!parsed.ok) throw new Error(`Cannot open ${label}: ${parsed.error}`);
  applyPrefs(parsed.value.prefs);
  editor.value = parsed.value.latex;
  onEditorInput();
  return `Opened ${label}.`;
}

// ------------------------------------------------------------------ prefs

function applyPrefs(prefs) {
  state.prefs = { ...state.prefs, ...prefs };
  $("size").value = state.prefs.sizePt;
  $("color").value = state.prefs.color;
  $("display").checked = state.prefs.display;
  const match = state.presets.find((p) => p.name === state.prefs.name);
  $("preset").value = match ? match.id : "";
  scheduleUpdate();
}

function wirePrefs() {
  const select = $("preset");
  select.innerHTML = state.presets.map((p) => `<option value="${p.id}"></option>`).join("") + `<option value="">Custom</option>`;
  state.presets.forEach((p, i) => (select.options[i].textContent = p.name));
  select.addEventListener("change", () => {
    const preset = state.presets.find((p) => p.id === select.value);
    if (preset) applyPrefs(preset);
  });
  const custom = () => {
    const sizePt = Number($("size").value);
    if (!(sizePt >= 4 && sizePt <= 144)) return;
    applyPrefs({ name: "Custom", sizePt, color: $("color").value, display: $("display").checked });
  };
  for (const id of ["size", "color", "display"]) $(id).addEventListener("change", custom);
}

// ------------------------------------------------------------------ license

const LOCKED_WHEN_EXPIRED = ["copy-word", "copy-image", "save-png", "save-svg"];

function renderLicense(license) {
  state.license = license;
  const badge = $("license-badge");
  const button = $("license-button");
  badge.className = `badge ${license.state}`;
  if (license.state === "licensed") {
    badge.textContent = license.licensedTo ? `Licensed to ${license.licensedTo}` : "Licensed";
    button.textContent = "License…";
  } else if (license.state === "trial") {
    badge.textContent = `Trial: ${license.daysLeft} day${license.daysLeft === 1 ? "" : "s"} left`;
    button.textContent = "Activate…";
  } else {
    badge.textContent = "Trial ended";
    button.textContent = "Activate…";
  }
  for (const id of LOCKED_WHEN_EXPIRED) {
    $(id).disabled = license.state === "expired";
    $(id).title = license.state === "expired" ? "Activate MiniMath to use this export" : "";
  }
}

async function refreshLicense() {
  try {
    renderLicense(await api("GET", "/api/license"));
  } catch (error) {
    $("license-badge").textContent = "License helper unavailable";
    setStatus(error.message, "error");
  }
}

function openLicenseDialog() {
  const dialog = $("license-dialog");
  const license = state.license ?? {};
  const detail = {
    licensed: `Activated with ${license.productKey}${license.licensedTo ? ` for ${license.licensedTo}` : ""}.`,
    trial: `You are using the free trial: ${license.daysLeft} of ${license.trialDays} days left.`,
    expired: "Your trial has ended. Enter a product key to keep exporting images and Word equations.",
  }[license.state] ?? "License state unknown.";
  $("license-detail").textContent = license.warning ? `${detail} (${license.warning})` : detail;
  $("activate-fields").hidden = license.state === "licensed";
  $("activate").hidden = license.state === "licensed";
  $("deactivate").hidden = license.state !== "licensed";
  $("license-error").textContent = "";
  dialog.showModal();
  if (license.state !== "licensed") $("product-key").focus();
}

async function activate() {
  const button = $("activate");
  button.disabled = true;
  $("license-error").textContent = "";
  try {
    const license = await api("POST", "/api/license/activate", { productKey: $("product-key").value });
    renderLicense(license);
    $("license-dialog").close();
    setStatus("MiniMath is activated. Thank you!", "ok");
    scheduleUpdate();
  } catch (error) {
    $("license-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function deactivate() {
  try {
    const result = await api("POST", "/api/license/deactivate", {});
    renderLicense(result.state);
    $("license-dialog").close();
    setStatus(result.warning ?? "This machine was deactivated.", result.warning ? "error" : "ok");
  } catch (error) {
    $("license-error").textContent = error.message;
  }
}

// ------------------------------------------------------------------ boot

const editor = $("editor");

function onEditorInput() {
  state.latex = editor.value;
  state.mathml = editor.getValue("math-ml");
  scheduleUpdate();
}

async function boot() {
  editor.mathVirtualKeyboardPolicy = "manual";
  editor.addEventListener("input", onEditorInput);
  buildPalette(editor);

  for (const [id, run] of Object.entries(actions)) {
    $(id).addEventListener("click", async () => {
      try {
        const message = await run();
        if (message) setStatus(message, "ok");
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
  }
  $("open-input").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setStatus(loadEquationText(await file.text(), file.name), "ok");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  $("license-button").addEventListener("click", openLicenseDialog);
  $("activate").addEventListener("click", activate);
  $("deactivate").addEventListener("click", deactivate);
  $("product-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      activate();
    }
  });

  const telemetry = $("telemetry");
  telemetry.addEventListener("change", async () => {
    try {
      await api("POST", "/api/telemetry", { enabled: telemetry.checked });
      setStatus(telemetry.checked ? "Thanks — anonymous usage statistics enabled." : "Usage statistics disabled.", "ok");
    } catch (error) {
      telemetry.checked = !telemetry.checked;
      setStatus(error.message, "error");
    }
  });

  try {
    const [{ translators }, { presets }, consent] = await Promise.all([
      api("GET", "/api/translators"),
      api("GET", "/api/prefs"),
      api("GET", "/api/telemetry"),
    ]);
    state.translators = translators;
    state.presets = presets;
    telemetry.checked = consent.enabled;
  } catch (error) {
    setStatus(`Could not reach the MiniMath server: ${error.message}`, "error");
    return;
  }
  buildTabs();
  wirePrefs();
  applyPrefs(state.presets[0] ?? state.prefs);
  await refreshLicense();
  track("app_start", { shell: native ? "tauri" : "browser" });

  editor.value = "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}";
  onEditorInput();
  editor.focus();
  setStatus(native ? "Ready (desktop)." : "Ready.");
}

boot();
