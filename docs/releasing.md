# Releasing dicom-synth

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/) on pushes to `main`.

## Prerequisites (one-time)

1. npm org access for the package name (`dicom-synth` or `@clintools/dicom-synth`).
2. GitHub **release** environment with permissions for `GITHUB_TOKEN` (see [.github/workflows/release.yml](../.github/workflows/release.yml)).
3. npm trusted publishing / OIDC configured for your org

## Normal release flow

1. Merge pull requests to `main` using conventional commit messages.
2. The **Release** workflow runs: typecheck, Biome (`check:errors`), test, build, then `semantic-release`.
3. semantic-release bumps `package.json`, writes `CHANGELOG.md`, publishes to npm, and creates a GitHub release.

## Verify after publish

```bash
pnpm add dicom-synth@latest dcmjs
node -e "import('dicom-synth').then(m => console.log(typeof m.generateCollectionFromSpec))"
npx dicom-synth-generate --schema-inline '{"entries":[{"type":"valid-image"}]}' --out ./out
npx dicom-synth-fetch pydicom-CT-small
```

## Dry run locally

```bash
pnpm build
pnpm code:quality
npx semantic-release --dry-run
```
