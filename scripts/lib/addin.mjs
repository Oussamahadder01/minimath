// Build the Word add-in as a static site plus its manifest.
// Entry point: scripts/build-addin.mjs (npm run addin:build).
//
//   MINIMATH_ADDIN_URL=https://you.github.io/minimath npm run addin:build
//
// Outputs
//   dist/addin-site/            files to publish at MINIMATH_ADDIN_URL (HTTPS)
//   src-tauri/addin/manifest.xml  bundled with the desktop app, which registers it with Word
//
// office/manifest.xml is the template; its https://localhost:5179 URLs (the
// `npm start` HTTPS dev endpoint) are replaced with the published address.

import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../../src/config.mjs";

const TEMPLATE_ORIGIN = "https://localhost:5179";

export function parseAddinUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MINIMATH_ADDIN_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error("Word only loads add-ins over HTTPS; MINIMATH_ADDIN_URL must start with https://");
  if (url.search || url.hash) throw new Error("MINIMATH_ADDIN_URL must not contain a query or fragment");
  return { base: url.href.replace(/\/+$/, ""), origin: url.origin };
}

export function renderManifest(template, { base, origin }) {
  if (!template.includes(`<AppDomain>${TEMPLATE_ORIGIN}</AppDomain>`)) {
    throw new Error("office/manifest.xml no longer contains the expected template AppDomain");
  }
  return template
    .replace(`<AppDomain>${TEMPLATE_ORIGIN}</AppDomain>`, `<AppDomain>${origin}</AppDomain>`)
    .replaceAll(TEMPLATE_ORIGIN, base);
}

export async function buildAddin({ addinUrl = process.env.MINIMATH_ADDIN_URL ?? TEMPLATE_ORIGIN, site = true } = {}) {
  const target = parseAddinUrl(addinUrl);
  const manifest = renderManifest(await readFile(join(PROJECT_ROOT, "office", "manifest.xml"), "utf8"), target);

  const bundleDir = join(PROJECT_ROOT, "src-tauri", "addin");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "manifest.xml"), manifest);

  if (site) {
    const out = join(PROJECT_ROOT, "dist", "addin-site");
    await rm(out, { recursive: true, force: true });
    const copies = [
      ["office/taskpane.html", "office/taskpane.html"],
      ["office/taskpane.js", "office/taskpane.js"],
      ["office/assets", "office/assets"],
      ["src/shared", "shared"],
      ["web/styles.css", "web/styles.css"],
      ["web/icon-32.png", "web/icon-32.png"],
      ["node_modules/mathlive/mathlive.min.mjs", "vendor/mathlive/mathlive.min.mjs"],
      ["node_modules/mathlive/fonts", "vendor/mathlive/fonts"],
      ["node_modules/mathlive/LICENSE.txt", "vendor/mathlive/LICENSE.txt"],
    ];
    for (const [from, to] of copies) {
      const destination = join(out, to);
      await mkdir(join(destination, ".."), { recursive: true });
      await cp(join(PROJECT_ROOT, from), destination, { recursive: true });
    }
    await writeFile(join(out, "office", "manifest.xml"), manifest);
    await writeFile(join(out, ".nojekyll"), "");
    await writeFile(
      join(out, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>MiniMath for Word</title>
<p>This site hosts the MiniMath Word add-in. Install the MiniMath desktop app to add it to Word,
or sideload <a href="office/manifest.xml">office/manifest.xml</a>.</p>\n`,
    );
    await copyFile(join(PROJECT_ROOT, "web", "icon-32.png"), join(out, "favicon.png"));
    console.log(`Add-in site: ${out}`);
  }
  console.log(`Add-in manifest for ${target.base}: ${join(bundleDir, "manifest.xml")}`);
  return target;
}
