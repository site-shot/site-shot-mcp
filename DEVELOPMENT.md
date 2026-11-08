# Developing site-shot-mcp

Notes for people working on this repository. Using the server is covered in [README.md](README.md).

## Tests

```bash
npm ci
npm run check            # syntax check
npm run smoke            # offline tests (stubbed fetch, no API key needed)
node test/integration.mjs  # real stdio handshake against the local source
npm run test:plugin      # plugin, marketplace, skill and README metadata tests
npm run validate:plugin  # claude plugin validate --strict (needs the claude CLI)
SITESHOT_API_KEY=yourkey npm start   # run the server on stdio
```

`test/live.mjs` makes a real capture with a real key; it is not part of the offline suites.

## Trying the Claude Code plugin from a checkout

Load the plugin directory for a single session:

```bash
claude --plugin-dir /absolute/path/to/site-shot-mcp/plugins/site-shot
```

Two things matter here. Pass an **absolute** path — `--plugin-dir` is resolved against the session's
working directory. And start that session from an ordinary project directory, **not from this
checkout**: this repo *is* the `site-shot-mcp` package, so npm resolves the name locally, finds no
linked binary, and the server dies with `sh: site-shot-mcp: command not found` before Claude Code
ever sees it. From an unrelated directory `npx` fetches the published package and starts it
normally — checked both ways: exit 127 in this checkout, clean stdio start from an empty one.

To exercise the real install path instead — marketplace resolution, manifests and the required
setting — add the checkout itself as a marketplace:

```bash
claude plugin marketplace add /absolute/path/to/site-shot-mcp
claude plugin install site-shot@site-shot
```

That installs into your user scope; undo it with `claude plugin uninstall site-shot@site-shot` and
`claude plugin marketplace remove site-shot`. The GitHub form (`site-shot/site-shot-mcp`) installs
what is on the public default branch, not a local branch.

## Trying the Codex plugin from a checkout

`codex plugin marketplace add /absolute/path/to/site-shot-mcp` installs from the checkout instead
of GitHub. Unless a server entry sets `cwd`, Codex starts the server from wherever you ran Codex, so
running Codex inside this repo hits the same local-name collision as above.

## The Tessl plugin

`plugins/site-shot-tessl/` is the Tessl Registry package: the shared skill and the pinned server.
Its skill, `LICENSE`, version and pin are copies; regenerate them with `npm run sync:tessl` after
editing the skill or bumping the version. `npm run test:plugin` fails while they differ.

Tessl does not support `env_vars` (`tessl plugin lint` 0.119.0 ignores it), so the server entry
passes the key as `"SITESHOT_API_KEY": "${SITESHOT_API_KEY}"`. Claude Code expands that from the
environment; Codex does not, and receives the literal text. The listing description tells Codex
users to replace the `env` table with `env_vars = ["SITESHOT_API_KEY"]`, and the server reports an
unexpanded placeholder instead of sending it to the API.

```bash
cd plugins/site-shot-tessl
npx @tessl/cli@0.119.0 plugin lint .
```

Publishing it (a Tessl login, a workspace, `"private": false` after Tessl approves it) is the
owner's step.

## Releasing

A release changes the version in every place a host reads it. `package.json` is the source;
`npm run test:plugin` ("every version this package states agrees with package.json" and the pin
tests) fails until all of these match:

- `package.json` (and `package-lock.json`)
- `server.json` (`version` and `packages[].version`)
- `manifest.json`
- `.claude-plugin/marketplace.json` (`plugins[].version`)
- `plugins/site-shot/.claude-plugin/plugin.json` and `plugins/site-shot/.codex-plugin/plugin.json`
- the pins `site-shot-mcp@<version>` in `plugins/site-shot/.mcp.json`, the Codex `mcpServers`, and
  the README snippets
- `plugins/site-shot-tessl/` (run `npm run sync:tessl`)

Plugin users stay on the pinned release until the manifests with the new pin are on the default
branch and they update (README: "Updating").
