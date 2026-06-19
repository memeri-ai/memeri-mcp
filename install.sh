#!/usr/bin/env bash
#
# Memeri bootstrap installer
# Usage:
#   curl -fsSL https://memeri.ai/install | bash
#
# Or, to inspect first (recommended):
#   curl -fsSL https://memeri.ai/install -o memeri-install.sh
#   less memeri-install.sh
#   bash memeri-install.sh
#
# What this script does:
#   1. Detects your environment (Claude Code presence, jq, curl)
#   2. Prompts for your Memeri auth token (paste from Connect page)
#   3. Writes ~/.claude/memeri.json with the token (user-level enable)
#   4. Adds Memeri to ~/.config/claude-code/mcp_config.json (merging)
#   5. Verifies the connection by hitting /api/v2/diagnostics/me
#   6. Generates an uninstaller at ~/.claude/memeri-uninstall.sh
#   7. Prints a summary
#
# Reverses cleanly: ~/.claude/memeri-uninstall.sh removes everything.
# Source: https://github.com/memeri-ai/memeri-mcp (canonical public home of this installer)

set -euo pipefail

# ── Branding ──────────────────────────────────────────────────────────
BANNER='
  ╔════════════════════════════╗
  ║       M E M E R I          ║
  ║  bootstrap installer       ║
  ╚════════════════════════════╝
'

# ── Config ────────────────────────────────────────────────────────────
PLATFORM_URL="${MEMERI_PLATFORM_URL:-https://memeri.ai}"
GATEWAY_URL="${MEMERI_GATEWAY_URL:-https://mcp.memeri.ai}"
MCP_URL="${GATEWAY_URL}/mcp"
CLAUDE_DIR="$HOME/.claude"
MEMERI_CONFIG="$CLAUDE_DIR/memeri.json"

# Resolve OS-specific Claude Code MCP config path
case "$(uname -s)" in
  Darwin*|Linux*)
    MCP_CONFIG_DIR="$HOME/.config/claude-code"
    ;;
  *)
    MCP_CONFIG_DIR="$HOME/.config/claude-code"
    ;;
esac
MCP_CONFIG="$MCP_CONFIG_DIR/mcp_config.json"

# ── Pretty output ─────────────────────────────────────────────────────
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*"; }
err()  { echo "  ✗ $*" 1>&2; }
step() { echo ""; echo "── $* ──"; }
ask()  { echo -n "  $* "; }

echo "$BANNER"

# ── Step 1: Environment check ─────────────────────────────────────────
step "Step 1 — checking environment"

if [[ -z "${BASH_VERSION:-}" ]]; then
  err "Run with bash, not sh. Try: curl -fsSL ${PLATFORM_URL}/install | bash"
  exit 1
fi
ok "bash $(echo "$BASH_VERSION" | cut -d'(' -f1)"

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required and not installed."
  exit 1
fi
ok "curl"

if ! command -v jq >/dev/null 2>&1; then
  warn "jq not found — recommended for JSON merging in MCP config"
  warn "Install: brew install jq | sudo apt install jq | sudo dnf install jq"
  HAS_JQ=0
else
  ok "jq $(jq --version)"
  HAS_JQ=1
fi

CLAUDE_FOUND=0
if command -v claude >/dev/null 2>&1; then
  ok "claude (Claude Code CLI)"
  CLAUDE_FOUND=1
else
  warn "claude (Claude Code CLI) not on PATH — plugin install will be skipped"
  warn "If you have Claude Code, the rest of the install still works."
fi

# ── Step 2: Get the user's token ──────────────────────────────────────
step "Step 2 — Memeri auth token"

# Prefer env var (CI / repeat installs); else prompt.
TOKEN="${MEMERI_AUTH_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "  Open the Connect page in your browser to grab your token:"
  echo "    ${PLATFORM_URL}/?tab=connect"
  echo "  (Account card → 👁 Show → 📋 Copy)"
  echo ""
  ask "Paste your token (cb_…):"
  # Read from the controlling terminal, NOT stdin. When invoked via
  # `curl ... | bash`, stdin is the curl pipe — `read` would otherwise
  # silently capture an empty value.
  if [[ -r /dev/tty ]]; then
    read -r TOKEN < /dev/tty
  else
    read -r TOKEN
  fi
fi

if [[ -z "$TOKEN" || ! "$TOKEN" =~ ^cb_ ]]; then
  err "Token must start with 'cb_'. Got: ${TOKEN:0:8}…"
  err "Find your token on the Connect page → Account → Copy."
  exit 1
fi
ok "Token captured (cb_${TOKEN:3:6}…${TOKEN: -4})"

# ── Step 3: Write user-level memeri.json ──────────────────────────────
step "Step 3 — writing user-level config"

mkdir -p "$CLAUDE_DIR"
if [[ -f "$MEMERI_CONFIG" ]]; then
  cp "$MEMERI_CONFIG" "${MEMERI_CONFIG}.bak.$(date +%s)"
  ok "Existing config backed up to ${MEMERI_CONFIG}.bak.<ts>"
fi

cat > "$MEMERI_CONFIG" <<EOF
{
  "auth_token": "$TOKEN",
  "gateway_url": "$GATEWAY_URL"
}
EOF
chmod 600 "$MEMERI_CONFIG"
ok "Wrote $MEMERI_CONFIG (mode 0600)"
ok "User-level telemetry enabled — all Claude Code windows will report"
ok "Per-folder opt-out: 'touch .claude/memeri-disabled' in any project"

# ── Step 4: MCP server config ─────────────────────────────────────────
step "Step 4 — Claude Code MCP server config"

mkdir -p "$MCP_CONFIG_DIR"

if [[ "$HAS_JQ" == "1" ]]; then
  # Merge: keep existing mcpServers, add 'memeri'
  if [[ -f "$MCP_CONFIG" ]]; then
    cp "$MCP_CONFIG" "${MCP_CONFIG}.bak.$(date +%s)"
    ok "Existing config backed up to ${MCP_CONFIG}.bak.<ts>"
    TMP=$(mktemp)
    jq --arg url "$MCP_URL" --arg token "$TOKEN" '
      .mcpServers = (.mcpServers // {})
      | .mcpServers.memeri = {
          "type": "streamable-http",
          "url": $url,
          "auth": { "type": "bearer", "token": $token }
        }
    ' "$MCP_CONFIG" > "$TMP" && mv "$TMP" "$MCP_CONFIG"
  else
    jq -n --arg url "$MCP_URL" --arg token "$TOKEN" '
      { mcpServers: { memeri: { type: "streamable-http", url: $url, auth: { type: "bearer", token: $token } } } }
    ' > "$MCP_CONFIG"
  fi
else
  # No jq — write fresh only. Don't risk corrupting an existing file.
  if [[ -f "$MCP_CONFIG" ]]; then
    warn "$MCP_CONFIG already exists; skipping merge (jq not installed)"
    warn "Add this manually:"
    cat <<EOF
  "memeri": {
    "type": "streamable-http",
    "url": "$MCP_URL",
    "auth": { "type": "bearer", "token": "$TOKEN" }
  }
EOF
  else
    cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "memeri": {
      "type": "streamable-http",
      "url": "$MCP_URL",
      "auth": {
        "type": "bearer",
        "token": "$TOKEN"
      }
    }
  }
}
EOF
  fi
fi
chmod 600 "$MCP_CONFIG" 2>/dev/null || true
ok "Wrote $MCP_CONFIG"

# ── Step 5b: Local console (powers in-browser terminals) ──────────────
step "Step 5 — local console (in-browser terminals)"

CONSOLE_DIR="$HOME/.memeri/console"
CONSOLE_LAUNCHER="$HOME/.memeri/start-console.sh"
CONSOLE_TARBALL_URL="${PLATFORM_URL}/console.tar.gz"

console_running() { curl -fsS --max-time 2 "http://localhost:4000/api/config" >/dev/null 2>&1; }

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "  Installing the local console to $CONSOLE_DIR …"
  mkdir -p "$HOME/.memeri"
  TMP_TAR="$(mktemp)"
  if curl -fsSL "$CONSOLE_TARBALL_URL" -o "$TMP_TAR"; then
    rm -rf "$CONSOLE_DIR"; mkdir -p "$CONSOLE_DIR"
    tar xzf "$TMP_TAR" -C "$CONSOLE_DIR" --strip-components=1
    rm -f "$TMP_TAR"
    echo "  Building console dependencies (compiles node-pty, ~1 min)…"
    if (cd "$CONSOLE_DIR" && npm install --omit=dev --no-audit --no-fund >/tmp/memeri-console-npm.log 2>&1); then
      ok "Local console installed"
      cat > "$CONSOLE_LAUNCHER" <<EOF
#!/usr/bin/env bash
# Start the Memeri local console (in-browser terminals). Listens on :4000.
cd "$CONSOLE_DIR" && exec node server.js
EOF
      chmod +x "$CONSOLE_LAUNCHER"
      if console_running; then
        ok "Console already running on :4000"
      else
        nohup "$CONSOLE_LAUNCHER" >"$HOME/.memeri/console.log" 2>&1 &
        sleep 2
        if console_running; then
          ok "Console started on :4000"
        else
          warn "Console installed but didn't confirm on :4000 yet — start it with: $CONSOLE_LAUNCHER"
        fi
      fi
    else
      warn "Console dependency build failed (see /tmp/memeri-console-npm.log)"
      warn "Retry later with: cd $CONSOLE_DIR && npm install"
    fi
  else
    warn "Couldn't download the console from $CONSOLE_TARBALL_URL — skipping"
  fi
else
  warn "Node.js + npm not found — skipping the local console."
  warn "The in-browser Terminal needs it. Install Node 18+ and re-run this installer."
fi

# ── Step 5c: Local tunnel (for ChatGPT / Codex file access) ───────────
step "Step 5b — local tunnel (ChatGPT / Codex file access)"

TUNNEL_DIR="$HOME/.memeri/tunnel"
TUNNEL_LAUNCHER="$HOME/.memeri/start-tunnel.sh"
TUNNEL_TARBALL_URL="${PLATFORM_URL}/tunnel.tar.gz"

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  echo "  Installing the tunnel to $TUNNEL_DIR …"
  mkdir -p "$HOME/.memeri"
  TMP_TT="$(mktemp)"
  if curl -fsSL "$TUNNEL_TARBALL_URL" -o "$TMP_TT"; then
    rm -rf "$TUNNEL_DIR"; mkdir -p "$TUNNEL_DIR"
    tar xzf "$TMP_TT" -C "$TUNNEL_DIR" --strip-components=1
    rm -f "$TMP_TT"
    echo "  Installing tunnel dependencies…"
    if (cd "$TUNNEL_DIR" && npm install --omit=dev --no-audit --no-fund >/tmp/memeri-tunnel-npm.log 2>&1); then
      ok "Tunnel installed"
      # Launcher bakes in api + token; user runs it IN the project folder they
      # want the cloud AI to access (the tunnel root = current directory).
      cat > "$TUNNEL_LAUNCHER" <<EOF
#!/usr/bin/env bash
# Start the Memeri tunnel — lets ChatGPT/Codex reach files in THIS folder.
# Run it from the project directory you want the AI to access.
exec node "$TUNNEL_DIR/bin/codebridge-tunnel.js" --api="$PLATFORM_URL" --token="$TOKEN" "\$@"
EOF
      chmod 700 "$TUNNEL_LAUNCHER"
      ok "Tunnel ready — start it in a project with: $TUNNEL_LAUNCHER"
    else
      warn "Tunnel dependency install failed (see /tmp/memeri-tunnel-npm.log)"
    fi
  else
    warn "Couldn't download the tunnel from $TUNNEL_TARBALL_URL — skipping"
  fi
else
  warn "Node.js + npm not found — skipping the tunnel."
fi

# ── Step 6: Verification ──────────────────────────────────────────────
step "Step 6 — verifying"

DIAG_URL="${PLATFORM_URL}/api/v2/diagnostics/me"
HTTP_CODE=$(curl -s -o /tmp/memeri-diag.json -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "$DIAG_URL" || echo "000")

if [[ "$HTTP_CODE" == "200" ]]; then
  ok "Auth + diagnostics endpoint reachable"
  if [[ "$HAS_JQ" == "1" ]]; then
    OVERALL=$(jq -r '.overall_status // "unknown"' /tmp/memeri-diag.json 2>/dev/null || echo "unknown")
    echo "    Current telemetry status: $OVERALL"
    echo "    (will turn 'healthy' once you use Claude Code with the new config)"
  fi
else
  warn "Diagnostics endpoint returned HTTP $HTTP_CODE"
  warn "Token may be wrong. Generate a new one on the Connect page if needed."
fi
rm -f /tmp/memeri-diag.json

# ── Step 7: Uninstaller ───────────────────────────────────────────────
step "Step 7 — generating uninstaller"

UNINSTALL="$CLAUDE_DIR/memeri-uninstall.sh"
cat > "$UNINSTALL" <<'EOF'
#!/usr/bin/env bash
# Memeri uninstaller — removes user-level config and MCP server entry.
set -euo pipefail
echo "Removing Memeri user-level telemetry config…"
rm -f "$HOME/.claude/memeri.json"
echo "Removing local console + tunnel…"
rm -rf "$HOME/.memeri/console" "$HOME/.memeri/start-console.sh"
rm -rf "$HOME/.memeri/tunnel" "$HOME/.memeri/start-tunnel.sh"
echo "Removing Memeri from Claude Code MCP config…"
MCP_CONFIG="$HOME/.config/claude-code/mcp_config.json"
if [[ -f "$MCP_CONFIG" ]] && command -v jq >/dev/null 2>&1; then
  TMP=$(mktemp)
  jq 'if .mcpServers.memeri then del(.mcpServers.memeri) else . end' "$MCP_CONFIG" > "$TMP" && mv "$TMP" "$MCP_CONFIG"
fi
echo "✓ Memeri uninstalled. (Plugin must be removed inside Claude Code: /plugin uninstall memeri)"
EOF
chmod +x "$UNINSTALL"
ok "Uninstaller at $UNINSTALL"

# ── Done ──────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ✓ Memeri configured."
echo "════════════════════════════════════════════════════════════"
echo ""
echo "  • Token:    cb_${TOKEN:3:6}…${TOKEN: -4}"
echo "  • Hook:     enabled at user level (~/.claude/memeri.json)"
echo "  • MCP:      added to Claude Code config"
echo "  • Plugin:   manual step inside Claude Code (see Step 5 above)"
echo "  • Console:  installed at ~/.memeri/console (start: ~/.memeri/start-console.sh)"
echo "  • Tunnel:   installed (ChatGPT/Codex file access) — start in a project: ~/.memeri/start-tunnel.sh"
echo ""
echo "  Next:"
echo "    1. Open Claude Code."
echo "    2. Run /mcp — confirm 'memeri' is connected."
echo "    3. Open Memeri → Connect — the pre-flight checks should turn green."
echo "    4. Open Memeri → Terminal — launch an agent on your project."
echo "    5. (ChatGPT/Codex only) run ~/.memeri/start-tunnel.sh in your project folder."
echo ""
echo "  Trouble? See ${PLATFORM_URL}/?tab=wiki — Telemetry → Troubleshooting"
echo ""
