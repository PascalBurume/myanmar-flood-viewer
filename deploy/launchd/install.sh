#!/bin/bash
# Install the launchd agents on macOS: serve the site, and update it twice a day.
#
#   ./deploy/launchd/install.sh            install and start
#   ./deploy/launchd/install.sh --uninstall  stop and remove
#
# User agents, not system daemons, so none of this needs sudo and nothing is installed outside your
# home directory. The trade-off is that agents run only while you are logged in — which is right for
# a laptop and wrong for a server. On a Linux server use the systemd units beside this directory.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
SITE="$HOME/.local/share/myanmar-flood-viewer/site"
LOGS="$HOME/Library/Logs/myanmar-flood-viewer"
LABELS=(local.myanmar-flood.server local.myanmar-flood.update)

# launchd starts jobs with a bare PATH — not your shell's — so node and python3 must be found by
# absolute path or the agent dies at launch with a "no such file" that is easy to misread as a
# broken script.
NODE="$(command -v node)"
PYTHON="$(command -v python3)"
AGENT_PATH="$(dirname "$NODE"):$(dirname "$PYTHON"):/usr/bin:/bin:/usr/sbin:/sbin"

unload_all() {
  for label in "${LABELS[@]}"; do
    launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  done
}

if [[ "${1:-}" == "--uninstall" ]]; then
  unload_all
  rm -f "$AGENTS"/local.myanmar-flood.*.plist
  echo "removed. The published site is still at $SITE — delete it by hand if you want it gone."
  exit 0
fi

echo "repo   $REPO"
echo "site   $SITE"
echo "logs   $LOGS"
echo "node   $NODE"
echo "python $PYTHON"

mkdir -p "$AGENTS" "$SITE" "$LOGS"

# Publish once before starting the server, so it has something to serve immediately rather than
# 404ing until the first scheduled run hours later.
echo
echo "building and publishing the current data..."
"$PYTHON" "$REPO/scripts/run_pipeline.py" --publish "$SITE"

for label in "${LABELS[@]}"; do
  src="$REPO/deploy/launchd/$label.plist"
  dst="$AGENTS/$label.plist"
  sed -e "s|__REPO__|$REPO|g" \
      -e "s|__SITE__|$SITE|g" \
      -e "s|__LOGS__|$LOGS|g" \
      -e "s|__NODE__|$NODE|g" \
      -e "s|__PYTHON__|$PYTHON|g" \
      -e "s|__PATH__|$AGENT_PATH|g" \
      "$src" > "$dst"
  plutil -lint "$dst" > /dev/null
done

# Replace any previous copy rather than layering a second one on top.
unload_all
for label in "${LABELS[@]}"; do
  launchctl bootstrap "gui/$UID" "$AGENTS/$label.plist"
done

echo
echo "installed:"
launchctl list | grep myanmar-flood || true
echo
echo "  site      http://127.0.0.1:5180"
echo "  health    curl -s localhost:5180/api/health"
echo "  updates   01:17 and 13:17 daily"
echo "  logs      $LOGS"
echo "  run now   launchctl kickstart gui/$UID/local.myanmar-flood.update"
echo "  remove    $0 --uninstall"
