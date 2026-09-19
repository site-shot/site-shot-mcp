// Metadata tests for the Claude Code plugin packaging.
//
// Nothing here talks to the Site-Shot API. These tests guard the packaging
// claims instead: that the marketplace entry resolves to a real directory, that
// the MCP command stays pinned to the released npm package, that the API key is
// a placeholder rather than a baked-in secret, that the plugin ships only the
// files it is supposed to ship, that the skill names tools the server actually
// serves, and that the README's copy-paste commands match the manifests they
// document. Each of these has a silent-wrong failure mode: a plugin that
// installs and looks fine while pointing at the wrong package, leaking a key, or
// telling an agent to call a tool that does not exist.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...p) => readFileSync(join(repoRoot, ...p), "utf8");
const readJson = (...p) => JSON.parse(read(...p));

const pkg = readJson("package.json");
const marketplace = readJson(".claude-plugin", "marketplace.json");
const entry = marketplace.plugins?.[0];
const pluginDir = String(entry?.source ?? "").replace(/^\.\//, "");
const plugin = readJson(pluginDir, ".claude-plugin", "plugin.json");
const mcp = readJson(pluginDir, ".mcp.json");
const readme = read("README.md");

/** Every file under dir, as repo-relative POSIX paths. */
function filesUnder(dir) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      if (statSync(child).isDirectory()) walk(child);
      else out.push(relative(repoRoot, child).split(sep).join("/"));
    }
  };
  walk(join(repoRoot, dir));
  return out.sort();
}

/** The README text under a `## ` heading, up to the next `## ` heading. */
function section(heading) {
  const start = readme.indexOf(heading);
  assert.ok(start > -1, `README has a "${heading}" section`);
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

/** The tools and params the server actually serves, read over a real MCP session. */
async function servedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ apiKey: "TEST_KEY_NOT_USED", fetchImpl: async () => {
    throw new Error("metadata tests must never call the API");
  } });
  const client = new Client({ name: "plugin-metadata-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

test("marketplace entry resolves to the plugin directory it names", () => {
  assert.equal(marketplace.name, "site-shot", "marketplace keeps the brand name");
  assert.match(marketplace.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case marketplace name");
  assert.ok(marketplace.owner?.name, "marketplace declares an owner");
  assert.equal(marketplace.plugins.length, 1, "exactly one plugin is offered");

  assert.equal(entry.source, "./plugins/site-shot", "relative-path source, not a remote fetch");
  assert.ok(entry.source.startsWith("./"), "relative sources must start with ./");
  assert.ok(statSync(join(repoRoot, pluginDir)).isDirectory(), `${pluginDir} exists`);

  // The install id users type is `<entry.name>@<marketplace.name>`. If the entry name
  // and the manifest name drift apart, that id silently stops resolving.
  assert.equal(entry.name, plugin.name, "marketplace entry name matches plugin.json name");
  assert.equal(pluginDir.split("/").pop(), plugin.name, "directory name matches plugin name");
});

test("metadata is real and attributable, with no invented endorsements", () => {
  for (const url of [plugin.homepage, plugin.repository, marketplace.plugins[0].homepage]) {
    if (url) assert.match(url, /^https:\/\//, `${url} must be https`);
  }
  assert.equal(plugin.repository, pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  assert.equal(plugin.license, pkg.license);
  assert.ok(plugin.author?.name, "plugin names its author");

  const text = JSON.stringify(marketplace) + JSON.stringify(plugin);
  assert.doesNotMatch(
    text,
    /\b(official(ly)? (approved|endorsed|verified)|anthropic[- ]approved|openai[- ]approved|certified|verified partner)\b/i,
    "no vendor approval or badge we have not been granted",
  );
});

test("the MCP command stays pinned to the released npm package", () => {
  const servers = mcp.mcpServers;
  assert.ok(servers, ".mcp.json uses the documented mcpServers wrapper");
  assert.deepEqual(Object.keys(servers), ["site-shot"], "one server, named for the brand");

  const server = servers["site-shot"];
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", `site-shot-mcp@${pkg.version}`], "pinned to this repo's version");

  // A floating tag would let a future npm release change what installed users run,
  // with no commit here to review it.
  const spec = server.args.at(-1);
  assert.match(spec, /^site-shot-mcp@\d+\.\d+\.\d+$/, "exact version, never @latest or a range");

  // stdio is the only transport this package speaks; a url here would mean a remote
  // server that does not exist yet.
  assert.equal(server.url, undefined, "no remote URL — the public HTTPS server is not built");
  assert.equal(server.headers, undefined, "no HTTP headers: stdio server");
});

test("the plugin asks Claude Code for the key as required sensitive config", () => {
  const cfg = plugin.userConfig?.SITESHOT_API_KEY;
  assert.ok(cfg, "plugin.json declares userConfig.SITESHOT_API_KEY");
  assert.deepEqual(Object.keys(plugin.userConfig), ["SITESHOT_API_KEY"], "one value, nothing else asked for");

  assert.equal(cfg.type, "string");
  assert.equal(cfg.title, "Site-Shot API key");
  assert.equal(cfg.sensitive, true, "sensitive: the value is masked, not echoed back");
  assert.equal(cfg.required, true, "required: enabling without a key fails loudly");
  assert.match(cfg.description, /\bpaid\b/i, "the prompt states the API is paid before anyone types a key");
  assert.doesNotMatch(cfg.description, /\bfree (?:trial|tier|api key|key|plan)\b/i, "no free-API-trial claim");

  // Keys are managed in the dashboard. /start/ is the signup path and /pricing/ sells
  // plans; sending someone there to find an existing key is a dead end.
  assert.match(cfg.description, /https:\/\/www\.site-shot\.com\/dashboard\//, "key management link is the dashboard");
  assert.doesNotMatch(cfg.description, /site-shot\.com\/start\//, "not the signup path");

  // A default would be a key someone shipped, and a fallback would quietly capture
  // against the wrong account rather than stopping.
  assert.equal(cfg.default, undefined, "no default value");
  assert.equal(cfg.options, undefined, "not an enum");
});

test("the API key is forwarded as a placeholder, never embedded", () => {
  const server = mcp.mcpServers["site-shot"];
  assert.deepEqual(Object.keys(server.env), ["SITESHOT_API_KEY"], "only the documented secret");
  assert.equal(
    server.env.SITESHOT_API_KEY,
    "${user_config.SITESHOT_API_KEY}",
    "documented user_config substitution, so the key never has to be pasted into a config file",
  );

  // Belt and braces: scan every shipped plugin file for anything key-shaped that is
  // not an interpolation placeholder.
  for (const file of filesUnder(pluginDir)) {
    const body = read(file);
    for (const [, value] of body.matchAll(/SITESHOT_API_KEY["'\s:=]+([A-Za-z0-9_\-]{8,})/g)) {
      assert.fail(`${file} looks like it embeds a key: ${value.slice(0, 12)}…`);
    }
  }
});

test("the plugin ships only the files it declares — no hooks, no executables", () => {
  const shipped = filesUnder(pluginDir);
  assert.deepEqual(
    shipped,
    [
      `${pluginDir}/.claude-plugin/plugin.json`,
      `${pluginDir}/.mcp.json`,
      `${pluginDir}/skills/website-screenshots/SKILL.md`,
    ],
    "plugin contents are exactly the manifest, the MCP config and one skill",
  );

  // Hooks, bin/ and monitors run code on the user's machine on Claude Code's schedule
  // rather than on an explicit tool call. This plugin is not approved to do that.
  const allowedKeys = new Set([
    "name", "displayName", "version", "description",
    "author", "homepage", "repository", "license", "keywords", "userConfig",
  ]);
  for (const key of Object.keys(plugin)) {
    assert.ok(allowedKeys.has(key), `plugin.json must not declare "${key}"`);
  }
  for (const key of ["hooks", "bin", "agents", "commands", "workflows", "channels", "experimental"]) {
    assert.equal(plugin[key], undefined, `no ${key} in plugin.json`);
  }
  assert.equal(plugin.name, "site-shot");
  assert.equal(plugin.version, pkg.version, "plugin version tracks the package it installs");

  // The mcpb bundle and the marketplace are different distribution channels; shipping
  // Claude Code manifests inside the Claude Desktop bundle just bloats it.
  const mcpbignore = read(".mcpbignore").split("\n").map((l) => l.trim());
  assert.ok(mcpbignore.includes("plugins"), ".mcpbignore excludes plugins/");
  assert.ok(mcpbignore.includes(".claude-plugin"), ".mcpbignore excludes .claude-plugin/");
});

test("the skill only names tools and params the server actually serves", async () => {
  const skillPath = `${pluginDir}/skills/website-screenshots/SKILL.md`;
  const skill = read(skillPath);

  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(fm, "SKILL.md starts with YAML frontmatter");
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1].trim();
  const description = /^description:\s*(.+)$/m.exec(fm[1])?.[1].trim();
  assert.equal(name, "website-screenshots", "frontmatter name matches the skill directory");
  assert.ok(description && description.length > 40, "skill carries a description that can trigger it");

  const tools = await servedTools();
  const toolNames = tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ["capture_full_page", "capture_screenshot"], "the two real tools");
  const known = new Set(toolNames);
  for (const t of tools) for (const p of Object.keys(t.inputSchema?.properties ?? {})) known.add(p);

  // Any backticked snake_case token in the skill is an identifier an agent will try to
  // use. Tokens without an underscore (npx, png) are prose, not API surface.
  const cited = new Set();
  for (const [, token] of skill.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) cited.add(token);
  assert.ok(cited.size > 0, "the skill actually names the tools it tells agents to call");
  for (const token of cited) {
    assert.ok(known.has(token), `SKILL.md cites "${token}", which the server does not serve`);
  }
  for (const toolName of toolNames) {
    assert.ok(cited.has(toolName), `SKILL.md never mentions the ${toolName} tool`);
  }

  // Tool families this server has never had. An agent told to "save to the library"
  // burns a turn discovering there is no such tool.
  assert.doesNotMatch(
    skill,
    /\b(?:list|save|delete|search|schedule)_[a-z_]*(?:screenshot|capture|page)\w*\b|\b(?:screenshot|capture)_(?:library|history|schedule|markdown|list)\b/i,
    "no invented tool families (no saved library, list, markdown or schedule tools)",
  );
});

test("the skill states the paid requirement and claims nothing it cannot do", () => {
  const skill = read(`${pluginDir}/skills/website-screenshots/SKILL.md`);

  assert.match(skill, /SITESHOT_API_KEY/, "names the variable the user has to set");
  assert.match(skill, /\bpaid\b/i, "says the key is paid before the first call");
  assert.doesNotMatch(skill, /\bfree (?:trial|tier|api key|key|plan)\b/i, "no free-API-trial claim");

  // Point at the command the installer itself names, not at an enable-time prompt nobody
  // has observed. And the skill must not carry the direct-stdio tool-error behaviour over
  // to the plugin path — what Claude Code does with a required setting unset is untested.
  assert.ok(
    skill.includes(`/plugin configure ${entry.name}@${marketplace.name}`),
    "the skill points at the real configure command",
  );
  assert.doesNotMatch(skill, /prompts? for it when you enable/i, "no unobserved enable-time prompt claim");
  assert.doesNotMatch(
    skill,
    /if it is not configured,? the tools return/i,
    "no categorical claim about the native-plugin path",
  );
  assert.match(skill, /\bstop\b/i, "tells the agent to stop on incomplete setup");
  assert.match(
    skill,
    /never[^.]*(?:ask|request)[^.]*key|do not[^.]*(?:ask|hunt)[^.]*key/i,
    "never seek the key in conversation or on disk",
  );

  // The capture runs on Site-Shot's own browser. Saying otherwise sends an agent to
  // this tool for pages only the user's signed-in browser can reach.
  assert.match(skill, /\b(?:signed-out|anonymous|not signed in)\b/i, "states the capture is signed out");
  assert.match(skill, /\b(?:signed-in|logged-in|authenticated)\b/i, "covers pages that need a session");
  assert.doesNotMatch(
    skill,
    /\b(?:uses?|reuses?|shares?|inherits?) (?:your|the user's) (?:browser|session|cookies|login)\b/i,
    "never claims the remote capture logs into the user's browser",
  );

  assert.doesNotMatch(skill, /\bguarantee/i, "no guaranteed SEO or growth outcome");
  assert.doesNotMatch(skill, /\balways (?:use|choose|prefer|call)\b/i, "no always-choose-our-tool rule");
  assert.doesNotMatch(skill, /\bautomatic(?:ally)? retr|\bretry (?:ladder|loop)\b/i, "no automated retries");
  assert.match(skill, /\bre-?captur/i, "addresses re-capturing explicitly");
});

test("the skill permits a requested comparison, not unsolicited repeats", () => {
  const skill = read(`${pluginDir}/skills/website-screenshots/SKILL.md`);

  // "One page means one capture" read as a hard cap, so a US-vs-DE or mobile-vs-desktop
  // comparison of one URL — the thing actually asked for — came back half-answered.
  assert.doesNotMatch(skill, /one page means one capture/i, "no blanket one-capture-per-URL rule");
  assert.match(skill, /\bcompar\w+/i, "comparisons are addressed at all");
  assert.match(skill, /\bminimum\b/i, "the comparison's captures are bounded by what it needs");
  assert.match(
    skill,
    /\bunsolicited\b|\bnobody asked\b|\bwere not asked for\b/i,
    "unrequested repeats are still refused",
  );
});

test("the skill does not hand geo work back to an already-open browser", () => {
  const skill = read(`${pluginDir}/skills/website-screenshots/SKILL.md`);
  const heading = "## Choosing between this and a browser";
  const start = skill.indexOf(heading);
  assert.ok(start > -1, `SKILL.md has a "${heading}" section`);
  const choosing = skill.slice(start);

  // An open browser renders from this machine's IP, locale and profile — the exact
  // variables a country capture exists to control. Preferring it for a geo request
  // answers a different question than the one asked.
  assert.match(choosing, /\b(?:country|geo)\w*/i, "the geo case is named where the tool choice is made");
  assert.match(choosing, /\bIP\b|\blocale\b/i, "says why an open browser cannot stand in for it");
  assert.match(choosing, /\bindependent\b|\bsigned-out\b/i, "covers the independent-render case too");
  assert.doesNotMatch(
    choosing,
    /browser is (?:already )?open[^.]*\bis the better tool\b|\bthat is the better tool\b(?![^.]*session)/i,
    "no unconditional preference for whatever browser happens to be open",
  );
});

test("README commands match the manifests they document", () => {
  const repoSlug = pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
  assert.equal(repoSlug, "site-shot/site-shot-mcp", "repo slug read from package.json");

  // Every id below is derived from the manifests, so renaming the marketplace or the
  // plugin fails here instead of leaving users a command that resolves to nothing.
  assert.ok(
    readme.includes(`claude plugin marketplace add ${repoSlug}`),
    "README documents the marketplace add command with the real repo slug",
  );
  assert.ok(
    readme.includes(`${entry.name}@${marketplace.name}`),
    "README installs <plugin>@<marketplace> exactly as the manifests name them",
  );
  // --plugin-dir resolves against the session's cwd, and the one cwd that cannot work is
  // this repo: it *is* the site-shot-mcp package, so npx resolves the name locally, finds
  // no linked bin, and the server exits 127 with "command not found" before the handshake.
  const pluginDirArg = /claude --plugin-dir (\S+)/.exec(readme)?.[1];
  assert.ok(pluginDirArg, "README shows how to test the plugin before publication");
  assert.ok(pluginDirArg.startsWith("/"), `--plugin-dir example must be absolute, got "${pluginDirArg}"`);
  assert.ok(
    readme.includes(`site-shot-mcp@${pkg.version}`),
    "README quotes the same pinned version the plugin runs",
  );

  // The marketplace commands only resolve once these manifests are on the public
  // default branch. Printing them without that caveat reads as "already published".
  const marketplaceSection = readme.slice(readme.indexOf("claude plugin marketplace add"));
  assert.match(
    marketplaceSection.slice(0, 1200),
    /\b(?:after|once)\b[^.]*\b(?:published|public|default branch|merged)\b/i,
    "README says the marketplace commands need the manifests published first",
  );

  assert.ok(readme.includes("[mcp_servers.site-shot]"), "README documents the Codex TOML table");
  assert.ok(
    readme.includes('env_vars = ["SITESHOT_API_KEY"]'),
    "Codex instructions forward the key instead of writing it into config.toml",
  );

  // Claude Code collects the key itself through required sensitive userConfig. Telling
  // users to export it anyway would send a credential somewhere nothing reads it from.
  const claudeCodeSection = section("## Claude Code");
  assert.match(
    claudeCodeSection,
    /prompts you for\s+(?:it|the key|your [^.]{0,40}key)\b/i,
    "README says Claude Code prompts for the key",
  );
  assert.doesNotMatch(
    claudeCodeSection,
    /export SITESHOT_API_KEY|"SITESHOT_API_KEY":\s*"YOUR/i,
    "the Claude Code path never asks the user to paste or export the key",
  );
  assert.match(
    claudeCodeSection,
    /\bnot from this\s+checkout\b/i,
    "local testing warns against running from the MCP source checkout",
  );
  assert.match(
    claudeCodeSection,
    /command not found/,
    "README names the observed failure so it is recognisable when hit",
  );

  // Where Claude Code puts a sensitive value is its business and varies by platform.
  assert.doesNotMatch(readme, /\bkeychain\b/i, "no claim about which OS credential store is used");

  // The masked prompt is the only credential route this documents. A --config flag would
  // put the key in argv and shell history, and offering it as an "or" makes that the
  // convenient option precisely for the people least likely to weigh the tradeoff.
  assert.ok(
    claudeCodeSection.includes(`/plugin configure ${entry.name}@${marketplace.name}`),
    "README gives the configure command the installer actually points at",
  );
  assert.doesNotMatch(claudeCodeSection, /--config\b/, "no command-line flag route for the key");
  assert.doesNotMatch(claudeCodeSection, /SITESHOT_API_KEY\s*=/, "the key is never shown on a command line");

  // Claude Desktop is an existing, documented integration; the plugin work must not
  // quietly drop it.
  assert.match(readme, /claude_desktop_config\.json/, "Claude Desktop setup is preserved");
});

test("README describes what the plugin runs, and what a missing key really does", () => {
  const claudeCodeSection = section("## Claude Code");

  // "No background jobs, nothing else runs" was vaguer than the manifest. Name the
  // component types that are absent, and the one process that is not.
  assert.doesNotMatch(claudeCodeSection, /no background jobs/i, "say which components, not a vague sweep");
  assert.match(claudeCodeSection, /no hooks/i, "hooks named");
  assert.match(claudeCodeSection, /\bmonitors?\b/i, "monitors named");
  assert.match(claudeCodeSection, /scheduled[^.]*\bjobs?\b/i, "scheduled capture jobs named");
  assert.match(claudeCodeSection, /stdio MCP server/i, "names the one process the plugin does launch");

  // Two separate layers, and only one of them has been exercised. The isolated
  // install/list run never started a model session, so whether Claude Code launches the
  // server or offers the tools with a required setting unset is simply unknown here.
  // The missing-key tool error is a fact about the stdio server, observed directly;
  // carrying it over to the plugin path would be inventing the untested half.
  assert.doesNotMatch(
    readme,
    /\b(?:server|plugin)[^.]{0,40}(?:will not|won't|refuses to|does not) start\b/i,
    "no invented startup guarantee",
  );
  assert.doesNotMatch(
    readme,
    /missing key (?:therefore )?surfaces as a failed tool call/i,
    "no categorical claim about the untested native-plugin path",
  );
  assert.match(
    claudeCodeSection,
    /configure[^.]*before[^.]*captur|captur[^.]*requires?[^.]*configur/i,
    "captures through the plugin require the native setting to be configured",
  );
  assert.match(readme, /\bdirectly over stdio\b/i, "the missing-key tool error is attributed to direct stdio use");
  assert.match(readme, /tools? return[^.]*error/i, "says what a missing key produces on that path");
});

test("README is honest about where this is and is not distributed", () => {
  // The stdio package genuinely is on npm and in the MCP Registry — understating that
  // is as wrong as overstating the rest.
  assert.match(readme, /\bMCP Registry\b/, "names the registry that does list this package");

  // Name the two routes that actually need a hosted endpoint. "Public directories
  // require HTTPS" would be false: the MCP Registry lists this stdio package today.
  assert.match(readme, /not listed[\s\S]{0,200}?\bdirectory\b/i, "states plainly that those listings do not exist");
  assert.match(readme, /hosted HTTPS/i, "names what those routes require");
  assert.doesNotMatch(
    readme,
    /https:\/\/mcp\.site-shot\.com|\bremote (?:mcp )?(?:endpoint|server) (?:is|at) (?:live|available)\b/i,
    "no remote MCP endpoint is advertised",
  );
  assert.doesNotMatch(readme, /\b(?:app|client)[_ ]?id\b/i, "no invented registered application id");

  // Codex has a portable plugin format; this repo just does not ship one yet.
  const codex = section("## Codex CLI");
  assert.match(codex, /does not ship a Codex plugin/i, "manual stdio setup, not a wrapper we pretend to have");
  assert.match(codex, /codex mcp add/, "gives the CLI command that was actually verified");
});

test("copy does not imply per-capture charges or promise every page", () => {
  const copy = [readme, JSON.stringify(marketplace), JSON.stringify(plugin), read(`${pluginDir}/skills/website-screenshots/SKILL.md`)];
  for (const text of copy) {
    // A key draws on an account's existing API allowance; it is not a card charged per call,
    // and a failed capture is not automatically a paid one.
    assert.doesNotMatch(text, /\bbilled\b|\bcharged\b|\bper[- ]capture (?:charge|cost|fee)\b/i, "no per-invocation billing claim");
    assert.doesNotMatch(text, /\bany (?:public )?web page\b/i, "no promise to capture any page whatsoever");
  }
});
