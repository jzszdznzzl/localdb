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
   - `fix(api): handle empty query`
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
