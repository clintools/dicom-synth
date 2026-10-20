# Plan — dicom-synth maintainer documentation

## Understanding

Produce the definitive starting point for a maintainer of dicom-synth: code
structure, responsibilities, and flow/control — enough to locate bugs, judge
improvements, and answer questions confidently. The HLD (`architecture-hld.md`)
and overview (`architecture-overview.md`) supply the content basis; this doc set
goes deeper (control flow, data shapes, extension points) and is written for
someone editing the code, not consuming the package.

## Assumptions

- Lives in `docs/maintaining/` as tracked docs (linked from `docs/development.md`),
  since this is the durable handover — unlike the untracked HLD drafts.
- Mermaid diagrams inline (render on GitHub).
- Existing `docs/*.md` are user-facing and stay untouched except for one link.
- British English. No code changes.

## Affected Areas

New: `docs/maintaining/` (3 docs). Touched: `docs/development.md` (one link line).

## Proposed Plan

| Step | Change | Area | Reason | Checks |
|---:|---|---|---|---|
| 1 | `docs/maintaining/architecture.md` — module map with responsibility per file (all 19 src files + 3 bins + scripts), dependency diagram, the "one core, three exits" layer model, key design decisions (recipe-not-artifact validation, hash-derived UIDs, dcmjs boundary / `loadDcmjs` shim, 512 MB in-memory cap) | docs | Structure + what-is-responsible-for-what | proofread vs source |
| 2 | `docs/maintaining/control-flow.md` — sequence walkthroughs with mermaid: (a) spec → validate → planCollection → materialisePlan → generateFile → serialize; (b) writeCollectionFromSpec incl. path quirks + manifest; (c) large-image streaming path; (d) describe (walk → parse/header-only → group → emit spec); (e) parametric resolve; (f) CLI entry → API. Each names the functions and the data handed between them | docs | Flow & control perspective — the core ask | trace each flow in source while writing |
| 3 | `docs/maintaining/data-and-extension.md` — data shapes at each stage (`DatasetSpec` → `FilePlan` → buffer → manifest) with invariants (determinism, UID keys, meta/dataset sync, even lengths); "how to change X" recipes: add a violation class, a modality preset, an entry field (allowlist), a path quirk, a transfer syntax; test map (which test file pins which behaviour) | docs | Turns understanding into safe modification | verify recipes against v2.0 allowlist code |
| 4 | Link the set from `docs/development.md`; decide fate of the two untracked root drafts (leave untracked or fold in) | docs | Discoverability | — |

## Acceptance Criteria

- A new maintainer can answer, from these docs alone: "what file owns X?",
  "what happens when I call Y?", "what do I touch to add Z?"
- Every function/file reference verified against current source (v2.0.0).
- No duplication of user-facing docs — link to schema-reference etc. instead.

## Checks to Run

| Check | Command | Purpose |
|---|---|---|
| Reference audit | grep each named symbol in src | no stale names |
| Mermaid validity | visual check of fenced blocks | diagrams render |

## Risks / Edge Cases

- `describe.ts` (1207 lines) and `validate.ts` (994) are the depth risk — the docs
  must summarise their internal phases without re-narrating every branch.
- Overlap with `architecture-hld.md`: the maintainer set supersedes it for depth;
  the HLD stays the Q&A crib. Flag if you'd rather merge them.

## Out of Scope

- dicom-curate test strategy (recommended: new session in that repo).
- Any code or user-facing doc change beyond one link.
- Release/publish docs (covered by `docs/releasing.md`).

## Recommended Next Command

Approve → `/implement`.
