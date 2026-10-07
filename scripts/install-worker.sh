#!/bin/sh
# Installs the IPS worker as a launchd agent so it runs always-on (and restarts on crash/login).
# Run from the checkout you want the worker to use (normally your main checkout, not a worktree).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NPM="$(command -v npm)"
PLIST="$HOME/Library/LaunchAgents/ai.opereit.ips.worker.plist"
mkdir -p "$REPO/data" "$HOME/Library/LaunchAgents"
sed -e "s#__REPO__#$REPO#g" -e "s#__NPM__#$NPM#g" -e "s#__PATH__#$(dirname "$NPM"):/usr/bin:/bin#g" \
  "$REPO/ops/ips-worker.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/ai.opereit.ips.worker" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Logs: tail -f $REPO/data/worker.log"
echo "Uninstall: launchctl bootout gui/$(id -u)/ai.opereit.ips.worker && rm $PLIST"
