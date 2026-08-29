#!/usr/bin/env bash
# Removes containers and networks left behind by testcontainers reuse (see
# tests/setup/global-setup.ts). Ryuk is disabled for rootless podman, so nothing else
# reaps them between local runs.
set -euo pipefail

podman ps -aq --filter "label=org.testcontainers=true" | xargs -r podman rm -f
podman network ls -q --filter "label=org.testcontainers=true" | xargs -r podman network rm
