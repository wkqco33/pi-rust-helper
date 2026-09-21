/**
 * Local shim over the shared core envelope.
 *
 * The Rust tools import `result`/`failure` and the shared types from here, so
 * the envelope stays defined in exactly one place (`pi-helper-core`) while the
 * call sites do not need to know that.
 */
import { createResultFactory } from 'pi-helper-core';
import { TOOL_VERSION } from './version.ts';

export const { result, failure } = createResultFactory(TOOL_VERSION);

export { CORE_SCHEMA_VERSION, isActionable, note, warn } from 'pi-helper-core';

export type {
  CommandPreview,
  CommandRisk,
  Diagnostic,
  Evidence,
  Severity,
  Suggestion,
  ToolResult,
  ToolchainInfo,
} from 'pi-helper-core';
