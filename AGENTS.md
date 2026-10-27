# Project Guidelines

Shared rules for everyone who writes code in this project, human or AI. Most rules include the reason behind them, so you can apply them sensibly in cases this document doesn't cover.

Human workflow (setup, branches, pull requests) lives in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## 1. Stack

| Area            | Choice                                                |
| --------------- | ----------------------------------------------------- |
| Package manager | pnpm ≥ 12 (preferred over npm, yarn and bun install)  |
| Runtime         | Node.js ≥ 24 (the published package also runs on Bun) |
| Language        | TypeScript ≥ 7 (preferred over JavaScript)            |
| Modules         | ESM (preferred over CommonJS)                         |
| Linter          | oxlint (latest, preferred over ESLint)                |
| Formatter       | Prettier (latest)                                     |
| Build           | tsdown — `tsc` is used only for typechecking          |
| Validation      | zod ≥ 4                                               |

### Versions are enforced in `package.json`

Writing versions in this document is not enough; they must be enforced by the tooling:

```json
{
  "type": "module",
  "packageManager": "pnpm@12.14.0",
  "engines": {
    "node": ">=24",
    "pnpm": ">=12"
  }
}
```

Pin `packageManager` to the exact pnpm version the project uses.

### Required scripts

Every project must define these scripts so humans, CI and AI assistants run the same checks:

| Script      | Purpose                   |
| ----------- | ------------------------- |
| `lint`      | `oxlint`                  |
| `format`    | `prettier --write .`      |
| `typecheck` | `tsc --noEmit`            |
| `build`     | `tsdown`                  |
| `test`      | The project's test runner |

### Mandatory configuration files

**`.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true
```

**`.prettierrc`**

```json
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always",
  "bracketSpacing": true,
  "endOfLine": "lf",
  "singleAttributePerLine": false
}
```

**`.oxlintrc.json`**

Enforces the type-safety and control-flow rules from section 3. `@ts-expect-error` is allowed only in tests, with a description.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "rules": {
    "curly": ["error", "all"],
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/ban-ts-comment": [
      "error",
      { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": true }
    ]
  },
  "overrides": [
    {
      "files": ["**/__tests__/**"],
      "rules": {
        "typescript/ban-ts-comment": [
          "error",
          { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": "allow-with-description" }
        ]
      }
    }
  ]
}
```

If the installed oxlint version supports type-aware linting, also enable `typescript/no-floating-promises`.

**`tsconfig.json`**

The first block is mandatory in every project. The second block shows typical values and may be adjusted per project.

```jsonc
{
  "compilerOptions": {
    // --- Mandatory: module safety ---
    // Every file must compile in isolation, as tsdown, Node.js and Bun process them that way.
    "moduleDetection": "force",
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    // Only syntax that can be stripped is allowed. This forbids `enum`, `namespace` and
    // constructor parameter properties, so those rules are enforced by the compiler.
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,

    // --- Mandatory: strictness ---
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    // --- Project-dependent: adjust per project ---
    "target": "ESNext",
    "lib": ["ESNext"],
    "types": ["node"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "noEmit": true, // tsdown emits the output; tsc only typechecks.
  },
}
```

---

## 2. Project Structure

### Size

- **Small project:** a script or tool that fits in one readable file or a few. Use a simple monolith (`index.ts` or `main.ts`, `config.ts`, `utils.ts`). Do not split it into many files preemptively.
- **In between:** start small. Split a file when it becomes hard to navigate or mixes unrelated responsibilities.

### Naming

All files and folders use `kebab-case`: `user-service.ts`, `game-engine/`.

Why: macOS and Windows file systems are case-insensitive, so renaming `userService.ts` to `UserService.ts` breaks git history and imports on other machines. All-lowercase names avoid the problem entirely.

### Tests

Tests live in a `__tests__` folder next to the code they test, named `<file-name>.test.ts`:

```
src/users/
├── user-service.ts
└── __tests__/
    └── user-service.test.ts
```

---

## 3. Coding Standards

### Naming

| Kind                       | Case                   | Example        |
| -------------------------- | ---------------------- | -------------- |
| Variables, functions       | `camelCase`            | `getUser`      |
| Types, interfaces, classes | `PascalCase`           | `UserProfile`  |
| Enum objects, zod schemas  | `PascalCase`           | `Role`, `User` |
| Fixed configuration values | `SCREAMING_SNAKE_CASE` | `MAX_RETRIES`  |

- **Booleans** are prefixed with `is`, `has`, `can` or `should`: `isActive`, not `active`.
- **Single-letter names** are allowed only in simple callbacks (`users.some((u) => u.isAdmin)`) and basic math (`add(a, b)`).
- **Do not mix** short and long names in the same block; it makes the code harder to scan.

### Domain values (no magic strings)

Values that represent domain concepts (statuses, roles, database codes, error codes) are never written as raw literals. They go in a frozen object with a derived type of the same name:

```ts
export const Role = Object.freeze({
  Admin: 'admin',
  Mod: 'mod',
  User: 'user',
} as const);

export type Role = (typeof Role)[keyof typeof Role];
```

Why: there is a single source of truth, so if a database value changes, it changes in one place.

Why not `enum`: enums generate runtime code (Node.js cannot strip them) and string enums are nominal, so a plain `'admin'` coming from a database or API is rejected without a cast. `Object.freeze` adds runtime immutability; `as const` alone is acceptable in internal application code.

This rule does **not** apply to self-evident values such as `0`, `1`, `-1`, `''` or array indexes. Configuration numbers (timeouts, limits, ports) go in `SCREAMING_SNAKE_CASE` constants or environment variables.

### Validation with zod

- Schemas are `PascalCase`, and their inferred type uses the same name.
- Validate at the boundaries: HTTP input, database rows, environment variables and external API responses. Inside the application, trust the types.
- Reuse domain objects instead of duplicating values: `z.enum(Role)`.
- When a JSON Schema is needed, generate it with `z.toJSONSchema(Schema)` instead of writing it by hand.

```ts
import { z } from 'zod';

import { Role } from './role';

export const User = z.object({
  id: z.string(),
  name: z.string().min(1),
  role: z.enum(Role),
});

export type User = z.infer<typeof User>;
```

### Type safety

Types are only useful if they are true. The constructs below tell the compiler "trust me", which turns a compile-time error into a runtime crash. They are restricted:

- **`as` is forbidden**, except `as const`. To check that a value matches a type without forcing it, use `satisfies`. In tests, `as` is allowed only to build partial mocks.
- **`any` is forbidden.** Use `unknown` and narrow it with a schema, `typeof`, `instanceof` or `in`.
- **External data is validated before use.** Anything coming from `JSON.parse`, `response.json()`, request bodies, database drivers, `process.env` or third-party APIs is `unknown` until it passes a zod schema.
- **Nullable values are checked, not asserted.** If something can be `null` or `undefined`, handle that case explicitly.
- **`!` only when existence is already guaranteed** and TypeScript cannot infer it. Rewrite the code without `!` whenever possible. Otherwise, disable the lint rule on that line and explain why it is safe.
- **No homemade type guards for external data.** A function returning `value is User` that does not fully validate is a hidden `as`; use `User.safeParse()` instead. Type guards are fine for internal unions, such as checking a discriminant field.
- **`@ts-ignore` and `@ts-nocheck` are forbidden.** `@ts-expect-error` is allowed only in tests, with a description.
- **No floating promises.** Every promise is awaited, returned, or ends in `.catch()`. Why: an unhandled rejection can crash the Node.js process.

```ts
// Forbidden: compiles, but crashes at runtime as soon as the file is edited by hand.
const user = JSON.parse(line) as User;

// Required: the shape is verified before the value is used.
const parsed = User.safeParse(JSON.parse(line));

if (!parsed.success) {
  return { data: null, error: DbError.InvalidFile };
}

const user = parsed.data;
```

```ts
if (cache.has(key)) {
  // Safe: `has` guarantees the entry exists, but Map.get does not narrow its type.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  return cache.get(key)!;
}
```

### Error handling

Expected failures are returned; unexpected failures are thrown.

- **Return a `Result`** when the failure is part of the normal flow: an illegal move in a game engine, a search with no results, failed validation, an external API answering with an error. The caller is forced by the type system to handle it.
- **Throw** for things the caller cannot reasonably recover from: bugs, broken invariants, missing configuration at startup.

Every project uses the same shared type:

```ts
export type Result<T, E = string> = { data: T; error: null } | { data: null; error: E };
```

The error type is usually a domain object, so callers can branch on it safely:

```ts
export const MoveError = Object.freeze({
  OutOfBounds: 'out_of_bounds',
  OccupiedSquare: 'occupied_square',
} as const);

export type MoveError = (typeof MoveError)[keyof typeof MoveError];
```

### Control flow

Every `if`, `else`, loop and `case` uses braces, even for a single line.

Why: every block looks the same, so the code is easier to scan, and adding a second line never silently changes the logic. In `switch`, braces also give each `case` its own scope, so `const` declarations in different cases do not collide.

```ts
if (!player) {
  return;
}

switch (move.type) {
  case MoveType.Attack: {
    const damage = calculateDamage(move);
    applyDamage(player, damage);
    break;
  }
  case MoveType.Defend: {
    raiseShield(player);
    break;
  }
  default: {
    break;
  }
}
```

### Comments and documentation

- Code should be self-explanatory. Comments explain **why** a decision was made, never **what** the code does.
- JSDoc is required only for complex functions or critical values.

---

## 4. File Structure & Ordering

Every TypeScript/JavaScript file follows this order, so any file can be navigated the same way:

1. External imports (values, then types)
2. Internal imports (values, then types)
3. Non-exported types and interfaces
4. Exported types and interfaces
5. Non-exported domain objects and zod schemas
6. Exported domain objects and zod schemas
7. Non-exported constants (`SCREAMING_SNAKE_CASE`, then `camelCase`)
8. Exported constants (`SCREAMING_SNAKE_CASE`, then `camelCase`)
9. Non-exported functions (arrow functions, then function declarations)
10. Exported functions (arrow functions, then function declarations)
11. Non-exported classes
12. Exported classes

Two exceptions to keep related code together and avoid runtime errors:

- A type derived from a value (`typeof Role`, `z.infer<typeof User>`) goes **immediately after** that value, not in sections 3–4.
- A schema that uses another schema goes after it, because values must be defined before they are used at runtime.

```ts
import { z } from 'zod';
import type { Stats } from 'node:fs';

import { Role } from './role';
import type { Session } from './session';

export const User = z.object({
  id: z.string(),
  role: z.enum(Role),
});

export type User = z.infer<typeof User>;

export const MAX_USERS_PER_PAGE = 50;

export function describeUpload(stats: Stats, session: Session) {
  return `${session.userId} uploaded ${stats.size} bytes`;
}
```

---

## 5. Class Structure

- Use native private fields (`#field`) instead of TypeScript's `private`/`protected`. Why: `#` is enforced at runtime; `private` disappears after compilation.
- Use a getter over a `#` field instead of `readonly`. Why: the value is truly read-only at runtime, not only in the type checker.
- Do not declare fields as constructor parameters (`constructor(public name: string)`). This is enforced by `erasableSyntaxOnly`.

Members are ordered as follows:

1. Private fields (`#field`)
2. Private arrow functions (`#fn = () => {}`)
3. Public fields
4. Public arrow functions
5. Static private fields and arrow functions
6. Static public fields and arrow functions
7. Constructor
8. Private methods
9. Getters
10. Setters (omit them when the value must be read-only)
11. Public methods
12. Static methods

```ts
export class Player {
  #score = 0;

  name: string;

  constructor(name: string) {
    this.name = name;
  }

  get score() {
    return this.#score;
  }

  addPoints(points: number) {
    this.#score += points;
  }
}
```

---

## 6. Git

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `docs:`.

Full workflow in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## 7. Security

- Never hardcode secrets (API keys, passwords, tokens). Use environment variables.

---

## 8. Rules for AI Assistants

AI assistants (Claude, Copilot, ChatGPT, Gemini and others) follow every section above, plus these rules:

1. **Verify before finishing.** Run `pnpm lint`, `pnpm typecheck` and `pnpm test`, and fix any failure your change introduced. If you cannot run them, say so explicitly.
2. **Never silence the type checker.** Do not use `as`, `!`, `any` or `@ts-` comments to make `typecheck` or `lint` pass. Fix the actual type problem, or ask if you cannot.
3. **Complete code in chat.** When you show code in a chat response, show the complete function, object or block. Never use placeholders such as `// rest of the code` or `// existing code...`. Why: the code is pasted directly into files, and a placeholder silently deletes real code.
4. **Minimal edits in files.** When you edit files directly, change only what the task requires. Do not rewrite, reorder or reformat unrelated code.
5. **Follow the guidelines over the surroundings.** If existing code contradicts this document, write new code following this document and mention the inconsistency. Do not refactor the old code unless asked.
6. **Do not invent.** Do not assume APIs, package options or versions; check the installed package or its documentation. If you lack context to complete a task safely, ask instead of guessing.

---

## 9. Adapting These Documents to the Project

`AGENTS.md`, `CONTRIBUTING.md` and `README.md` start as templates that cover several setups. When an AI assistant initializes or sets up a project, it must trim them so they describe **only** this project.

Why: rules that do not apply are noise, and they lead humans and AI to follow the wrong setup.

### What to remove

- **Node.js-only projects:** everything about Bun (Bun runtime, Elysia, `"types": ["bun"]`, the `bun` engine).
- **Bun-only projects:** everything specific to Node.js (Fastify, `"types": ["node"]`, the `node` engine).
- **No HTTP API:** the "HTTP APIs" subsection and any API examples.
- **No environment variables:** the `.env` setup step, `.env.example`, and environment validation.
- **Small projects:** guidance for large projects (domain folders, monorepos, branch prefixes).
- **Anything else** that does not apply, following the same criterion.

### How to do it

- **Remove, do not reword.** Rules that still apply stay exactly as written.
- **Make generic values concrete:** replace "Node.js ≥ 24 or Bun" with the runtime actually used, and the example pnpm version with the real one.
- **Adjust examples** that use a removed technology, so they match the project's stack.
- **Leave no dangling references:** check links, section numbers and mentions of removed content.
- **Ask when unsure.** If it is not clear whether something applies (for example, whether an API is planned), ask the developer instead of removing it.
- **Keep this section**, so the documents can be adapted again if the project changes.
