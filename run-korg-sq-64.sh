#!/usr/bin/env bash
# Serve the SQ-64 browser workbench (Vue updater + WebAssembly emulator) with the
# Vite dev server, as README.md documents (cd web && npm run dev). No QEMU and
# no common engine; AV_ENGINE only locates the workspace (its parent) for
# tools/lab-net.
set -euo pipefail
target=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
engine=${AV_ENGINE:-$target/../../../engine}
workspace=${AV_WORKSPACE:-$(dirname -- "$engine")}
workspace=$(CDPATH= cd -- "$workspace" 2>/dev/null && pwd || printf '%s\n' "$workspace")
lab_id=korg-sq-64
fallback=${SQ64_PORT:-14891}
lab_ok=0
if [[ -f $workspace/tools/lab-net/lab_ip.sh ]]; then
    # shellcheck source=/dev/null
    . "$workspace/tools/lab-net/lab_ip.sh"
    if [[ ${1:-} == --help || ${1:-} == -h ]]; then av_lab_resolve "$lab_id" 2>/dev/null; else av_lab_resolve "$lab_id"; fi
    lab_ok=1
else
    AV_LAB_MODE=localhost AV_LAB_IP=127.0.0.1 AV_LAB_HOST=
    av_lab_port() { printf '%s\n' "$2"; }
    av_lab_url() { printf '%s://localhost:%s/\n' "$1" "$3"; }
fi
port=$(av_lab_port 80 "$fallback")
url=$(av_lab_url http 80 "$fallback")
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    cat <<HELP
Usage: ./run-korg-sq-64.sh [additional vite options]

Serves the SQ-64 browser app from web/ (Vite dev server, hot reload) in the
foreground; ready in ~1-2 s ("VITE ... ready"). Open the URL, the Browser
emulator tab opens by default: load a caller-owned .bin/.elf/.vsb (or the
bundled original probe web/examples/browser-probe.bin) and press Power on.
The ARM firmware runs in the browser (unicorn.js WebAssembly), so the
emulator UI (pads, buttons, encoders, display, Device tools, Inspect/debug)
is the browser page itself. No Korg firmware is shipped.

Web UI:
  Lab mode       http://sq-64.avlab/  =  http://10.77.0.91/  (port 80; reachable
                 from Windows once tools/lab-net is set up; check with
                 $workspace/tools/lab-net/labnet.sh status)
  Localhost mode http://localhost:$fallback/ (lab subnet not set up; also reachable
                 from Windows as localhost:$fallback under WSL2)
  Current mode   $AV_LAB_MODE: $url
  /emulator/ is the standalone emulator; /?workspace=tools opens Device tools.

Stop: Ctrl-C. State: none on disk; each browser page is a fresh session
(emulated flash lives in the page and is discarded on reload).

Environment:
  SQ64_PORT     localhost-mode port (default 14891)
  AV_LAB=0      force localhost mode; AV_LAB_IP=ADDR binds another local address
  AV_ENGINE / AV_WORKSPACE  locate the workspace (default ../../../engine, ../../..)
Other Vite options pass through (e.g. --open, --port N). The optional native Python
workbench is separate: python -m sq64_emulator (see README.md).
HELP
    exit 0
fi
((lab_ok)) || printf 'lab-net: %s/tools/lab-net/lab_ip.sh not found; using 127.0.0.1\n' "$workspace" >&2
missing() {
    printf 'Missing required local artifact: %s\nProduce it with: %s\n' "$1" "$2" >&2
    exit 1
}
command -v node >/dev/null || missing "node (PATH; Node 24 or 26)" "install Node.js 24+"
[[ -x $target/web/node_modules/.bin/vite ]] || missing "$target/web/node_modules/.bin/vite" "cd web && npm ci"
[[ -f $target/web/emulator/index.html ]] || missing "$target/web/emulator/index.html" "git -C $target checkout -- web"
# Vite admits IP-address Host headers; the lab hostname needs an explicit allowance.
lab_host=${AV_LAB_HOST:-}
if [[ -z $lab_host && -f $workspace/tools/lab-net/devices.tsv ]]; then
    lab_host=$(awk -F'\t' -v id="$lab_id" '$1 == id { print $3 }' "$workspace/tools/lab-net/devices.tsv")
fi
if [[ -n $lab_host ]]; then export SQ64_ALLOWED_HOSTS=${SQ64_ALLOWED_HOSTS:+$SQ64_ALLOWED_HOSTS,}$lab_host; fi
printf 'SQ-64 browser workbench (%s mode, %s%s)\nOpen (Linux or Windows): %s\n' \
    "$AV_LAB_MODE" "$AV_LAB_IP" "${AV_LAB_HOST:+ = $AV_LAB_HOST}" "$url"
cd "$target/web"
# A caller-supplied --port/--host replaces the launcher's (Vite rejects duplicates).
vite=(--strictPort)
[[ " $* " == *" --host"* ]] || vite+=(--host "$AV_LAB_IP")
[[ " $* " == *" --port"* ]] || vite+=(--port "$port")
exec npm run dev -- "${vite[@]}" "$@"
