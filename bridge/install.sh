#!/usr/bin/env bash
# Installs the Wasabi print box on a Raspberry Pi (Raspberry Pi OS Lite, 64-bit) or any Debian/Ubuntu machine.
# Run from this folder:  sudo ./install.sh
# Before running, put config.json in this folder (copy it from Tables & QR → Kitchen and bar printers → Print box settings).
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "Run with sudo: sudo ./install.sh"; exit 1; }
[ -f config.json ] || { echo "config.json is missing: copy it from the owner page first"; exit 1; }
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Installing Node.js 22 from Debian's NodeSource repository…"
  apt-get update -y && apt-get install -y ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y && apt-get install -y nodejs
fi
id wasabi >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin wasabi
install -d -o root -g root -m 0755 /opt/wasabi-print-box
cp package.json package-lock.json lib.js printer.js print-box.js fake-printer.js README.md /opt/wasabi-print-box/
install -o root -g wasabi -m 0640 config.json /opt/wasabi-print-box/config.json
( cd /opt/wasabi-print-box && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )
cp wasabi-print-box.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now wasabi-print-box
sleep 3
systemctl --no-pager --lines=5 status wasabi-print-box || true
echo
echo "Done. The print box starts by itself after power cuts."
echo "Watch it:   journalctl -u wasabi-print-box -f"
echo "Then use 'Test print' on the owner page for each printer."
