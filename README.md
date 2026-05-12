# pi-web-content

A [pi](https://pi.dev) extension that adds tools for fetching web content and cloning git repositories directly into your agent's context.

## Tools

### `fetch-content`

Fetch a URL and convert its HTML content to clean markdown. Uses Mozilla Readability to strip navigation, ads, and sidebars, then Turndown to convert to GitHub Flavored Markdown.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | ✅ | URL to fetch |
| `summarize` | string | ❌ | Directed prompt for summarization (e.g., "find all references to bananas") |

When `summarize` is provided, a pi subagent processes the full content with your prompt and returns a summary instead of the full markdown — reducing context usage.

**Example LLM usage:**
- "Read this article: https://example.com/blog/post" → full markdown
- "Summarize the key points from https://example.com/docs/api" → summarized

### `fetch-repo`

Clone a git repository to `/tmp/repository-{owner}/{repo-name}` for exploration. Performs a shallow clone (`--depth 1`) for speed.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | ✅ | Git repository URL (HTTPS or SSH) |
| `summarize` | string | ❌ | Directed prompt for repo analysis |

When `summarize` is provided, a pi subagent explores the cloned repo using its full tool set (read, find, grep, etc.) and returns a summary. Otherwise, returns the local path to the cloned repository.

**Example LLM usage:**
- "Clone https://github.com/user/repo so I can explore it" → returns local path
- "Give me an overview of the architecture in https://github.com/user/repo" → summarized analysis

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
- [git](https://git-scm.com) (for `fetch-repo`)
- Node.js 20+

## Security

This extension includes:
- **SSRF protection**: Blocks requests to internal/private IP addresses (localhost, 10.x, 192.168.x, 169.254.x, etc.)
- **Content-Length guard**: Rejects responses larger than 10 MB
- **Path traversal protection**: Validates repository owner/names from URLs
- **Injection-resistant delimiters**: Uses unique tokens for content boundaries in subagent prompts
- **URL scheme validation**: Only HTTPS and SSH URLs for git clone; only HTTP(S) for web fetch

## Architecture

```
src/
├── index.ts          # Extension entry point
├── fetch-content.ts  # Web content → markdown tool
├── fetch-repo.ts     # Git repository cloning tool
└── subagent.ts       # Pi subprocess invocation for summarization
```

Dependencies:
- [turndown](https://github.com/mixmark-io/turndown) + [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) — HTML to Markdown conversion with GFM support
- [@mozilla/readability](https://github.com/mozilla/readability) — Article content extraction (same engine as Firefox Reader View)
- [jsdom](https://github.com/jsdom/jsdom) — DOM implementation for Node.js

## License

MIT
