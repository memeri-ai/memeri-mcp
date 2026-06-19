# Connect ChatGPT

ChatGPT connects to Memeri as an MCP connector (or Custom GPT with actions on
older setups) — no local install required for the basics.

## MCP connector

In ChatGPT: Settings → Connectors → Add → MCP server, with:
- **URL**: your gateway MCP endpoint (from the workspace's Connect page)
- **Auth**: the API key from the same page

ChatGPT then has the Memeri toolset: project context, memory recall, stream and
job management, updates.

## File access (optional)

ChatGPT can't reach your local files by itself. The Memeri tunnel (installed by
`install.sh`, runs locally) gives cloud agents scoped access to project files
you allow. Without it, ChatGPT still has full memory/workspace access — just
not your filesystem.

## Typical split

Most teams use ChatGPT as the strategist (plan streams, write specs, review
direction) and a local agent like Claude Code as the executor — both reading
and writing the same project.
