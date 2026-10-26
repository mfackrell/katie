#!/usr/bin/env bash
set -euo pipefail
command -v bwrap >/dev/null || { echo 'BUBBLEWRAP_NOT_INSTALLED'; exit 1; }
root="$(mktemp -d)"; trap 'rm -rf "$root"' EXIT
mkdir -p "$root/work" "$root/secret"
printf 'fixture-secret' > "$root/secret/probe-key"
printf 'inside' > "$root/work/readme.txt"
# This qualifies kernel network + host-path fencing, not Codex behavior.
bwrap --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind "$root/work" /work \
  --proc /proc --dev /dev --tmpfs /tmp --chdir /work \
  /bin/sh -eu -c '
    test "$(cat readme.txt)" = inside
    test ! -e "'"$root"'/secret/probe-key"
    if command -v curl >/dev/null; then
      if curl --connect-timeout 1 --max-time 2 -fsS https://example.com >/dev/null 2>&1; then
        echo UNEXPECTED_NETWORK_EGRESS; exit 1
      fi
    fi
    echo BWRAP_FILESYSTEM_AND_NETWORK_FENCED
  '
