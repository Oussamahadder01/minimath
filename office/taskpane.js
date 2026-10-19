// MiniMath Word task pane. Each inserted equation is native Office Math
// inside a content control tagged "minimath:<id>"; the editor source (LaTeX)
// is kept in the document's add-in settings under the same id, so selecting
// the equation later reopens it for editing — the role MathType's OLE object
// ("Equation.DSMT4" + "Equation Native") plays.
//
// The pane is a static site: it needs no MiniMath server, so it works from
// any HTTPS host (GitHub Pages in releases, `npm start` over HTTPS in dev).
// All paths are relative to this file for that reason.
/* global Office, Word */

import { MathfieldElement } from "../vendor/mathlive/mathlive.min.mjs";
import { parseMathML, serializeMathML } from "../shared/mathml.mjs";
import { ommlPackage } from "../shared/omml-package.mjs";
import { translateMathML, validateRuleSet } from "../shared/translator.mjs";

// MathLive finds its fonts next to its own module by default.
MathfieldElement.soundsDirectory = null;

const TAG_PREFIX = "minimath:";
const $ = (id) => document.getElementById(id);
const editor = $("editor");
let editingTag = null;

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").className = isError ? "error" : "";
}

function setEditing(tag) {
  editingTag = tag;
  $("insert").textContent = tag ? "Update equation" : "Insert equation";
  $("mode").textContent = tag ? "Editing the selected MiniMath equation." : "Type an equation, then insert it at the cursor.";
}

let ommlRules = null;

/** MathML -> OMML with the shared "omml" translator rule set, run locally. */
async function mathmlToOmml(mathml) {
  if (!ommlRules) {
    const response = await fetch(new URL("../shared/translators/omml.json", import.meta.url));
    if (!response.ok) throw new Error(`Could not load the Office Math translator (HTTP ${response.status})`);
    ommlRules = validateRuleSet(await response.json());
  }
  const result = translateMathML(mathml, ommlRules);
  if (result.errors.length) throw new Error(`Word cannot represent part of this equation: ${result.errors[0].message}`);
  return result.output;
}

function saveSettings() {
  return new Promise((resolve, reject) =>
    Office.context.document.settings.saveAsync((result) =>
      result.status === Office.AsyncResultStatus.Succeeded ? resolve() : reject(result.error),
    ),
  );
}

async function insertOrUpdate() {
  if (editor.value.trim() === "") throw new Error("Type an equation first.");
  const display = $("display").checked;
  const mathml = serializeMathML(parseMathML(editor.getValue("math-ml")), { namespace: "attr", display });
  const ooxml = ommlPackage(await mathmlToOmml(mathml), { display });
  const updating = editingTag !== null;
  const tag = editingTag ?? `${TAG_PREFIX}${crypto.randomUUID()}`;

  await Word.run(async (context) => {
    let control;
    if (updating) {
      const matches = context.document.contentControls.getByTag(editingTag);
      matches.load("items");
      await context.sync();
      if (matches.items.length === 0) throw new Error("The equation being edited is no longer in the document.");
      control = matches.items[0];
      control.insertOoxml(ooxml, "Replace");
    } else {
      const range = context.document.getSelection().insertOoxml(ooxml, "Replace");
      control = range.insertContentControl();
      control.tag = tag;
      control.title = "MiniMath equation";
      control.appearance = "BoundingBox";
    }
    await context.sync();
  });
  Office.context.document.settings.set(tag, { latex: editor.value, display, savedAt: new Date().toISOString() });
  await saveSettings();
  setEditing(tag);
  return updating ? "Equation updated." : "Equation inserted.";
}

async function onSelectionChanged() {
  try {
    await Word.run(async (context) => {
      const control = context.document.getSelection().parentContentControlOrNullObject;
      control.load("tag");
      await context.sync();
      if (control.isNullObject || !control.tag?.startsWith(TAG_PREFIX)) {
        if (editingTag) setEditing(null);
        return;
      }
      if (control.tag === editingTag) return;
      const saved = Office.context.document.settings.get(control.tag);
      if (!saved?.latex) {
        setStatus("This equation has no saved MiniMath source; it can be replaced but not edited.", true);
        return;
      }
      editor.value = saved.latex;
      $("display").checked = saved.display !== false;
      setEditing(control.tag);
    });
  } catch (error) {
    setStatus(error.message, true);
  }
}

Office.onReady((info) => {
  if (info.host !== Office.HostType.Word) {
    setStatus("MiniMath's task pane works in Word.", true);
    $("insert").disabled = true;
    return;
  }
  editor.mathVirtualKeyboardPolicy = "manual";
  $("insert").addEventListener("click", async () => {
    $("insert").disabled = true;
    try {
      setStatus(await insertOrUpdate());
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      $("insert").disabled = false;
    }
  });
  $("new").addEventListener("click", () => {
    editor.value = "";
    setEditing(null);
    editor.focus();
  });
  Office.context.document.addHandlerAsync(Office.EventType.DocumentSelectionChanged, onSelectionChanged);
  onSelectionChanged();
});
