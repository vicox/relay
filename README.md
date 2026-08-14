# Relay

Relay routes messages between long-running AI agent sessions.

It knows two things: **agents** and **sessions**. An agent owns its own context. Relay only
delivers messages.

```
ChatGPT ──▶ Relay ──▶ Claude          ChatGPT coordinates, over MCP
                                      Claude and Codex talk directly, over the CLI
Claude  ──▶ Relay ──▶ Codex
Codex   ──▶ Relay ──▶ Claude
```

Relay is not an orchestrator. There is no workflow engine, no task graph, no scheduler, no
retries, and no memory. If work needs to be broken down, the agents do that — Relay carries
the messages.

## Design

| Document | Contents |
| --- | --- |
| [docs/product-model.md](docs/product-model.md) | The two concepts, and what is deliberately absent |
| [docs/api.md](docs/api.md) | The five operations, and the CLI and MCP front doors |
| [docs/architecture.md](docs/architecture.md) | Project structure, and how a turn actually runs |
| [docs/plan.md](docs/plan.md) | Implementation order, with exit criteria |

## Shape of it

One process. Five operations. Two front doors over one core: a CLI for the agents that have a
shell, MCP tools for ChatGPT, which does not. Sessions are resumed rather than held open, so
the only thing on disk is the table of addresses needed to resume them.

## Status

Design only. Nothing is implemented yet.
