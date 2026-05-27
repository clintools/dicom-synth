# Contributing

## Local setup

```bash
pnpm install
pnpm build
```

Build before running published CLI binaries (`bin/*.mjs` import from `dist/esm/`).

## Git hooks

Hooks run automatically via [Husky](https://typicode.github.io/husky/):

| Hook | When | What runs |
|------|------|-----------|
| **pre-commit** | Every commit | `lint-staged` (Biome + ESLint on staged files); `tsc --noEmit` if TypeScript or JSON is staged |
| **pre-push** | Every push | `pnpm check:errors`, `pnpm build`, `pnpm test` |

Reproduce manually:

```bash
pnpm hooks:pre-commit
pnpm hooks:pre-push
pnpm code:quality   # check:errors + typecheck + test
```

If hooks fail after clone, ensure scripts are executable:

```bash
chmod +x .husky/* scripts/hooks/*.sh
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, etc.) so semantic-release can version and publish.

## Releases

See [docs/releasing.md](docs/releasing.md).
