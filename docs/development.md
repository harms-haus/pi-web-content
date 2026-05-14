# Development

## Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| Node.js | 20+ | Runtime for the pi agent and extension loading |
| npm | bundled with Node | Package management |
| git | any | Required for repository URL functionality |
| pi coding agent | latest | Host runtime that loads the extension |

## Setup

```bash
git clone https://github.com/harms-haus/pi-web-content.git
cd pi-web-content
npm install
```

No build step is required. The extension is loaded directly from `src/index.ts` via the `"pi.extensions"` field in `package.json`, with TypeScript compiled on the fly by the pi runtime.

## Development Workflow

### No Build Step

```bash
npm run build
# Output: nothing to build
```

TypeScript is loaded directly by the pi runtime. The `build` script is a placeholder that echoes `nothing to build`.

### Type Checking

```bash
npm run typecheck
# Runs: tsc --noEmit
```

Validates all TypeScript files under `src/` against `tsconfig.json` without emitting output. Uses strict mode.

### Linting

```bash
npm run lint       # Reports issues only
npm run check      # Reports issues + auto-fixable suggestions
```

Both run Biome against `src/`. `check` is stricter — it includes formatting violations and suggests auto-fixes.

### Formatting

```bash
npm run format
# Runs: npx biome format --write src/
```

Formats all source files in-place according to `biome.json` rules (2-space indent, double quotes, always semicolons, 120-char line width).

### Testing

```bash
npm run test
# Runs: npx vitest run
```

Executes all `src/**/*.test.ts` files with Vitest. No watcher mode is configured — tests run once and exit.

### Running All Checks

```bash
npm run typecheck && npm run check && npm run test
```

Run this before committing to ensure type safety, lint compliance, and test correctness.

## Project Configuration

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

| Setting | Value | Effect |
|---------|-------|--------|
| `target` | `ES2022` | Generates code for modern Node.js (20+) — supports top-level `await`, `.at()`, `Object.hasOwn`, etc. |
| `module` / `moduleResolution` | `NodeNext` | ESM with Node.js resolution rules (`.js` extensions required in imports) |
| `strict` | `true` | Enables all strict type checks (`noImplicitAny`, `strictNullChecks`, etc.) |
| `noEmit` | `true` | No `.js` output — files are consumed directly by the pi runtime |
| `esModuleInterop` | `true` | Allows default imports from CommonJS modules (`import TurndownService from "turndown"`) |
| `skipLibCheck` | `true` | Skips type checking of `.d.ts` files in `node_modules` |

### vitest.config.ts

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
```

- **`globals: true`** — Vitest globals (`describe`, `it`, `expect`, `vi`, `beforeEach`, etc.) are available without explicit imports (though many tests import them explicitly for clarity).
- **`include`** — Matches `src/**/*.test.ts`, enforcing a 1:1 source-to-test mapping convention.

### biome.json

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.4/schema.json",
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "complexity": {
        "noForEach": "warn",
        "useSimplifiedLogicExpression": "warn"
      },
      "style": {
        "useTemplate": "error",
        "noParameterAssign": "off",
        "useConst": "error"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      }
    }
  },
  "overrides": [
    {
      "includes": ["src/index.ts"],
      "linter": {
        "rules": {
          "suspicious": { "noControlCharactersInRegex": "off" }
        }
      }
    }
  ]
}
```

| Rule | Level | Description |
|------|-------|-------------|
| `complexity.noForEach` | warn | Prefer `for...of` loops over `.forEach()` (performance, early-exit) |
| `complexity.useSimplifiedLogicExpression` | warn | Prefer `a ?? b` over `a || b` for nullish coalescing |
| `style.useTemplate` | error | Require template literals over string concatenation |
| `style.noParameterAssign` | off | Allows reassigning function parameters |
| `style.useConst` | error | Require `const` when a variable is never reassigned |
| `suspicious.noExplicitAny` | warn | Discourages `any` type — prefer specific types or `unknown` |

Two separate mechanisms handle lint warnings in `src/index.ts`. The `overrides` section disables `noControlCharactersInRegex` for that file due to regex-related patterns in the source. The `noExplicitAny` warning on the `registerTool` type cast (`as any`) is suppressed via an inline `// biome-ignore lint/suspicious/noExplicitAny` comment directly in the code, not by the biome.json override.

## Test Patterns

### 1:1 Source-to-Test Mapping

Each source module has a corresponding test file under `src/__tests__/`:

| Source | Test |
|--------|------|
| `fetch-content.ts` | `fetch-content.test.ts` |
| `detect-repo-url.ts` | `detect-repo-url.test.ts` |
| `ssrf.ts` | `ssrf.test.ts` |
| `subagent.ts` | `subagent.test.ts` |
| `html-to-markdown.ts` | `html-to-markdown.test.ts` |
| `summarize.ts` | `summarize.test.ts` |
| `parse-repo-url.ts` | `parse-repo-url.test.ts` |
| `tool-renderers.ts` | `tool-renderers.test.ts` |

### Mock Ordering

Vitest requires `vi.mock()` calls to appear **before** imports of the mocked modules. The standard pattern is:

```ts
// --- Mocks (must be before imports) ---

vi.mock("../ssrf.js", () => ({
  validateUrlForSsrf: vi.fn().mockResolvedValue(undefined),
  validateRedirectForSsrf: vi.fn().mockResolvedValue(undefined),
}));

// ... more mocks ...

// Import after mocks are set up
import { createFetchContentTool } from "../fetch-content.js";
import * as ssrf from "../ssrf.js";
```

### vi.hoisted() for Cross-Hoist Dependencies

When a mock factory needs a reference that is also hoisted (e.g., `spawn`), use `vi.hoisted()`:

```ts
const { spawn: mockSpawn } = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));
```

### Factory Helpers

Tests define local factory functions for creating test fixtures:

- **`createMockResponse()`** (fetch-content.test.ts) — Constructs a `Response` object with configurable `status`, `statusText`, `url`, `contentType`, `body`, and `headers`. Encodes the body into a `ReadableStream`.
- **`createMockProcess()`** (subagent.test.ts) — Constructs an EventEmitter-based mock of a `child_process.spawn` return value, with `stdout`, `stderr`, `kill`, and `killed` properties.
- **`createMockTheme()`** (tool-renderers.test.ts) — A mock `Theme` object with `fg` and `bold` passthrough functions, used in render tests.
- **`createAssistantMessage()`** (subagent.test.ts) — Creates a `Message` object with the shape expected by the NDJSON parser.

### Mocking Globals

```ts
// Stub fetch globally
mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// In beforeEach:
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();  // For time-sensitive tests (e.g., SIGKILL delay)
});
```

### Test Categories by Module

**Pure function modules** (no mocks needed for core logic):
- `detect-repo-url.ts` — Direct function calls with various URL strings, verifying `isRepo`, `scheme`, and `sanitizedUrl` outputs.
- `ssrf.ts` — `isBlockedHostname` tested with `it.each()` over arrays of hostnames. DNS-based functions mock `node:dns/promises`.
- `parse-repo-url.ts` — Regex-based extraction with various URL formats.
- `tool-renderers.ts` — Pure string formatting with theme mocks.

**Heavy-mock integration modules** (extensive mocking):
- `fetch-content.ts` — Mocks `ssrf`, `html-to-markdown`, `summarize`, `tool-renderers`, `detect-repo-url`, `parse-repo-url`, `node:fs/promises`, and stubs `fetch` globally. Tests the full routing logic (web vs. repo), SSRF validation, content-type routing, size limits, redirect handling, and abort signals.
- `subagent.ts` — Mocks `node:child_process` and `node:fs`. Tests NDJSON parsing, chunked data handling, abort/kill sequences (with fake timers), stderr capping, and exit code behavior.

### Parameterized Tests with `it.each()`

Extensively used in `ssrf.test.ts` and `detect-repo-url.test.ts`:

```ts
it.each(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"])(
  'blocks exact match: "%s"',
  (hostname) => {
    expect(isBlockedHostname(hostname)).toBe(true);
  }
);
```

### Accessing Mocked Modules

After `vi.mock()`, access typed mock functions via `vi.mocked()`:

```ts
import * as ssrf from "../ssrf.js";

// In test:
vi.mocked(ssrf.validateUrlForSsrf).mockRejectedValueOnce(
  new Error("Blocked: cannot fetch internal/private addresses (localhost)."),
);
```

### Testing Async Stream Processing

The subagent tests simulate NDJSON stream events by emitting data on mock EventEmitters:

```ts
proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`));
proc.emit("close", 0);

const result = await resultPromise;
```

This pattern tests chunked delivery, missing trailing newlines, invalid JSON lines, and unknown event types.

## Adding a New Content-Type Handler

To add support for a new response content type (e.g., `text/xml`):

1. **Define the routing logic in `fetch-content.ts`** — Inside `createFetchContentTool()`, locate the content-type routing section in the `execute` method (after the binary content rejection check). Add a new branch:

   ```ts
   if (contentType.includes("application/xml")) {
     title = "XML Response";
     markdown = `# XML Response from ${finalUrl}\n\n\`\`\`xml\n${rawText}\n\`\`\``;
   }
   ```

2. **Add a test in `fetch-content.test.ts`** — Under the `content-type routing` describe block:

   ```ts
   it("handles XML responses", async () => {
     const tool = createTool();
     mockFetch.mockResolvedValueOnce(
       createMockResponse({
         contentType: "application/xml",
         body: '<?xml version="1.0"?><root><item>test</item></root>',
       }),
     );
     const result = await tool.execute(
       "call-1",
       { url: "https://example.com/data.xml" },
       undefined,
       undefined,
       createContext(),
     );
     expect(result.content[0].text).toContain("XML Response");
     expect(result.content[0].text).toContain('<?xml version="1.0"?>');
   });
   ```

3. **Run tests**: `npm run test`

4. **Verify types**: `npm run typecheck`

## Adding a New Git Host

To add support for a new git hosting platform (e.g., `gogs.example.com`):

1. **Add the hostname to `detect-repo-url.ts`** — Update `KNOWN_GIT_HOSTNAMES`:

   ```ts
   const KNOWN_GIT_HOSTNAMES = new Set([
     // ... existing hosts ...
     "gogs.example.com",
   ]);
   ```

   The generic owner/repo path detection (exactly 2 segments, or 3 segments checked against `NON_REPO_SEGMENTS` / `REPO_SUBPATHS`) will automatically handle standard `/{owner}/{repo}` paths.

2. **Add host-specific path detection** (if needed) — If the host uses a non-standard URL structure, add a dedicated handler block before the generic owner/repo check:

   ```ts
   // Custom host: /org/{owner}/{repo}
   if (hostname === "gogs.example.com") {
     if (segments.length >= 3 && segments[0] === "org") {
       return { isRepo: true, scheme: "https", sanitizedUrl };
     }
     return { isRepo: false, scheme: "https", sanitizedUrl };
   }
   ```

3. **Add tests in `detect-repo-url.test.ts`** — Add a new describe block:

   ```ts
   describe("Gogs URLs", () => {
     it("detects bare /org/owner/repo as repo", () => {
       const result = isRepoUrl("https://gogs.example.com/org/owner/repo");
       expect(result.isRepo).toBe(true);
     });

     it("detects homepage as web", () => {
       const result = isRepoUrl("https://gogs.example.com/");
       expect(result.isRepo).toBe(false);
     });
   });
   ```

4. **Verify `parseRepoUrl()` handles the URL format** — The existing regex patterns in `parse-repo-url.ts` handle generic `https://host/owner/repo` URLs, so no changes are needed for standard paths. Test with a `parse-repo-url.test.ts` entry if the URL format is unusual.

5. **Run all checks**: `npm run typecheck && npm run check && npm run test`

## Code Style Conventions

| Convention | Rule | Example |
|------------|------|---------|
| **Indentation** | 2 spaces | `function foo() {\n  return bar;\n}` |
| **Quotes** | Double quotes | `const x = "hello";` |
| **Semicolons** | Always required | `const x = 5;` |
| **Line width** | 120 characters | Wrap long lines before 120 chars |
| **Template literals** | Required over concatenation | `` `Hello ${name}` `` not `'Hello ' + name` |
| **`const` over `let`** | Enforced | Use `const` unless reassignment is needed |
| **`for...of` over `.forEach()`** | Preferred | `for (const item of items)` not `items.forEach(...)` |
| **Named exports** | Default export only for extension entry | `export function isRepoUrl()` — only `index.ts` uses `export default` |
| **Return types** | Explicit on all exported functions | `export function foo(): string { ... }` |
| **JSDoc** | Required on all exported functions and interfaces | `/** Description */` block before declarations |
| **File extensions in imports** | Required `.js` extension | `import { foo } from "./bar.js"` (even for `.ts` sources) |
| **Nullish coalescing** | `??` over `||` for null checks | `value ?? defaultValue` not `value \|\| defaultValue` |

### Extension Entry Point Convention

Only `src/index.ts` uses a default export. It is the extension factory function:

```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool(createFetchContentTool(pi) as any);
}
```

All other modules use named exports only.

### Biome Ignore Comments

Use `// biome-ignore <rule>: <reason>` comments sparingly and only when a rule cannot be satisfied correctly. See `src/index.ts` for an example (type cast on `registerTool`).

---

**Related documentation:**
- [Architecture](./architecture.md) — Module structure, data flows, and dependency graph
- [Security](./security.md) — SSRF threat model, input sanitization, and defense-in-depth measures
