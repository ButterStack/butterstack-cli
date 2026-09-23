# butterstack-cli

A fast, scriptable command line interface for [ButterStack](https://www.butterstack.com), a game development pipeline platform: Perforce, CI/CD builds, asset approvals, and task tracking, from your terminal.

It ships as a single file with zero runtime dependencies, using only Node.js builtins (`http`, `https`, `crypto`, `fs`, `path`, `os`, `child_process`).

## Install

```
npm install -g butterstack-cli
```

This installs a `butter` executable on your PATH.

## Authenticate

```
butter auth login
```

This opens your browser to a one-click authorization page, then stores a token locally at `~/.config/butterstack/credentials.json` (file mode `0600`, readable only by you).

Check who you are logged in as, and how much runway is left on the token:

```
butter auth whoami
```

Tokens expire 90 days after issue. Run `butter auth login` again to renew.

Log out and remove the stored credential:

```
butter auth logout
```

### Requesting less than the full permission set

By default, `butter auth login` requests the full CLI scope set. If you only need read access, for example for a CI credential, request less:

```
butter auth login --scope read-only
```

You can also pass a raw comma or space separated permission list instead of a named preset:

```
butter auth login --scope read:projects,read:builds
```

## Commands

### Projects

```
butter projects list [--json]
```

### Tasks

```
butter tasks list --project <id> [--state <state>] [--type <type>] [--priority <priority>] [--assignee <handle>] [--limit <n>] [--json]
butter tasks create "<title>" --project <id> [--type <type>] [--priority <priority>] [--description <text>] [--assignee <handle>]
```

### Builds

```
butter builds list --project <id> [--status <status>] [--type <type>] [--limit <n>] [--json]
butter builds investigate <build_id> --project <id> [--json]
```

`builds investigate` triggers an AI failure investigation on a build run and prints the diagnosis and suggested fix.

### Assets

```
butter assets list --project <id> [--pending] [--type <type>] [--limit <n>] [--json]
butter assets approve <asset_id> --project <id> [--comment <text>]
butter assets deny <asset_id> --project <id> [--reason <text>]
```

### MCP (AI clients)

The ButterStack MCP server (`npx -y butterstack-mcp`) uses the credential `butter auth login` stores, so log in first. Then write the MCP entry into your AI client's config:

```
butter mcp install [--opencode] [--claude] [--cursor] [--dry-run]
```

With no client flag, every installed client is configured. A client flag limits the install to that client and creates its config file if it does not exist yet. Each client gets the entry in its own schema, which matters because they differ: a Claude-style entry in an OpenCode config stops OpenCode from starting.

| Flag | Client | Config file | Entry |
|---|---|---|---|
| `--opencode` | OpenCode | `~/.config/opencode/opencode.jsonc` (or `opencode.json`) | `mcp.butterstack` with `type: "local"`, `command: ["npx", "-y", "butterstack-mcp"]`, `enabled: true` |
| `--claude` | Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json` | `mcpServers.butterstack` with `command: "npx"`, `args: ["-y", "butterstack-mcp"]` |
| `--cursor` | Cursor | `~/.cursor/mcp.json` | same as Claude Desktop |

Re-running is safe. Only the `butterstack` entry is ever written; every other key and server is left as it was, and an entry that is already correct is not rewritten. A config file that contains comments is never rewritten, because that would delete the comments; the command prints the entry to paste and the file to paste it into instead. `--dry-run` shows what would change without writing anything.

Claude Code registers MCP servers itself:

```
claude mcp add butterstack -- npx -y butterstack-mcp
```

See the [MCP guide](https://butterstack.com/docs/guides/mcp) for other clients.

## Global options

| Flag | Description |
|---|---|
| `--project <id>` | Target project ID |
| `--host <url>` | ButterStack API host (default: `https://www.butterstack.com`) |
| `--token <token>` | Explicit API token override for a single command |
| `--json` | Output machine-readable JSON instead of formatted text |
| `--help`, `-h` | Show help |

## Pointing the CLI at a different host

By default the CLI talks to `https://www.butterstack.com`. To target a self-hosted or local instance, use `--host` or the `BUTTERSTACK_HOST` environment variable:

```
butter projects list --host http://localhost:3000
# or
export BUTTERSTACK_HOST=http://localhost:3000
butter projects list
```

`butter auth login` persists whichever host you logged in with as your new default, so a later invocation without `--host` still targets the account that token belongs to.

As a safety property, a stored credential is only ever sent to the host it was minted for. If you run a command with `--host` (or `BUTTERSTACK_HOST`) pointed somewhere other than where you last logged in, the CLI refuses to send that request rather than silently attaching the wrong credential to the wrong host. An explicit `--token` override, or the `BUTTERSTACK_API_TOKEN` environment variable, bypasses this check, since that's an explicit choice by the caller rather than an ambiguous default.

## Scripting

Every command supports `--json` for machine-readable output. You can also skip the interactive login and provide a token directly, which is useful in CI:

```
export BUTTERSTACK_API_TOKEN=your-token-here
butter projects list --json
```

## Requirements

Node.js 18 or later.

## Releases

Publishing is tag-driven, not merge-driven: merging to `main` publishes nothing. To cut a release, bump `version` in `package.json`, commit that, then tag the commit `vX.Y.Z` to match and push the tag. The tag push runs the test suite, publishes to npm with provenance, and cuts the matching GitHub Release with generated notes.

```
git commit -am "Bump version to 0.2.0"
git tag v0.2.0
git push origin main --tags
```

## License

MIT. See [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
