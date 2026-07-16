#!/bin/bash
# The ACP installer lives at agenticcontrolplane.com — this stub exists only
# because old docs linked here. It previously inlined a frozen copy of the
# plugin (v0.3.0) that could never update; the canonical installer now
# installs the plugin through the marketplace (auto-updating) instead.
set -e
echo "Fetching the ACP installer from agenticcontrolplane.com..."
curl -sf https://agenticcontrolplane.com/install.sh | bash
