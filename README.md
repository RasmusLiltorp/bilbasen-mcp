# bilbasen-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes [Bilbasen.dk](https://www.bilbasen.dk) — Denmark's largest used-car marketplace — as tools for LLM clients (Claude Desktop, Claude Code, etc.).

Bilbasen has no public API, so this server scrapes the site. It solves the AWS WAF JavaScript challenge once with a headless Chromium, then reuses the cookie for plain `fetch` calls.

## Tools

- **`bilbasen_search_listings`** — Search listings with filters (query, fuel, gear, price/year/mileage range, seller type, sort, pagination).
- **`bilbasen_get_listing`** — Fetch the full fact sheet, equipment list, dealer info and description for a single listing URL.
- **`bilbasen_price_stats`** — Aggregate price, mileage and model-year statistics (min / max / mean / median) across listings matching a filter.

All tools return both human-readable markdown and structured JSON.

## Requirements

- [Bun](https://bun.sh) (runtime)
- Chromium (installed automatically by Playwright on `bun install`)

## Install

```bash
git clone https://github.com/<you>/bilbasen-mcp.git
cd bilbasen-mcp
bun install
```

## Run

```bash
bun run start
```

The server speaks MCP over stdio.

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bilbasen": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/bilbasen-mcp/src/index.ts"]
    }
  }
}
```

## Use with Claude Code

```bash
claude mcp add bilbasen -- bun run /absolute/path/to/bilbasen-mcp/src/index.ts
```

## Development

```bash
bun run dev        # watch mode
bun run typecheck  # tsc --noEmit
```

## Disclaimer

This project is not affiliated with or endorsed by Bilbasen. It is provided for personal, educational and research use. Scraping may be subject to Bilbasen's terms of service — review them before deploying or sharing data obtained through this server. Use responsibly: keep request volumes low and respect the site's infrastructure.

## License

[MIT](LICENSE)
