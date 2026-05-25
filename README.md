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

## Use with Claude Code

Add the server as a local stdio MCP from the project directory:

```bash
claude mcp add bilbasen --scope user -- bun run /absolute/path/to/bilbasen-mcp/src/index.ts
```

Scopes: `local` (default, this project only), `project` (writes a checked-in `.mcp.json`), `user` (available in all your projects). Check it loaded with `/mcp` inside Claude Code, or `claude mcp list` from the shell. See the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp) for full details.

## Use with Claude Desktop

Open **Settings → Developer → Edit Config** (or edit `claude_desktop_config.json` directly) and add:

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

Restart Claude Desktop. If `bun` isn't on the launchd PATH that Claude Desktop sees, use the absolute path from `which bun` instead of `"bun"`.

## Use with Claude.ai (web)

Claude.ai's **Settings → Connectors → Add custom connector** flow only accepts **remote MCP servers reachable over public HTTPS** — it cannot spawn local stdio processes. This server speaks stdio, so to use it from claude.ai you'd need to expose it over HTTP yourself (e.g. wrap it with an HTTP/SSE transport behind a public URL with auth) and then add that URL at [claude.ai/settings/connectors](https://claude.ai/settings/connectors). For personal local use, prefer **Claude Code** or **Claude Desktop** above. See [Anthropic's custom connector docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) for the connector flow.

## Development

```bash
bun run dev        # watch mode
bun run typecheck  # tsc --noEmit
```

## Disclaimer

This project is not affiliated with or endorsed by Bilbasen. It is provided for personal, educational and research use. Scraping may be subject to Bilbasen's terms of service — review them before deploying or sharing data obtained through this server. Use responsibly: keep request volumes low and respect the site's infrastructure.

## License

[MIT](LICENSE)
