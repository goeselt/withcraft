# Contributing to Withcraft

## Design

| File                  | Responsibility                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`    | Provider registration, workflow index cache, Visual Studio Code lifecycle and commands.                 |
| `src/workflow.ts`     | Line-based workflow parsing; step, `uses:`, and `with:` input range extraction.                         |
| `src/uses.ts`         | Parsing `uses:` strings into typed references (remote, local, Docker, reusable).                        |
| `src/github.ts`       | GitHub API calls, ref resolution, tag and latest-version detection, metadata caching.                   |
| `src/local.ts`        | Local action metadata resolution from the workspace filesystem.                                         |
| `src/metadata.ts`     | YAML parsing and normalization of `action.yml` / `action.yaml`.                                         |
| `src/render.ts`       | Markdown string construction for hover and completion content.                                          |
| `src/cache.ts`        | TTL cache with LRU eviction and in-flight request deduplication.                                        |
| `src/token.ts`        | Environment token lookup; scoped to `github.com` only to prevent workspace-driven leakage.              |
| `src/log.ts`          | Structured output-channel logger with level filtering and automatic token redaction.                    |
| `esbuild.mjs`         | Bundle script that compiles TypeScript sources to `out/extension.js`.                                   |
| `src/package.test.ts` | Validates `package.json` consistency: untrusted workspace configuration and pinned dependency versions. |

Network and caching logic lives in `src/github.ts` (remote) and `src/local.ts` (workspace). All Markdown construction is
isolated in `src/render.ts`. Visual Studio Code provider dispatch and lifecycle belong in `src/extension.ts`.

Each source file has a companion `*.test.ts` that runs under Vitest. Tests must not touch the network, the filesystem
(except via `tmp` directories cleaned up in `finally`), or Visual Studio Code APIs. The `vscode` module is not available
in the test environment; keep anything that imports it inside `src/extension.ts`.

## Development Setup

- Node.js 25
- npm

```bash
npm ci
npm run build
```

Use the **Run Extension** launch configuration (`F5`) to open an Extension Development Host with Withcraft loaded and
all other extensions disabled.

## Local Verification

Lint:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

Typecheck, test, and build:

```bash
npm run verify
```

Package

```bash
npm run package
```

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). The release
pipeline uses the PR title to determine the next version.
