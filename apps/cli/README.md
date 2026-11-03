# @eyrie-hq/cli

A live architecture map of your codebase that updates as you (or your coding agent) change the code. This is the `eyrie` command: it parses a repository locally, builds a code knowledge graph, derives a small architecture graph from it, and shows it as an interactive map.

```bash
npx -y @eyrie-hq/cli /path/to/your/repo
```

This indexes the repository and opens the map in your browser. Leave it running and edit code; the map follows.

Coding agents reach the same graph over MCP:

```bash
claude mcp add eyrie -- npx -y @eyrie-hq/cli mcp /path/to/your/repo
```

Requires Node.js 22.13 or newer. No native modules: one package serves every platform.

Source, desktop app and documentation: [eyrie-hq/eyrie](https://github.com/eyrie-hq/eyrie). License: GNU AGPL-3.0-only.
