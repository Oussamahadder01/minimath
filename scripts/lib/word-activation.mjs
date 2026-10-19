// A small .docx that makes Word load the MiniMath add-in once.
//
// Registering the manifest under WEF\Developer only lists the add-in; Word
// starts it (and adds its ribbon button for good) when a document references
// it. This document carries such a reference, with store="developer"
// storeType="Registry" pointing at that registry entry, in an open task
// pane: the same mechanism Microsoft's office-addin-debugging uses.

import { createZip } from "./zip.mjs";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function paragraph(text, { bold = false, size } = {}) {
  const props = [bold ? "<w:b/>" : "", size ? `<w:sz w:val="${size}"/>` : ""].join("");
  return `<w:p><w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

const TEXT = [
  ["MiniMath est activé dans Word", { bold: true, size: 32 }],
  ["Le volet MiniMath est ouvert à droite. Le bouton MiniMath → Equation se trouve maintenant dans l'onglet Insertion de Word."],
  ["Vous pouvez fermer ce document sans l'enregistrer."],
  [""],
  ["MiniMath is active in Word", { bold: true, size: 32 }],
  ["The MiniMath pane is open on the right. The MiniMath → Equation button is now on Word's Insert tab."],
  ["You can close this document without saving it."],
];

/** Build the activation document for the add-in with this manifest Id and Version. */
export function wordActivationDocx({ id, version }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Unexpected add-in id ${id}`);
  if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new Error(`Unexpected add-in version ${version}`);

  const body = TEXT.map(([text, style]) => paragraph(text, style)).join("");
  return createZip([
    [
      "[Content_Types].xml",
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/webextensions/taskpanes.xml" ContentType="application/vnd.ms-office.webextensiontaskpanes+xml"/>` +
        `<Override PartName="/word/webextensions/webextension1.xml" ContentType="application/vnd.ms-office.webextension+xml"/>` +
        `</Types>`,
    ],
    [
      "_rels/.rels",
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes" Target="word/webextensions/taskpanes.xml"/>` +
        `</Relationships>`,
    ],
    [
      "word/document.xml",
      `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ],
    [
      "word/webextensions/taskpanes.xml",
      `${XML}<wetp:taskpanes xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<wetp:taskpane dockstate="right" visibility="1" width="350" row="1"><wetp:webextensionref r:id="rId1"/></wetp:taskpane>` +
        `</wetp:taskpanes>`,
    ],
    [
      "word/webextensions/_rels/taskpanes.xml.rels",
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/webextension" Target="webextension1.xml"/>` +
        `</Relationships>`,
    ],
    [
      "word/webextensions/webextension1.xml",
      `${XML}<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="{${id}}">` +
        `<we:reference id="${id}" version="${version}" store="developer" storeType="Registry"/>` +
        `<we:alternateReferences/><we:properties/><we:bindings/>` +
        `</we:webextension>`,
    ],
  ]);
}
