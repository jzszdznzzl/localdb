# Contributing

This guide covers how to set up the project and get changes merged. The coding standards themselves live in [AGENTS.md](./AGENTS.md): it is the single source of truth for humans and AI assistants alike, and AI tools read it automatically.

---

## Requirements

- Node.js ≥ 24
- Bun (latest), only to run `pnpm test:bun`
- pnpm ≥ 12

## Setup

```bash
pnpm install
```

## Scripts

| Command          | What it does                            |
| ---------------- | --------------------------------------- |
| `pnpm lint`      | Runs oxlint                             |
| `pnpm format`    | Formats the code with Prettier          |
| `pnpm typecheck` | Typechecks with tsc (no output)         |
| `pnpm test`      | Runs the test suite                     |
| `pnpm test:bun`  | Runs the test suite under Bun           |
| `pnpm check`     | Format check, lint, typecheck and tests |
| `pnpm build`     | Builds the project with tsdown          |

---

## Workflow

1. **Create a branch** from the default branch.
2. **Commit** following [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add user search`
   - `fix(storage): ignore a torn last line`
   - `chore: update dependencies`
3. **Before opening a pull request**, make sure these pass:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm format`
4. **Open the pull request:**
   - Keep it small and focused on one purpose.
   - Explain what changed and why.
   - Link the related issue, if there is one.

---

## Working with AI assistants

AI assistants are welcome, with two conditions:

- **You are responsible for what you submit**, whoever wrote it. Review AI-generated code as carefully as your own and run the checks above.
- **Fix the rule, not just the code.** If an assistant keeps breaking a guideline, improve its wording or add the reason behind it in [AGENTS.md](./AGENTS.md), so the fix applies to every future session.

## Publishing

The `Publish to npm` workflow publishes stable GitHub releases using npm trusted publishing.
Before the first automated publish, configure a trusted publisher in the package settings on
[npm](https://www.npmjs.com/): owner `jzszdznzzl`, repository `localdb`, workflow
`publish.yml`, with direct publishing enabled. The package must already exist on npm; if it does
not, publish its first version manually with `npm publish` after running `pnpm install`,
`pnpm check` and `pnpm build`. Complete the first trusted publish within two days of configuring
it, or recreate the configuration.

For each release, update `version` in `package.json` and the changelog, commit the changes, and
publish a GitHub release with the matching tag (for example, `v2.0.0` for version `2.0.0`).
The workflow checks the tag, installs from the lockfile, runs the checks and builds before
publishing. Prereleases are not published by this workflow.
