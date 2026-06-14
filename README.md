# Site-Shot MCP server

Give Claude, Cursor, and other AI agents the ability to **see any web page** — take website screenshots
with [Site-Shot](https://www.site-shot.com/) over the [Model Context Protocol](https://modelcontextprotocol.io).

Real Chromium rendering · full-page capture · country proxies · automatic **ad & cookie-banner removal**
(cleaner images, fewer vision tokens).

## Quick start (Claude Desktop)

1. Get a Site-Shot API key at <https://www.site-shot.com/pricing/>.
2. Add this to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "site-shot": {
      "command": "npx",
      "args": ["-y", "site-shot-mcp"],
      "env": { "SITESHOT_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```

3. Restart Claude Desktop. Ask it to *"take a full-page screenshot of https://news.ycombinator.com"* and
   it will call the server and show you the image.

Works the same way in any MCP client (Cursor, Cline, VS Code, LangChain, CrewAI) — point the client at
`npx -y site-shot-mcp` with `SITESHOT_API_KEY` in the environment.

## Tools

### `capture_screenshot`
Screenshot a web page (viewport by default).

| Param | Type | Default | Notes |
|---|---|---|---|
| `url` | string (required) | — | Page to capture |
| `full_page` | boolean | `false` | Capture the whole scrollable page |
| `width` / `height` | number | 1280 / 1024 | Viewport / device size |
| `format` | `"png"` \| `"jpeg"` | `png` | Image format |
| `block_ads` | boolean | `true` | Remove ads |
| `block_cookie_banners` | boolean | `true` | Remove cookie-consent popups |
| `country` | string | — | Proxy country, e.g. `"Germany"` (auto IP/lang/tz/geo) |
| `language` / `time_zone` / `geolocation` | string | — | Manual overrides |
| `wait_ms` | number | — | Wait before capture (SPAs/animations) |
| `max_height` | number | 20000 (full page) | Cap captured height |

Returns the screenshot as an MCP image.

### `capture_full_page`
Same as `capture_screenshot` with full-page capture enabled.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `SITESHOT_API_KEY` | yes | Your Site-Shot API key (used as `userkey`). |

The server is a thin wrapper over the existing Site-Shot HTTP API (`https://api.site-shot.com/`) — no
separate backend.

## Local development

```bash
npm install
npm run check   # syntax check
npm run smoke   # offline tests (stubbed fetch, no API key needed)
SITESHOT_API_KEY=yourkey npm start   # run the server on stdio
```

## Requirements

Node.js ≥ 18 (uses the built-in `fetch`).

## License

MIT
