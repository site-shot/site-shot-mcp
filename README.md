# Site-Shot MCP server

Give Claude, Cursor, and other AI agents the ability to **see public web pages** — take website screenshots
with [Site-Shot](https://www.site-shot.com/) over the [Model Context Protocol](https://modelcontextprotocol.io).

Real Chromium rendering · full-page capture · country proxies · automatic **ad & cookie-banner removal**
(cleaner images for the model to read).

## Quick start

1. **Get an API key** at <https://www.site-shot.com/start/>. A confirmed account's key comes with the
   free plan: 100 API captures a month, no card needed.
2. **Add the server to your agent** — pick your client below:
   [Claude Code](#claude-code-plugin) · [Codex CLI](#codex-cli-plugin) ·
   [Claude Desktop, Cursor and other clients](#claude-desktop--other-mcp-clients).
3. **Ask:** *"Take a screenshot of example.com."* The agent calls the server and shows you the image.

### About the key

The free plan renews every month; once its 100 captures are spent, the API answers 403 until it
renews. Free-plan captures come from the default location or the US; other countries need a paid
plan, and a request for one is refused but still counts toward the month. Paid plans start at $5/mo
for 2,000 captures ([pricing](https://www.site-shot.com/pricing/)). Accounts confirmed before
2026-10-30 switch the free plan on with one button on <https://www.site-shot.com/start/>; an account
that has had a paid plan before does not get it. Captures draw on that account's API allowance and
limits. The no-signup browser tool at <https://www.site-shot.com/> is for checking output quality;
it does not issue keys.

## Claude Code (plugin)

This repository is a Claude Code plugin marketplace. The plugin runs the published `site-shot-mcp`
package over stdio and declares the API key as a required sensitive setting, which Claude Code
collects in a masked prompt rather than asking you to paste it into a config file or a chat message.

### Install

```bash
claude plugin marketplace add site-shot/site-shot-mcp
claude plugin install site-shot@site-shot
```

Then, in a Claude Code session, enter the key:

```
/plugin configure site-shot@site-shot
```

From inside a session the first two steps are `/plugin marketplace add site-shot/site-shot-mcp` and
`/plugin install site-shot@site-shot`.

### The API key

The plugin declares `SITESHOT_API_KEY` as a required, sensitive setting. `/plugin configure` asks
for it, masks it as you type, and Claude Code substitutes it into the server's environment as
`${user_config.SITESHOT_API_KEY}`. Storage of the value is Claude Code's to handle.

Installing from the command line does not ask for the key: the install prints
`1 userConfig option not yet set (1 required)` and names `/plugin configure`. Configure it before
expecting a capture. Until the key is set, Claude Code does not list the server (`claude mcp list`
shows no site-shot entry) and the capture tools do not appear (observed with Claude Code 2.1.283).
Run `/plugin configure site-shot@site-shot` again to replace a wrong key.

The server's own behaviour is separate. When run directly over stdio **without a key**, it still
starts and prints a warning on stderr, and the capture tools return a clear missing-key error
instead of an image.

The plugin adds one skill (`site-shot:website-screenshots`) and the two capture tools
[below](#tools). It declares no hooks, no monitors and no scheduled capture jobs; the only process
it launches is the declared stdio MCP server.

### Updating

The plugin pins an exact `site-shot-mcp` release (now `site-shot-mcp@1.2.1`), so a new server
version reaches you through a plugin update:

```bash
claude plugin marketplace update site-shot
claude plugin update site-shot@site-shot
```

Restart Claude Code afterwards.

## Codex CLI (plugin)

This repository is also a Codex plugin marketplace. It installs the same plugin directory as Claude
Code does — one shared skill, the same pinned `site-shot-mcp@1.2.1` over stdio — with its own
manifest, because the two hosts wire the credential differently.

### Install

```bash
codex plugin marketplace add site-shot/site-shot-mcp
codex plugin add site-shot@site-shot
```

Exercised against Codex CLI 0.147.0 on macOS (arm64). Installing is not the same as being
configured, and neither is the same as a capture succeeding: the server still needs the key below,
and a capture still needs allowance left on that key's account, from the free plan or a paid plan.

### The API key

Codex forwards the variable named in the plugin's descriptor:

```json
{ "command": "npx", "args": ["-y", "site-shot-mcp@1.2.1"], "env_vars": ["SITESHOT_API_KEY"] }
```

`env_vars` is an allow-list of names, not values: no key appears in this descriptor, in the commands
below, or in the manual `config.toml` entry further down. You provision the key in the environment
Codex starts from, in one of two ways.

**For one session (most private).** macOS defaults to zsh, where `read -p` starts a coprocess rather
than printing a prompt, so invoke bash explicitly:

```bash
bash -c 'read -r -s -p "Site-Shot API key: " SITESHOT_API_KEY && printf "\n" && export SITESHOT_API_KEY && exec codex'
```

`-s` keeps the key off the screen, nothing here puts it in argv, and the export is scoped to that
child session instead of lingering in the shell you typed from. You type the key at each launch.

**For every session.** Keep the key in a file only you can read, and export it from your shell
profile (`~/.zshrc` or `~/.bashrc`):

```bash
mkdir -p ~/.config/site-shot && chmod 700 ~/.config/site-shot
# put the key in ~/.config/site-shot/api-key with your editor, then:
chmod 600 ~/.config/site-shot/api-key
```

```bash
# in ~/.zshrc or ~/.bashrc
export SITESHOT_API_KEY="$(cat ~/.config/site-shot/api-key)"
```

The trade-off: every program started from those shells can read the variable. A Codex started from
a desktop launcher or a remote session does not read your shell profile, so it runs the server
without a key; start Codex from a terminal instead. If the key ever arrives as the literal text
`${SITESHOT_API_KEY}`, the server says so: that is an `env` table Codex did not expand, and
`env_vars` is the fix.

### Updating

```bash
codex plugin marketplace upgrade site-shot
codex plugin add site-shot@site-shot
```

The first command refreshes the marketplace from GitHub; the second installs the plugin version it
now lists (the plugin pins an exact `site-shot-mcp` release).

### Manual MCP setup instead

If you would rather not install the plugin, the same stdio server can be configured by hand. This is
an **alternative to** the plugin, not an addition — run both and you have two configurations of one
server. Pick one.

```toml
[mcp_servers.site-shot]
command = "npx"
args = ["-y", "site-shot-mcp@1.2.1"]
env_vars = ["SITESHOT_API_KEY"]
```

`codex mcp add site-shot -- npx -y site-shot-mcp@1.2.1` writes that entry for you; add `env_vars`
afterwards, since `codex mcp add --env KEY=VALUE` would store the key in the file in clear text.
Check it with `codex mcp get site-shot`. If you already have an entry like this and now install the
plugin, remove the manual one deliberately with `codex mcp remove site-shot` — nothing here edits
your configuration for you.

## Claude Desktop & other MCP clients

1. Get a Site-Shot API key at <https://www.site-shot.com/start/>.
2. Add this to your Claude Desktop config (`claude_desktop_config.json`), with your key in place of
   `YOUR_API_KEY`:

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

Every integration above runs the same local stdio server, published on npm and in the official MCP Registry. Hosted HTTPS MCP is a separate deployment and client-compatibility path, not something these plugin install commands configure. Publication here does not imply listing in the shared ChatGPT/Codex public plugin directory or Claude's remote connector directory.

## Tools

Two tools, both returning the screenshot as an MCP image. There is no saved library, no listing,
no markdown conversion and no scheduling — this server captures images and hands them back.

### `capture_screenshot`
Screenshot a web page (viewport by default).

| Param | Type | Default | Notes |
|---|---|---|---|
| `url` | string (required) | — | Page to capture |
| `full_page` | boolean | `false` | Capture the whole scrollable page |
| `width` / `height` | number | API default | Viewport / device size |
| `format` | `"png"` \| `"jpeg"` \| `"webp"` | `png` | Image format. `webp` is lossless, about 35% smaller than `png` on the median page, max 16,383 px per side |
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
> Site-Shot API and can change without a release here. Pass explicit values whenever the size
> matters.

> **Country codes are ISO codes, never names.** Pass `"DE"`, not `"Germany"`. The API matches
> codes exactly and would otherwise render through a US proxy without telling you, so the server
> rejects full names before spending a render. `strict_country` (on by default) likewise turns an
> unavailable country into an error instead of a silent US screenshot — pass `false` to opt back
> into the fallback. [Supported countries →](https://www.site-shot.com/countries)

An argument the tools do not take is refused before any capture, with the name to use: the
Site-Shot API's own names such as `delay_time`, `full_size` or `no_ads` map to `wait_ms`,
`full_page` and `block_ads` here.

Every failure starts with the HTTP status and says what to do next (for example, a 401 points to
where the key is set). When the API answers with an error card instead of a screenshot, the card is
attached as an image, because it names the reason.

### `capture_full_page`
Same as `capture_screenshot` with full-page capture enabled.

A PNG taller than 2000 px comes back as several image tiles, top to bottom, each at most 2000 px
tall, with a short text label per tile. AI clients scale large images down before the model sees
them (Claude refuses anything over 8000 px on a side), so one 10,000 px image would arrive with its
text unreadable. The tiles are cut from the one capture; they cost nothing extra. A tall `jpeg` or
`webp` comes back whole, with a note.

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

## Development

Running the tests, trying the plugin from a checkout, and the release steps are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Requirements

Node.js ≥ 18 (uses the built-in `fetch`).

## License

MIT
