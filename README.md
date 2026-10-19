# MiniMath

A small, working equation editor built the way MathType 7 is built (its
structure was worked out by reverse engineering the installed app), without
MathType's legacy technology.

| MathType 7 (observed)                                       | MiniMath                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `MathType.exe`: C++ editor, MTEF equation records            | `web/` MathLive editor in a Tauri desktop shell (`src-tauri/`)             |
| MTEF in OLE stream `Equation Native` (+ embedded prefs)      | `.mmeq` JSON: LaTeX source + MathML + style prefs (`src/shared/eqfile.mjs`) |
| `Translators\*.tdl` rule files → LaTeX, MathML, …            | `src/shared/translators/*.json` rule files → LaTeX, AsciiMath, speech, OMML |
| `Preferences\*.eqp` style files                              | `prefs/*.json` presets                                                     |
| `System\MathTypeLib.exe` licensing helper, JSON over pipes   | `src/helper/mtlib.mjs`, JSON lines over stdio ("PipeCom"), parent watchdog  |
| Activation + product keys + telemetry (WIRIS servers)        | `src/services/license-service.mjs`: Ed25519-signed tokens, opt-in events    |
| Clipboard formats `MathML`, `MathML Presentation`, PNG       | Native clipboard in `src-tauri/src/clipboard.rs`                           |
| Word integration via OLE object `Equation.DSMT4`             | Word add-in (`office/`): native Office Math in a tagged content control     |

```
 Tauri shell (Rust) ──owns──► Node app server ──owns──► license helper ──HTTPS──► license service
   window, native clipboard,     UI, MathJax render,       trial, key, token,       keys, seats, signing,
   file dialogs                  translators, API          telemetry queue          telemetry sink
```

Each process owns the next one and passes it a pipe. When a parent exits,
even by crashing, the pipe closes and the child shuts itself down.

## Quick start

Requirements: Node.js 22.19+ (24 recommended). For the desktop app you also
need Rust (MSVC toolchain) and the Visual Studio C++ Build Tools.

```powershell
npm ci
npm run keys                                     # signing key pair (service-data/, config/)
npm run issue-key -- --email you@example.com     # prints a product key MM1-XXXXXX-XXXXX
npm run service                                  # license service on http://127.0.0.1:5180
```

Then, in a second terminal, either:

```powershell
npm start            # browser version: open http://127.0.0.1:5178
npm run desktop      # desktop app (Tauri, dev mode)
npm run desktop:build  # release build for this OS (Windows: NSIS installer in src-tauri/target/release/bundle/nsis/)
```

The desktop app starts its own server on a random loopback port, so it can
run next to `npm start`. The installer ships its own Node.js runtime.

## Using it

- **Templates and symbols**: use the toolbar, or type LaTeX directly into the editor
  (`\frac`, `^`, `_`, `\sqrt`, …). Tab moves between placeholders.
- **Copy for Word**: paste into Word with Ctrl+V to get a native, editable
  equation. Desktop: the clipboard gets `MathML`, `MathML Presentation`,
  `application/mathml+xml` and text. Browser: text only (Word converts it as well).
- **Copy image / Save PNG / Save SVG**: rendered by MathJax with the current style.
- **Outputs**: LaTeX, AsciiMath, spoken English (for alt text), MathML, and
  Office Math (OMML). Untranslatable constructs are listed instead of being dropped.
- **.mmeq files**: save and reopen equations, style included.
- **License**: 30-day trial. After it ends, LaTeX stays free and image/Word
  exports need activation. Usage statistics are off unless you opt in.

## Releases (Windows and Mac)

Push to GitHub and two workflows run:

- **Desktop apps** (`.github/workflows/desktop.yml`) builds `MiniMath-windows-x64`
  (`.exe`), `MiniMath-macos-apple-silicon` and `MiniMath-macos-intel` (`.dmg`).
  Download them from the run's **Artifacts**. Mac apps can only be built on a
  Mac; the workflow uses GitHub's macOS runners.
- **Word add-in site** (`.github/workflows/addin-site.yml`) publishes the Word task
  pane to `https://<owner>.github.io/<repo>/`. One-time setup: Settings → Pages →
  Source: **GitHub Actions**. On free GitHub plans, Pages needs a public repository.

The Mac apps are ad-hoc signed, not signed with an Apple Developer ID, so
macOS blocks the first launch. To allow it once without Terminal:
- **macOS 15 or newer:** System Settings → Privacy & Security → **Open Anyway**.
- **macOS 14 or older:** right-click the app → **Open**.

If macOS reports the app as "damaged" instead, run
`xattr -cr /Applications/MiniMath.app` in Terminal. A Developer ID
certificate plus notarization would remove these steps entirely.

## Word add-in

The task pane inserts native Office Math wrapped in a content control. It
stores the LaTeX source in the document's add-in settings, so selecting an
equation later reopens it for editing. It is a static site with no server
calls: the OMML translator runs inside the pane.

**Installed automatically.** Restart Word after installing MiniMath, then look
for **MiniMath → Equation** on the Insert tab.
- **Windows:** the installer registers the add-in for the current user under
  `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` (the same key Office's
  sideloading tool uses). The uninstaller removes it.
- **macOS:** at launch, the app copies its manifest to Word's add-in folder,
  `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`. macOS may ask
  to let MiniMath access Word's data. If the button doesn't appear, open
  Insert → Add-ins → My Add-ins once and choose MiniMath.

Desktop builds register the manifest for `MINIMATH_ADDIN_URL`, which the
release workflow sets to the Pages address. Local builds default to the
`npm start` dev endpoint, which needs a trusted localhost certificate:
`npx office-addin-dev-certs install` (this changes your user certificate store).

## Adding a translator

Copy a file in `src/shared/translators/` and edit its templates. No code changes
are needed. Placeholders: `#1 #2 …` (children), `#g1` (grouped child), `#*`
(all children joined with `join`), `#text`, `#chars`, `#fn`, `#accN`, `#@attr`.
Variants are chosen with `when` conditions. See the header of
`src/shared/translator.mjs` for the full list.

## Tests

```powershell
npm test            # parser, translators, file format, keys/tokens, and real
                    # service + server + helper processes (trial, activation,
                    # expiry gating, telemetry, helper lifecycle)
npm run test:rust   # clipboard encoding unit tests
```

## Configuration

| Variable                                                       | Default                                            |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `MINIMATH_PORT` / `MINIMATH_HTTPS_PORT`                        | 5178 / 5179 (desktop shell uses an ephemeral port) |
| `MINIMATH_LICENSE_URL`                                         | `http://127.0.0.1:5180`                            |
| `MINIMATH_HOME`                                                | `%APPDATA%\MiniMath` (helper state)                |
| `MINIMATH_PUBLIC_KEY`                                          | `config/license-public.pem`                        |
| `MINIMATH_SERVICE_DATA` / `MINIMATH_SERVICE_PORT`              | `service-data/` / 5180                             |
| `MINIMATH_TRIAL_DAYS`                                          | 30                                                 |
| `MINIMATH_PIPE_LOG`                                            | unset; path to log helper traffic                  |
| `MINIMATH_NODE` / `MINIMATH_ROOT`                              | desktop shell: Node.js binary / app directory      |

## Not production-ready yet

- The license service stores keys in JSON files and listens on loopback over
  plain HTTP. Before real customers use it, put it behind HTTPS and use a database.
- The machine hash uses host name, user name, OS and CPU architecture. Changing any
  of these needs reactivation, which is free because the seat is simply rebound.
- The Word add-in's Office.js path has not been run inside Word. Its OMML output
  has been verified by inserting it into Word through COM, and the published
  task pane has been loaded from a Pages-style sub-path.
- The Mac code is type-checked for both Mac targets, but it has not been run on a Mac.
- The license service URL defaults to this computer (`127.0.0.1:5180`), so
  copies installed on other computers can only use the trial until the
  service is hosted online.
