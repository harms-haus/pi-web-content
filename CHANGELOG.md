# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
