# memeri-mcp

**Memeri gives Claude, Claude Code, ChatGPT and Codex shared project memory.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Status: early access](https://img.shields.io/badge/status-early%20access-34d399)
[![memeri.ai](https://img.shields.io/badge/memeri.ai-visit-34d399)](https://memeri.ai)

<!-- Banner slot: drop docs/assets/memeri-banner.png (glyph + wordmark, emerald on near-black)
     and uncomment. Kept commented so the README never shows a broken image.
<p align="center"><img src="docs/assets/memeri-banner.png" alt="Memeri" width="600"></p>
-->

This repo is the open connector for [Memeri](https://memeri.ai). It's the installer, the MCP proxy, and the connection docs: everything that runs on *your* machine to connect an AI agent to a Memeri workspace, published so you can read exactly what you're installing before you let agents near your projects.

## What Memeri is

Memeri is a persistent workspace for AI-assisted software development. It gives Claude Code, ChatGPT, Codex, and any agent you connect a structured memory of your project (the decisions, the constraints, what matters now) and structured work to do (streams, jobs, todos, visible rather than buried in chat history).

Open a new agent and it already knows the project. It works where you can see it, and it picks up where the last session left off, across tools and across weeks.

The Memeri service (the memory engine, project understanding, and workspace UI) is a hosted product, in [early access at memeri.ai](https://memeri.ai). This repo is the client side: the part that runs on your machine, open so you can audit it.

## Quick start

From your Memeri workspace you'll get a one-line setup command:

```bash
MEMERI_AUTH_TOKEN="<your token>" curl -fsSL https://memeri.ai/install | bash
```

The installer:

1. Detects your environment (Claude Code, `jq`, `curl`)
2. Writes `~/.claude/memeri.json` with your token
3. Registers the `memeri` MCP server in your Claude Code config (merging, never clobbering)
4. Optionally sets up the local console (terminal workspace) and tunnel (for ChatGPT / Codex file access)

Prefer to read before you run? The whole installer is [`install.sh`](./install.sh): plain bash, no curl-pipe surprises beyond what you're reading.

## What's in this repo

| Path | What it is |
|---|---|
| [`install.sh`](./install.sh) | The bootstrap installer served at `/install` |
| [`proxy/`](./proxy) | STDIO↔HTTP MCP proxy with automatic session reconnection: what your agent's MCP config actually runs |
| [`docs/`](./docs) | Connection guides per agent (Claude Code, ChatGPT, Codex) |
| [`examples/`](./examples) | Ready-to-paste MCP config snippets |

## Connecting an agent

- [Claude Code](./docs/connect-claude-code.md)
- [ChatGPT (Custom GPT / connector)](./docs/connect-chatgpt.md)
- [Codex CLI](./docs/connect-codex.md)

## What runs where

The honest data-flow picture:

- **On your machine:** this connector, your agents, the optional local console and tunnel. Agents execute tools locally, with your user's permissions.
- **On Memeri's servers:** your project's structured memory (decisions, streams, jobs, updates) and telemetry about agent tool calls. That's what makes cross-session, cross-agent memory work.
- **Never through Memeri:** your agent's LLM traffic. Claude Code talks to Anthropic, ChatGPT to OpenAI, under your accounts and their terms. Memeri is not in that path and makes no LLM calls over your content.

Full details are in the privacy policy and AI access disclosure at [memeri.ai](https://memeri.ai).

## Early access

The service is in early access on interim infrastructure, so the installer's default endpoints are overridable via `MEMERI_PLATFORM_URL` / `MEMERI_GATEWAY_URL`. Canonical endpoints move to memeri.ai at general availability, and the installer is forward-compatible.

## Security

Found something? See [SECURITY.md](./SECURITY.md). Please don't open public issues for vulnerabilities.

## License

[MIT](./LICENSE).
