import type { RiskRule } from 'pi-helper-core';

/**
 * Cargo and rustup risk rules.
 *
 * The universal rules in the core already cover `git`, file deletion, and
 * `curl | sh`. These add only what is specific to the Rust toolchain, and the
 * classification is used for the helper's own commands rather than for shell
 * strings from the caller.
 */
export const CARGO_RISK_RULES: RiskRule[] = [
  // Irreversible: the change cannot be reverted by editing the workspace.
  {
    risk: 'irreversible',
    pattern: /\bcargo\s+(?:publish|yank|owner|login|logout)\b/,
    reason: 'Publishing or changing registry ownership cannot be undone locally.',
  },
  {
    risk: 'irreversible',
    pattern: /\bcargo\s+(?:add|remove|install|uninstall|clean)\b/,
    reason: 'Editing the manifest, installing, or deleting target/ is not a source revert.',
  },
  {
    risk: 'irreversible',
    pattern: /\brustup\s+(?:self\s+uninstall|toolchain\s+uninstall)\b/,
    reason: 'Removing a toolchain is not recoverable without a download.',
  },

  // Mutating: recoverable, but changes the workspace, lockfile, or toolchain.
  {
    risk: 'mutating',
    pattern: /\bcargo\s+(?:build|run|fetch|update|fix|generate-lockfile|vendor|package)\b/,
    reason: 'Writes build artifacts, the lockfile, or fetched sources.',
  },
  {
    risk: 'mutating',
    pattern: /\brustup\s+(?:toolchain\s+install|update|component|target|default|override)\b/,
    reason: 'Changes the installed toolchain set.',
  },
];

/**
 * Commands that look mutating in the rule table but compile without changing
 * anything the caller has to review. Kept explicit so `cargo test --no-run`
 * does not get treated as a build.
 */
export const CARGO_SAFE_OVERRIDES: RegExp[] = [
  /\bcargo\s+(?:metadata|tree|pkgid|verify-project)\b/,
  /\bcargo\s+(?:check|test|clippy)\b/,
  /\bcargo\s+(?:build|run)\b[^;&|]*--dry-run\b/,
];
