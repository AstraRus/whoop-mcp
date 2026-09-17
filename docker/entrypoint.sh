#!/bin/sh
#
# WHOOP MCP container entrypoint (run by tini as PID 1's child).
#
# Started as root (the image has no USER line), it prepares the token folder
# for the unprivileged built-in `node` user and runs the server as `node`:
#
#   - Token folder: WHOOP_MCP_TOKEN_DIR, default $HOME/.whoop-mcp — the folder
#     earlier images (running as root) used: /root/.whoop-mcp in plain Docker,
#     or wherever a deployment pointed HOME (e.g. Railway with HOME=/home/node
#     and its volume at /home/node/.whoop-mcp). It is exported, because the
#     server's HOME becomes /home/node and it would otherwise look there.
#   - The folder, tokens.json and stale tokens.json.*.tmp files are handed to
#     node (never recursively) with 0700/0600 permissions, then a probe as node
#     checks that it can create, rename and delete a file there and read and
#     write tokens.json.
#   - If anything fails (read-only volume, rootless storage that refuses
#     chown, ...) it logs one warning and keeps running as root, which is what
#     earlier images did, so no deployment loses its tokens.
#
# Started as any other user (docker run --user 1000, Kubernetes runAsUser),
# it changes nothing: the server then uses $HOME/.whoop-mcp unless
# WHOOP_MCP_TOKEN_DIR is set explicitly.
#
# Escape hatch: WHOOP_MCP_RUN_AS_ROOT=1 skips the switch to node.
#
# Log lines are single JSON objects on stderr, like the server's own logs.
# They never contain token values.

set -eu

log() {
  # $1 = level, $2 = message (fixed text without quotes or backslashes)
  printf '{"ts":"%s","level":"%s","msg":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >&2
}

if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

TOKEN_DIR="${WHOOP_MCP_TOKEN_DIR:-${HOME:-/root}/.whoop-mcp}"
export WHOOP_MCP_TOKEN_DIR="$TOKEN_DIR"

NODE_USER="node"
TOKEN_FILE="$TOKEN_DIR/tokens.json"

# Why the switch to node was not possible (set by prepare_token_dir).
reason=""

fail() {
  reason="$1"
  return 1
}

# Hand the token folder to node and prove node can use it. Called only as an
# `if` condition, so `set -e` is suspended inside: every step checks its own
# result.
prepare_token_dir() {
  case "$TOKEN_DIR" in
    /) fail "the token folder cannot be /"; return 1 ;;
    /root | /root/) fail "the token folder cannot be /root itself"; return 1 ;;
    /*) ;;
    *) fail "WHOOP_MCP_TOKEN_DIR is not an absolute path"; return 1 ;;
  esac

  mkdir -p "$TOKEN_DIR" 2>/dev/null || { fail "cannot create the token folder"; return 1; }

  # node must be able to traverse /root to reach a folder below it.
  case "$TOKEN_DIR" in
    /root/*) chmod 711 /root 2>/dev/null || { fail "cannot make /root traversable"; return 1; } ;;
  esac

  if [ -L "$TOKEN_FILE" ]; then
    fail "tokens.json is a symbolic link"
    return 1
  fi

  chown "$NODE_USER:$NODE_USER" "$TOKEN_DIR" 2>/dev/null ||
    { fail "cannot change the owner of the token folder"; return 1; }
  chmod 700 "$TOKEN_DIR" 2>/dev/null ||
    { fail "cannot change the permissions of the token folder"; return 1; }

  if [ -e "$TOKEN_FILE" ]; then
    chown "$NODE_USER:$NODE_USER" "$TOKEN_FILE" 2>/dev/null ||
      { fail "cannot change the owner of tokens.json"; return 1; }
    chmod 600 "$TOKEN_FILE" 2>/dev/null ||
      { fail "cannot change the permissions of tokens.json"; return 1; }
  fi

  # Temp files a crash left behind (tokens.json.<pid>.<hex>.tmp). An unmatched
  # glob stays literal, so check that each entry exists; symlinks are skipped.
  for stale in "$TOKEN_DIR"/tokens.json.*.tmp; do
    [ -e "$stale" ] || continue
    [ -L "$stale" ] && continue
    chown "$NODE_USER:$NODE_USER" "$stale" 2>/dev/null ||
      { fail "cannot change the owner of a stale tokens.json temp file"; return 1; }
    chmod 600 "$stale" 2>/dev/null ||
      { fail "cannot change the permissions of a stale tokens.json temp file"; return 1; }
  done

  # Probe as node: the server writes tokens.json.<pid>.<hex>.tmp, renames it
  # over tokens.json and deletes leftovers.
  probe="$TOKEN_DIR/.entrypoint-probe.$$"
  if ! su-exec "$NODE_USER" sh -c 'umask 077 && : > "$1" && mv "$1" "$1.renamed" && rm "$1.renamed"' \
    entrypoint-probe "$probe" 2>/dev/null; then
    rm -f "$probe" "$probe.renamed" 2>/dev/null || true
    fail "the node user cannot create, rename and delete files in the token folder"
    return 1
  fi
  if [ -e "$TOKEN_FILE" ]; then
    su-exec "$NODE_USER" sh -c 'test -r "$1" && test -w "$1"' entrypoint-probe "$TOKEN_FILE" 2>/dev/null ||
      { fail "the node user cannot read and write tokens.json"; return 1; }
  fi
  return 0
}

if [ "${WHOOP_MCP_RUN_AS_ROOT:-}" = "1" ]; then
  reason="WHOOP_MCP_RUN_AS_ROOT=1"
elif ! command -v su-exec >/dev/null 2>&1; then
  reason="su-exec is not installed"
elif prepare_token_dir; then
  log info "entrypoint: running as node (uid $(id -u "$NODE_USER")); token folder prepared"
  export HOME="/home/$NODE_USER"
  exec su-exec "$NODE_USER" "$@"
fi

log warn "entrypoint: running as root ($reason); the server still works, see docs/deploy-railway.md"
exec "$@"
