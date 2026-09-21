# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-09-21

### Fixed

- A project named through `path` now runs cargo and git in the resolved project root instead of `ctx.cwd`. `cargo metadata` (project inspection and test selection), `cargo test`/`cargo check`/`cargo build` (through the command preview's `cwd`), the validation bundle, and the `git diff` discovery behind `rust_test`/`rust_tdd_checkpoint` previously ran in the session directory, which failed with "could not find `Cargo.toml`" or silently read the wrong tree.

### Added

- `rust_tdd_checkpoint` accepts an optional `path` for git discovery.

## [0.1.1] - 2026-09-21

### Fixed

- Strip ANSI escape sequences from cargo and rustc output before parsing. GitHub
  Actions sets `CARGO_TERM_COLOR=always`, which wrapped the `Running …` and
  `Doc-tests …` headers in colour escapes, so `includedDocTests` was reported as
  false and the false-green contract tests failed on CI while passing locally.

## [0.1.0] - 2026-09-21

### Added

- Initial `pi-rust-helper` extension: ten `rust_*` tools built on the shared
  `pi-helper-core` envelope, adapter, validation, and selection contracts. The
  core is consumed as the published `pi-helper-core@^0.1.1`, so CI installs from
  the registry with no sibling checkout.
- `src/rust/toolchain.ts`: toolchain discovery that reads `~/.rustup` instead of
  invoking rustup. rustup 1.29 auto-installs a toolchain named by
  `rust-toolchain.toml` even for `rustup toolchain list`, so the declared channel
  is compared against the installed directory names before `rustc` is run, and
  `TOOLCHAIN_NOT_INSTALLED` prevents an accidental download.
- `src/rust/metadata.ts`: the workspace model from
  `cargo metadata --format-version 1`. A lockfile is read with `--locked` and a
  missing lockfile with `--no-deps`, so reading the model never rewrites
  `Cargo.lock` and lockfile drift (`LOCKFILE_DRIFT`) is reported, not repaired.
- `src/rust/commands.ts` and `src/rust/risk.ts`: argument-array command builders
  and cargo/rustup risk rules. `cargo test` defaults to `--workspace` because a
  bare run only covers `default-members`.
- `src/rust/output.ts`: a libtest text parser that pairs the `Running …` headers
  on stderr with the result lines on stdout and reads `compiler-artifact` JSON
  records to report `ranTargets` and `testedPackages` authoritatively.
- `src/rust/failure.ts`: structured `compiler-message` diagnosis keyed by error
  code (E0432/E0433/E0463/E0599/E0277/E0061/E0412/…), with registry and toolchain
  frames classified as library locations.
- `src/rust/dependencies.ts`: an opt-in unused-dependency scan (`rust_project_inspect` with `scanUnusedDependencies=true`) with a bounded file/byte budget, ignoring `target/` and optional dependencies, and reporting an incomplete scan instead of a clean one when the budget is hit.
- `rust_test_select` `checkAllFeatures`: compiles the affected crates with `--all-features` and reports `FEATURE_COMPILATION_FAILED` when a change only builds under the default feature set.
- `rust_project_inspect` dependency summary: duplicate versions, registry/git/path source counts, and `DUPLICATE_DEPENDENCY_MAJOR` when majors disagree.
- Tools: `rust_environment`, `rust_project_inspect`, `rust_test`,
  `rust_test_select`, `rust_check`, `rust_failure_diagnose`, `rust_tdd_checkpoint`,
  `rust_build`, `rust_validation_bundle`, `rust_completion_evidence`.
- False-green detections: `ZERO_TESTS_RUN`, `DEFAULT_MEMBERS_ONLY`,
  `SCOPE_INCOMPLETE`, `DOCTESTS_SKIPPED`, `LOCKFILE_DRIFT`, `MSRV_UNSATISFIED`,
  `WORKSPACE_MEMBER_MISSING`, `TOOLCHAIN_NOT_INSTALLED`, `PREVIEW_ONLY`,
  `FEATURE_COMPILATION_FAILED`, `DUPLICATE_DEPENDENCY_MAJOR`, `UNUSED_DEPENDENCY`.
- Regression fixtures and tests that pin the behaviours the plan measured:
  a `default-members` workspace, a zero-test crate, a compile error, an MSRV
  above the installed toolchain, and an unused dependency.
- `npm run docs:check` verifies `docs/tools.md` against the registered tool
  schemas, and `npm run pack-check` verifies the published tarball contents.
