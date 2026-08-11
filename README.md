# bilbasen-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes [Bilbasen.dk](https://www.bilbasen.dk) - Denmark's largest used-car marketplace - as tools for LLM clients (Claude Desktop, Claude Code, etc.).

Bilbasen has no public API, so this server scrapes the site. It solves the AWS WAF JavaScript challenge once with a headless Chromium, then reuses the cookie for plain `fetch` calls.

## Tools

- **`bilbasen_search_listings`** - Search listings with filters (query, fuel, gear, price/year/mileage range, seller type, sort, pagination).
- **`bilbasen_get_listing`** - Fetch the full fact sheet, equipment list, dealer info and description for a single listing URL.
- **`bilbasen_price_stats`** - Aggregate price, mileage and model-year statistics (min / max / mean / median) across listings matching a filter.

All tools return both human-readable markdown and structured JSON.

### Advanced filters (opt-in)

`bilbasen_search_listings` can expose Bilbasen's full advanced filter panel:
towing capacity and tow-bar type, EV range / battery / charging, body type,
colour, doors, seats, boot size, drive wheels, horsepower, torque, acceleration,
cylinders, engine volume, fuel economy, green tax, service and inspection state,
CO2, EuroNorm, location radius, and 171 equipment flags.

These are **off by default**. They roughly triple the size of the tool
definitions the model has to read in every conversation (~2.1k to ~3.4k tokens),
which is a poor trade if you mostly search by make, price and year.

To turn them on, set `BILBASEN_FILTERS=full`:

```bash
claude mcp add bilbasen --scope user --env BILBASEN_FILTERS=full -- npx -y tsx /absolute/path/to/bilbasen-mcp/src/index.ts
```

In Claude Desktop, tick **Advanced search filters** in the extension's settings.

`bilbasen_price_stats` always uses the core filters, since statistics describe a
market segment; use `bilbasen_search_listings` for finer-grained filtering.

## Install

### Claude Desktop (one-click)

1. Download the latest `bilbasen-mcp.mcpb` from the [Releases page](https://github.com/RasmusLiltorp/bilbasen-mcp/releases/latest).
2. Double-click the file. Claude Desktop opens an install dialog - click **Install**.
3. Done. The first search takes ~30 s while Playwright downloads Chromium in the background; subsequent calls are instant.

No Node, JSON editing, or terminal commands required - Claude Desktop ships its own Node runtime.

### Claude Code

```bash
claude mcp add bilbasen --scope user -- npx -y tsx /absolute/path/to/bilbasen-mcp/src/index.ts
```

Or, if you've cloned and built the repo (`npm install && npm run build`):

```bash
claude mcp add bilbasen --scope user -- node /absolute/path/to/bilbasen-mcp/dist/index.js
```

Scopes: `local` (default, this project only), `project` (writes a checked-in `.mcp.json`), `user` (available in all your projects). Verify with `/mcp` inside Claude Code or `claude mcp list` from the shell. See the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).

### Claude.ai (web)

Claude.ai's **Settings → Connectors → Add custom connector** flow only accepts **remote MCP servers reachable over public HTTPS** - it cannot spawn local stdio processes. To use this server from claude.ai you'd need to wrap it with an HTTP/SSE transport behind a public URL with auth, then add that URL at [claude.ai/settings/connectors](https://claude.ai/settings/connectors). For personal local use, prefer **Claude Desktop** or **Claude Code** above. See [Anthropic's custom connector docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Development

Requirements: **Node.js ≥ 20**.

```bash
git clone https://github.com/RasmusLiltorp/bilbasen-mcp.git
cd bilbasen-mcp
npm install
npm run dev          # watch mode (tsx)
npm run typecheck    # tsc --noEmit
npm test             # unit tests (node --test)
npm run build        # bundle to dist/index.js
npm run pack:mcpb    # build + produce bilbasen-mcp.mcpb
```

Bilbasen silently ignores a query parameter whose name or value it does not
recognise and returns the full catalogue rather than an error, so a wrong
parameter name looks identical to a working filter in unit tests. `src/live.test.ts`
guards against that by asserting each filter actually narrows the result set.
It hits the live site, so it is opt-in:

```bash
BILBASEN_LIVE=1 npm test
```

Releases are cut by pushing a `v*` tag - [`.github/workflows/release.yml`](.github/workflows/release.yml) builds the `.mcpb` and attaches it to the GitHub Release automatically.

## Disclaimer

This project is not affiliated with or endorsed by Bilbasen. It is provided for personal, educational and research use. Scraping may be subject to Bilbasen's terms of service - review them before deploying or sharing data obtained through this server. Use responsibly: keep request volumes low and respect the site's infrastructure.

## License

[MIT](LICENSE)
