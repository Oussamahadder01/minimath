// User interface settings (currently the theme), stored next to the license
// helper's data so they survive restarts of the desktop app, whose server
// origin (and therefore browser storage) changes on every launch.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.mjs";

export const THEMES = ["system", "light", "dark"];
export const DEFAULT_SETTINGS = Object.freeze({ theme: "system" });

const settingsPath = () => join(config.helperHome, "settings.json");

/** Validate untrusted settings. Returns { ok, value } or { ok: false, error }. */
export function parseSettings(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "settings must be an object" };
  const value = { ...DEFAULT_SETTINGS };
  if (raw.theme !== undefined) {
    if (!THEMES.includes(raw.theme)) return { ok: false, error: `theme must be one of ${THEMES.join(", ")}` };
    value.theme = raw.theme;
  }
  return { ok: true, value };
}

export async function loadSettings() {
  try {
    const parsed = parseSettings(JSON.parse(await readFile(settingsPath(), "utf8")));
    // A damaged file falls back to defaults rather than breaking the UI.
    return parsed.ok ? parsed.value : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  const target = settingsPath();
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return settings;
}
