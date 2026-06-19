# Connect Codex CLI

Codex CLI supports MCP servers via its config (`~/.codex/config.toml`):

```toml
[mcp_servers.memeri]
command = "node"
args = ["/path/to/memeri-mcp/proxy/mcp-reconnect-proxy.js"]

[mcp_servers.memeri.env]
MCP_REMOTE_BASE = "<your gateway URL>"
MCP_AUTH = "Bearer <your token>"
```

Token and URL come from your workspace's Connect page.

Codex then shares the same project memory and work surface as every other
agent you've connected — a stream created by ChatGPT or Claude Code is visible
to Codex, and vice versa.
