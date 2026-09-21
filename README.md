# pi-rust-helper

[Rust](https://www.rust-lang.org/) (cargo) development tools for the
[pi](https://github.com/earendil-works/pi) coding agent, built on the shared
[`pi-helper-core`](../pi-helper-core) contract.

The helper exists for one measured failure mode: **a green test run that did not
test the workspace**. On a workspace with `default-members`, a bare `cargo test`
reports success while skipping crates that the agent never saw. The same shape
recurs with a zero-test run (exit 0), `--tests` silently dropping doctests, and a
`rust-toolchain.toml` channel that makes rustup download a toolchain during a
"read-only" command. Every one of those is a first-class diagnostic here.

## Tools

| Tool | What it answers |
|---|---|
| `rust_environment` | Which toolchain would actually run (`rustc -vV`, cargo, rustup state, `rust-toolchain.toml`), and whether running cargo would trigger a download. |
| `rust_project_inspect` | The workspace model from `cargo metadata --offline`: members, `default-members`, editions, MSRV, targets, applied features, lockfile drift. |
| `rust_test` | Preview/run `cargo test` and report **what ran**: `ranTargets`, tested packages, doc-test inclusion, zero-test runs, uncovered members. |
| `rust_test_select` | Changed files → workspace crates through the reverse-dependency graph, so a focused `-p` run replaces the whole workspace. |
| `rust_check` | `cargo check --message-format=json` with structured diagnostics by error code and first project frame. |
| `rust_failure_diagnose` | Classify a rustc/cargo failure from JSON output, excluding registry and toolchain frames. |
| `rust_tdd_checkpoint` | Production changes without a related test change. |
| `rust_build` | Preview/confirm `cargo build` (mutating, explicit opt-in plus confirmation). |
| `rust_validation_bundle` | The completion gate: `cargo metadata --locked` → `cargo check` → `cargo test` → scope verification → declared quality gates. |
| `rust_completion_evidence` | Conservative completion report; a partial run is a blocker, not a warning. |

The full parameter schemas are generated into [`docs/tools.md`](./docs/tools.md)
and checked in CI.

## What it detects

| Code | Meaning |
|---|---|
| `ZERO_TESTS_RUN` | `cargo test` exited 0 without executing a test, so the result proves nothing. |
| `DEFAULT_MEMBERS_ONLY` | The run covered `default-members` only; members outside it were never built. |
| `SCOPE_INCOMPLETE` | A `--workspace` run did not produce a test binary for an expected member. |
| `DOCTESTS_SKIPPED` | No `Doc-tests` section was produced although members declare doctests. |
| `LOCKFILE_DRIFT` | `Cargo.lock` does not describe the manifests; the read did not rewrite it. |
| `MSRV_UNSATISFIED` | A member's `rust-version` is above the active toolchain. |
| `TOOLCHAIN_NOT_INSTALLED` | `rust-toolchain.toml` names an uninstalled channel; cargo would download it. |
| `TOOLCHAIN_FILE_MISMATCH` | A directory override or a missing rustup makes the declared channel ineffective. |
| `WORKSPACE_MEMBER_MISSING` | A `members` glob matched no package. |
| `PREVIEW_ONLY` | Nothing was executed, so the response is not evidence. |

## Install

```bash
pi install npm:pi-rust-helper
```

`pi-helper-core` is a dependency; while the two are developed side by side it is
resolved with `file:../pi-helper-core` and is pinned to a published version for
release.

## Development

```bash
npm install
npm test              # unit, tool, and fixture regression tests (cargo tests skip without Rust)
npm run typecheck
npm run check         # test + typecheck + format + docs + pack
npm run docs          # regenerate docs/tools.md
npm run test:e2e      # one end-to-end pass over a temporary workspace
```

Tests that need cargo skip explicitly when `rustc` is unavailable; they never
pass silently.

## Design notes

- **No manifest scanner.** `cargo metadata --format-version 1` is the authority,
  so there is no hand-written parser and no protocol version to keep in step.
- **Reading never mutates.** The model is read with `--locked` when a lockfile
  exists and `--no-deps` when it does not, so inspection cannot silently refresh
  `Cargo.lock`.
- **rustup is inspected, not invoked.** The declared channel is compared against
  `~/.rustup/toolchains` before any `rustc`/`cargo` process starts.
- **The core owns the envelope.** Tools return the `pi-helper-core` shape and
  never redefine `ok`/`attention`; `test/helpers/harness.ts` asserts that
  contract at the tool boundary.

## Release

Bump `package.json`, move the CHANGELOG entry, then push a `v<version>` tag. The
publish workflow verifies the tag matches the package version and publishes with
npm provenance. Note the same constraint as `pi-helper-core`: the **first**
publish of a new package cannot use trusted publishing and must be done once
manually, after which the trusted publisher is configured.

## License

Apache-2.0.
