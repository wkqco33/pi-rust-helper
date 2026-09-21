import { defineAdapter } from 'pi-helper-core';
import {
  cargoCheckCommand,
  cargoTestCommand,
  type RustCheckInput,
  type RustTestInput,
} from './commands.ts';
import { diagnoseRustFailure } from './failure.ts';
import { readProjectModel, type RustProjectModel } from './metadata.ts';
import { parseTestOutput } from './output.ts';
import { CARGO_RISK_RULES } from './risk.ts';
import { RUST_SELECTION_SIGNALS, RUST_TDD_SIGNALS, rustTestDirectories } from './selection.ts';
import { inspectToolchain } from './toolchain.ts';

/**
 * The Rust side of the shared `EcosystemAdapter` seam.
 *
 * The tools call the richer Rust functions directly when they need detail (an
 * error code, the full workspace model). The adapter exists so the core's
 * generic pieces — test selection, validation summary, risk classification —
 * can be driven without knowing about cargo.
 */
export const rustAdapter = defineAdapter({
  id: 'rust',
  riskRules: CARGO_RISK_RULES,
  selectionSignals: RUST_SELECTION_SIGNALS,
  tddSignals: RUST_TDD_SIGNALS,

  async resolveToolchain(ctx) {
    return (await inspectToolchain(ctx)).toolchain;
  },

  async readProjectModel(ctx) {
    const result = await readProjectModel(ctx);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.model;
  },

  testCommand(input: RustTestInput, ctx) {
    return cargoTestCommand(input, ctx);
  },

  checkCommand(input: RustCheckInput, ctx) {
    return cargoCheckCommand(input, ctx);
  },

  parseTestOutput(stdout, stderr) {
    return parseTestOutput(stdout, stderr);
  },

  diagnoseFailure(output, model) {
    return diagnoseRustFailure(output, { projectRoot: model?.root });
  },

  /**
   * Rust has no derived artifact worth an mtime comparison: cargo's `target/`
   * fingerprints are content-based and invalidate themselves. The execution
   * scope check (`ranTargets`, missing members) is what plays that role instead.
   */
  derivedArtifacts() {
    return [];
  },

  testDirectories(model) {
    return rustTestDirectories(model as RustProjectModel);
  },
});
