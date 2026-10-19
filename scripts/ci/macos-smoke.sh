#!/usr/bin/env bash
# Smoke-test a built MiniMath.app on a GitHub macOS runner.
#   scripts/ci/macos-smoke.sh <path/to/MiniMath.app> <launch: yes|no>
# Always checks the bundle layout and signature. With "yes" (native
# architecture only) it also launches the app and checks that the bundled
# Node.js server starts, renders an equation, registers the Word add-in, and
# exits together with the app.
set -euo pipefail

APP="$1"
LAUNCH="${2:-no}"
RES="$APP/Contents/Resources"

echo "== bundle layout"
for path in "$RES/node/node" "$RES/addin/manifest.xml" "$RES/app/bin/minimath-server.mjs" \
            "$RES/app/node_modules/mathjax-full/js/mathjax.js" "$RES/app/node_modules/mathlive/mathlive.min.mjs" \
            "$RES/app/config/license-public.pem"; do
  test -e "$path" || { echo "missing: $path"; exit 1; }
  echo "ok: ${path#$APP/}"
done
test -x "$RES/node/node" || { echo "bundled node is not executable"; exit 1; }
file "$APP/Contents/MacOS/"* "$RES/node/node"
grep -q "github.io" "$RES/addin/manifest.xml" || { echo "manifest does not point at the published add-in"; exit 1; }

echo "== signature"
codesign --verify --deep --strict --verbose=2 "$APP"

if [ "$LAUNCH" != "yes" ]; then
  echo "launch skipped (cross-built architecture)"
  exit 0
fi

echo "== launch"
"$RES/node/node" --version
# Pretend Word has run once so the app registers its add-in.
WORD_DOCS="$HOME/Library/Containers/com.microsoft.Word/Data/Documents"
mkdir -p "$WORD_DOCS"
export MINIMATH_HOME="$RUNNER_TEMP/minimath-home"
"$APP/Contents/MacOS/"* > "$RUNNER_TEMP/app.log" 2>&1 &
APP_PID=$!
cleanup() { kill "$APP_PID" 2>/dev/null || true; cat "$RUNNER_TEMP/app.log" || true; }
trap cleanup EXIT

SERVER_PID=""
for _ in $(seq 1 60); do
  SERVER_PID=$(pgrep -P "$APP_PID" -f minimath-server.mjs || true)
  [ -n "$SERVER_PID" ] && break
  sleep 1
done
[ -n "$SERVER_PID" ] || { echo "server process never started"; exit 1; }
echo "server pid $SERVER_PID"

PORT=""
for _ in $(seq 1 30); do
  # lsof exits 1 until the server listens; that must not trip `set -e`.
  PORT=$(lsof -a -p "$SERVER_PID" -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1 {split($9,a,":"); print a[length(a)]; exit}' || true)
  [ -n "$PORT" ] && break
  sleep 1
done
[ -n "$PORT" ] || { echo "server never listened"; exit 1; }
BASE="http://127.0.0.1:$PORT"
echo "server at $BASE"

curl -fsS "$BASE/api/health"; echo
curl -fsS "$BASE/api/license"; echo
RENDER=$(curl -fsS -X POST "$BASE/api/render" -H "content-type: application/json" -H "x-minimath: 1" \
  -d '{"latex":"\\frac{a}{b}","prefs":{"sizePt":12,"color":"#000000","display":true}}')
[[ "$RENDER" == *'<svg'* ]] || { echo "render failed: ${RENDER:0:300}"; exit 1; }
echo "render ok: ${RENDER:0:100}"
curl -fsS -X POST "$BASE/api/translate" -H "content-type: application/json" -H "x-minimath: 1" \
  -d '{"translator":"latex","mathml":"<math><msqrt><mi>x</mi></msqrt></math>"}'; echo
PAGE=$(curl -fsS "$BASE/")
[[ "$PAGE" == *'<math-field'* ]] || { echo "editor page missing"; exit 1; }
echo "editor page served"

echo "== Word add-in registration"
for _ in $(seq 1 10); do
  [ -f "$WORD_DOCS/wef/minimath-manifest.xml" ] && break
  sleep 1
done
cmp "$WORD_DOCS/wef/minimath-manifest.xml" "$RES/addin/manifest.xml" || { echo "add-in manifest was not registered"; exit 1; }
echo "add-in manifest registered"

echo "== shutdown"
HELPER_PID=$(pgrep -P "$SERVER_PID" -f mtlib.mjs || true)
kill -TERM "$APP_PID"
for _ in $(seq 1 15); do
  if ! kill -0 "$APP_PID" 2>/dev/null && ! kill -0 "$SERVER_PID" 2>/dev/null && { [ -z "$HELPER_PID" ] || ! kill -0 "$HELPER_PID" 2>/dev/null; }; then
    echo "app, server and helper all exited"
    trap - EXIT
    exit 0
  fi
  sleep 1
done
echo "processes still running after shutdown:"; ps -p "$APP_PID,$SERVER_PID${HELPER_PID:+,$HELPER_PID}" || true
exit 1
