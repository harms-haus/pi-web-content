# Contributing to pi-web-content

Thank you for your interest in contributing! This guide covers how to set up the project, code requirements, testing conventions, and the pull request process.

## How to Contribute

1. **Fork** the repository on GitHub.
2. **Create a feature branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
3. **Make your changes** with corresponding tests. See [Testing Requirements](#testing-requirements) below.
4. **Run all checks** before committing:
   ```bash
   npm run typecheck && npm run lint && npm run test
   ```
   All three must pass with no errors.
5. **Commit** with a clear, descriptive message.
6. **Push** your branch and **open a Pull Request** against the `main` branch.

## Code Requirements

- **Tests for all new code.** Every new source module must have a corresponding test file. See [Testing Requirements](#testing-requirements).
- **All tests must pass.** No exceptions — `npm run test` must succeed.
- **No ESLint errors.** Run `npm run lint`. Warnings are acceptable if justified with a comment, but errors block CI.
- **TypeScript strict mode.** The project uses `"strict": true` in `tsconfig.json`. Use of `any` requires a `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>` comment.
- **JSDoc comments on all exported functions.** Every function, interface, and type exported from a module must have a JSDoc block describing its purpose, parameters, and return value.
- **Formatting.** Use `npm run format` (Prettier) to keep code style consistent. The formatter is configured for 2-space indentation, 100-char line width, and double quotes.

## Testing Requirements

Tests live in `src/__tests__/` with a `{module-name}.test.ts` naming convention, providing a 1:1 source-to-test mapping.

### New Modules

Every new source module in `src/` must have a corresponding test file in `src/__tests__/`:

| Source File | Test File |
|-------------|-----------|
| `src/foo.ts` | `src/__tests__/foo.test.ts` |

### Integration Changes

Changes to the `fetch_content` tool's orchestration logic (routing between web fetch and git clone, SSRF validation flow, summarization delegation) must add test cases to `src/__tests__/fetch-content.test.ts`.

### Bug Fixes

Every bug fix must include a **regression test** — a test case that would have caught the bug before the fix was applied.

### Test Patterns and Conventions

See [docs/development.md — Test Patterns](./docs/development.md#test-patterns) for detailed test patterns and conventions. In brief:

- **Framework:** Vitest with globals enabled (`describe`, `it`, `expect`, `vi`).
- **Imports:** Import modules using the `.js` extension (e.g., `import { fn } from "../module.js"`).
- **Mocking:** Use `vi.mock()` at the top of the file to mock dependencies. Access mocked functions via `vi.mocked()`.
- **Structure:** Group related tests with nested `describe()` blocks. Use `it.each()` for parameterized tests.
- **Setup/teardown:** Use `beforeEach()` to clear mocks and `afterEach()` to restore them.

Example:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { myFunction } from "../my-module.js";

vi.mock("../dependency.js", () => ({
  helper: vi.fn(),
}));

import { helper } from "../dependency.js";

const mockedHelper = vi.mocked(helper);

describe("myFunction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns expected result", () => {
    mockedHelper.mockReturnValue("stub");
    expect(myFunction("input")).toBe("expected");
  });
});
```

## Pull Request Process

- **PR title** should clearly describe the change (e.g., `fix: handle redirect loops in SSRF validation`).
- **PR description** must reference related issues (e.g., `Fixes #12`).
- **All CI checks must pass** — typecheck, ESLint, and tests.
- **CHANGELOG.md** — add a summary of your changes under the `Unreleased` section. If no `Unreleased` section exists, create one at the top. Use the format:
  ```markdown
  ## Unreleased

  - `fix:` brief description of the change
  ```
- A maintainer will review and merge your PR.

## Reporting Issues

Use [GitHub Issues](https://github.com/harms-haus/pi-web-content/issues) to report bugs, request features, or ask questions.

When reporting a bug, include:

- **pi version** (`pi --version`)
- **Node.js version** (`node --version`)
- **Operating system** and version
- **Steps to reproduce** the issue
- **Expected behavior** vs **actual behavior**
- Any relevant error output or logs

### Security Issues

For security vulnerabilities, refer to [docs/security.md](./docs/security.md). If possible, report security issues privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability). Do not open a public issue for security-sensitive problems.

## License

By contributing to this project, you agree that your contributions will be licensed under the [MIT License](./LICENSE), matching the project's existing license.
