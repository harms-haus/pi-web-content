# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Windows CI support (ubuntu-latest + windows-latest matrix)
- `.gitattributes` for line ending normalization
- Windows reserved device name blocking (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
- `%` character to URL allowlist for percent-encoded URLs
- Dedicated unit tests for `execute-repo-fetch.ts` and `execute-web-fetch.ts`
- `fetch-constants.test.ts` for constant validation
- Cross-platform test path handling (`os.tmpdir()` instead of hardcoded `/tmp`)
- **SSRF**: SSH URL validation — hostname blocklist + DNS resolution check (was a bypass vector)
- **Security**: Branch name validation — rejects dangerous characters in `--branch` to prevent git injection
- **Security**: Git error messages sanitized — raw stderr never exposed to callers
- **Performance**: JSDOM and Readability lazy-loaded via dynamic `import()` (~7.5 MB saved at startup)
- **Performance**: Binary content-type check moved before full body read
- **Performance**: Redirect response bodies cancelled immediately (no wasted reads)
- **CI**: Added `ci.yml` (Node 20 + 22 matrix) and `publish.yml` (dry-run on tag push)
- **Package**: Publish-ready — removed `private`, added `main`, `files`, `publishConfig`, `description`, `license`, `engines`

### Changed
- **BREAKING**: DNS resolution now fails-closed (throws on complete DNS failure instead of silently allowing)
- DNS queries now run in parallel via `Promise.allSettled` for reduced latency
- `BINARY_TYPES` moved from `html-to-markdown.ts` to `fetch-constants.ts`
- `FetchContentDetails` and `SummarizeUpdate` extracted to shared `src/types.ts`
- User-Agent string is now platform-agnostic (removed `(X11; Linux x86_64)`)
- Subagent abort handling is platform-aware (SIGTERM→SIGKILL on Unix, `proc.kill()` on Windows)
- Subagent invocation uses `shell: true` on Windows to resolve `.cmd` wrappers
- `fs.rm` error handling now propagates real errors (only catches ENOTEMPTY)
- Split `fetch-content.test.ts` (1854 lines) into focused web and repo test files
- Credential stripping logic consolidated into single `stripCredentials` function
- **Monolith split**: `fetch-content.ts` split into 4 focused modules (`fetch-content.ts`, `fetch-constants.ts`, `execute-repo-fetch.ts`, `execute-web-fetch.ts`) for clearer separation of concerns
- **Linting**: Migrated from Biome to ESLint + Prettier for consistency with the broader pi ecosystem
- **Code quality**: Unified credential stripping via the URL API (replaces manual regex)
- **Code quality**: Unified SSRF validation core — single source of truth for hostname/DNS checks
- **Code quality**: Consistent `os.tmpdir()` usage across all modules
- **Code quality**: Removed dead exports, added `import type` where appropriate
- **Docs**: Updated all documentation for new module structure

### Removed
- Removed dead code: unreachable error branch in git clone failure message
- Removed duplicated credential-stripping logic from `sanitize-git-url.ts`
- Removed duplicated `onUpdate` type cast from both fetch executor files

### Fixed
- **SSRF**: `fe80::/10` IPv6 link-local detection was incomplete — now correctly matches the full /10 range

### Tests
- Test count: 331 → 415 (+84 new tests)
- New test coverage for `sanitize-git-url`, branch validation, SSH SSRF, redirect loops, and more
- Coverage thresholds enforced at 90% (actual: 97% statements, 92% branches)

## [1.0.0] - 2025-XX-XX

<!-- TODO: Replace XX-XX with actual release date -->

### Added
- `fetch_content` tool: unified web content fetcher and git repository cloner
- Auto-detection of git repository URLs across 8 hosting platforms (GitHub, GitLab, Bitbucket, Codeberg, Gitea, Gitee, SourceHut, Azure DevOps)
- HTML to Markdown conversion using Mozilla Readability + Turndown with GFM support
- SSRF protection: hostname blocklist, DNS resolution validation, private IP detection (IPv4/IPv6), redirect validation
- Git URL sanitization against command injection
- Optional content summarization via pi subagent
- Streaming response reading with 10 MB size limit
- TUI rendering with Theme support
- Comprehensive test suite (8 test files covering all modules)
