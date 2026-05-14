# pi-web-content

A [pi](https://pi.dev) extension that adds a unified `fetch_content` tool for fetching web content and cloning git repositories directly into your agent's context. The tool auto-detects whether a URL is a web page or a git repository and handles it accordingly.

## Tools

### `fetch_content`

Fetch a URL — either a web page or a git repository — and bring its content into your agent's context. The tool automatically detects git repository URLs (GitHub, GitLab, Bitbucket, etc.) and clones them; all other URLs are fetched as web content and converted to clean markdown.

**Web content** uses Mozilla Readability to strip navigation, ads, and sidebars, then Turndown to convert to GitHub Flavored Markdown.

**Git repositories** are shallow-cloned (`--depth 1`) to `/tmp/repository-{owner}/{repo-name}` for exploration.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | ✅ | URL to fetch (web page or git repository) |
| `summarize` | string | ❌ | Directed prompt for summarization |
| `branch` | string | ❌ | Git branch to clone (only for repository URLs) |

When `summarize` is provided, a pi subagent processes the full content with your prompt and returns a summary instead — reducing context usage.

**Example LLM usage:**
- Web: "Read this article: https://example.com/blog/post" → full markdown
- Web summary: "Summarize https://example.com/docs/api" → summarized
- Repo: "Explore https://github.com/user/repo" → cloned to /tmp/repository-user/repo
- Repo summary: "Give me an overview of https://github.com/user/repo" → summarized analysis
- Specific branch: "Explore https://github.com/user/repo" with branch="develop" → cloned develop branch

## Install

### Via `pi install` (recommended)

```bash
pi install git:github.com/harms-haus/pi-web-content
```

### Via settings.json

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/harms-haus/pi-web-content"]
}
```

### Quick test without installing

```bash
pi -e git:github.com/harms-haus/pi-web-content
```

## Requirements

- [pi](https://pi.dev) coding agent
- [git](https://git-scm.com) (for repository URLs)
- Node.js 20+

## Security

This extension includes:
- **SSRF protection**: Blocks requests to internal/private IP addresses (localhost, 10.x, 192.168.x, 169.254.x, etc.)
- **Streaming size guard**: Rejects responses larger than 10 MB (enforced via streaming byte counting)
- **Path traversal protection**: Validates repository owner/names from URLs
- **Injection-resistant delimiters**: Uses unique tokens for content boundaries in subagent prompts
- **URL scheme validation**: Only HTTPS and SSH URLs for git clone; only HTTP(S) for web fetch

## Architecture

```
src/
├── index.ts              # Extension entry point
├── fetch-content.ts      # Unified tool: web content + git repos
├── detect-repo-url.ts    # Git repository URL detection
├── parse-repo-url.ts     # Git URL owner/repo extraction
├── subagent.ts           # Pi subprocess invocation
├── summarize.ts          # Shared summarization helper
├── ssrf.ts               # SSRF protection
├── html-to-markdown.ts   # HTML to Markdown conversion
└── tool-renderers.ts     # Shared TUI rendering helpers
```

Dependencies:
- [turndown](https://github.com/mixmark-io/turndown) + [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) — HTML to Markdown conversion with GFM support
- [@mozilla/readability](https://github.com/mozilla/readability) — Article content extraction (same engine as Firefox Reader View)
- [jsdom](https://github.com/jsdom/jsdom) — DOM implementation for Node.js

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | Module structure, data flows, dependency graph |
| [Security](docs/security.md) | SSRF protection layers, input sanitization, threat model |
| [Development](docs/development.md) | Build/test/lint workflows, test patterns, adding features |
| [Configuration](docs/configuration.md) | Configurable constants, truncation behavior, storage paths |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and solutions |
| [Contributing](CONTRIBUTING.md) | How to contribute, code requirements, PR process |
| [Changelog](CHANGELOG.md) | Version history |

## Troubleshooting

Common issues and their solutions are documented in [docs/troubleshooting.md](docs/troubleshooting.md), including:
- SSRF blocks and private IP resolution
- Binary content rejection
- Git clone failures
- Content size limits and timeouts
- Summarization errors

## Configuration

Key runtime constants and their defaults are documented in [docs/configuration.md](docs/configuration.md):
- Fetch timeout: 30 seconds
- Git clone timeout: 2 minutes
- Maximum response size: 10 MB
- Maximum redirects: 10
- Binary content types that are rejected
- Supported git hosting platforms (10 hostnames across 8 platforms)

## License

[MIT](LICENSE) — see the [LICENSE](LICENSE) file.
