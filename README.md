# Site-Shot MCP server

Give Claude, Cursor, and other AI agents the ability to **see any web page** — take website screenshots
with [Site-Shot](https://www.site-shot.com/) over the [Model Context Protocol](https://modelcontextprotocol.io).

Real Chromium rendering · full-page capture · country proxies · automatic **ad & cookie-banner removal**
(cleaner images, fewer vision tokens).

## Quick start (Claude Desktop)

1. Get a Site-Shot API key at <https://www.site-shot.com/start/>.
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
| `width` / `height` | number | API default | Viewport / device size |
| `format` | `"png"` \| `"jpeg"` | `png` | Image format |
| `block_ads` | boolean | `true` | Remove ads |
| `block_cookie_banners` | boolean | `true` | Remove cookie-consent popups |
| `country` | string | — | Proxy country as a two-letter [ISO 3166-1 alpha-2](https://www.site-shot.com/countries) code, e.g. `"DE"` (auto IP/lang/tz/geo) |
| `strict_country` | boolean | `true` | Error out if the country has no proxy, instead of falling back to the US |
| `language` / `time_zone` / `geolocation` | string | — | Manual overrides |
| `wait_ms` | number | API default | Extra wait before capture (SPAs/animations) |
| `max_height` | number | 20000 (full page) | Cap captured height |

Returns the screenshot as an MCP image.

> **"API default" is not a number this package gets to state.** `width`, `height` and `wait_ms`
> are forwarded only when you pass them, so whatever applies when you don't is decided by the
> Site-Shot API and can change without a release here. Versions up to 1.1.0 printed pixel sizes
> for `width` / `height` that the API does not use — an agent that omitted them to take "the
> default" got a different viewport, with nothing in the returned image to reveal it. Pass
> explicit values whenever the size matters.

> **Country codes are ISO codes, never names.** Pass `"DE"`, not `"Germany"`. The API matches
> codes exactly and would otherwise render through a US proxy without telling you, so the server
> rejects full names before spending a render. `strict_country` (on by default) likewise turns an
> unavailable country into an error instead of a silent US screenshot — pass `false` to opt back
> into the fallback. [Supported countries →](https://www.site-shot.com/countries)

### `capture_full_page`
Same as `capture_screenshot` with full-page capture enabled.

## Why call this server instead of the agent's own browser?

If your agent drives a browser, it can screenshot pages itself — and for pages that must be signed
into or stepped through a flow, that is the right tool. For public URLs, delegating the capture to
this server is usually better engineering: every capture runs the same pipeline (no re-planning
between runs), can be taken from a specific country with matching locale and time zone
(`country` + `strict_country`), is scored by an image classifier with an escalating retry ladder
behind it before being returned, and costs a fraction of a cent instead of a browser session plus
vision tokens per look. The full comparison, both directions honestly argued:
[AI agent vs. screenshot API — who should capture the page](https://www.site-shot.com/blog/ai-agent-vs-screenshot-api/).

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
