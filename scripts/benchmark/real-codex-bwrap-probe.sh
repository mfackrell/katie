#!/usr/bin/env bash
set -euo pipefail
command -v bwrap >/dev/null || { echo BUBBLEWRAP_REQUIRED; exit 1; }
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/tmp" "$root/host-secret"
printf 'unavailable-from-agent' > "$root/host-secret/private"
# Mount only runtime binaries and the read-only SDK test sources. In particular,
# do NOT bind the host HOME, cloud credentials, or Docker socket.
bwrap --die-with-parent --new-session --unshare-all \
 --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
 --ro-bind /lib64 /lib64 --ro-bind "$PWD" /app \
 --bind "$root/tmp" /tmp --proc /proc --dev /dev \
 --setenv HOME /tmp/sandbox-home --setenv CODEX_HOME /tmp/sandbox-home/.codex \
 --setenv OPENAI_API_KEY '' --setenv CODEX_ACCESS_TOKEN '' \
 --chdir /app /usr/bin/node scripts/benchmark/real-codex-tools-probe.mjs
# The tool probe itself checks the actual filesystem edit, shell exit, and
# intercepted synthetic provider requests before reporting success.
echo REAL_CODEX_SANDBOX_PROBE_PASS
