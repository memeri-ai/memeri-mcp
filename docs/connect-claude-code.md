# Connect Claude Code

The installer does this for you (`curl -fsSL https://memeri.ai/install | bash`),
but here's what it sets up — or how to do it by hand.

## What gets configured

Claude Code talks to Memeri through the reconnect proxy in this repo — a thin
STDIO↔HTTP bridge that survives gateway restarts and session drops without
Claude Code noticing.

`~/.config/claude-code/mcp_config.json` (merged, not overwritten):

```json
{
  "mcpServers": {
    "memeri": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/memeri-mcp/proxy/mcp-reconnect-proxy.js"],
      "env": {
        "MCP_REMOTE_BASE": "<your gateway URL>",
        "MCP_AUTH": "Bearer <your token>"
      }
    }
  }
}
```

Your token comes from the Memeri workspace (Connect page). It is stored locally
in your config only.

## Verify

```bash
claude mcp list        # "memeri: ... ✔ Connected"
```

Then in a session, ask the agent to `get_project_context` — it should return
your project's memory. From there, agents recall decisions, create streams and
jobs, and post updates that appear live in your workspace.

## First-session tip

Tell the agent what project it's in once — or add a line to your project's
CLAUDE.md. Memeri's bootstrap tool (`get_memeri_bootstrap`) gives any agent the
full orientation on demand.
