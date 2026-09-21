import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FailureDiagnosis, FailureFrame, Suggestion } from 'pi-helper-core';
import { stripAnsi } from './ansi.ts';

/**
 * Rust failure diagnosis.
 *
 * `cargo check/clippy --message-format=json` emits a fully structured
 * `compiler-message` record with the error code, the primary span, and the child
 * notes, so the first project frame is found by reading fields rather than by
 * matching a traceback. The text fallback exists for output that was already
 * rendered as short/plain text.
 */

export interface DiagnoseOptions {
  projectRoot?: string;
  cargoHome?: string;
}

interface RawSpan {
  file_name?: string;
  line_start?: number;
  column_start?: number;
  is_primary?: boolean;
}

interface RawCompilerMessage {
  level?: string;
  message?: string;
  code?: { code?: string } | null;
  spans?: RawSpan[];
  children?: { level?: string; message?: string }[];
}

const CODE_KINDS: Record<string, string> = {
  E0432: 'unresolved_import',
  E0433: 'unresolved_import',
  E0463: 'missing_crate',
  E0583: 'missing_module',
  E0599: 'no_method',
  E0277: 'trait_bound',
  E0061: 'argument_count',
  E0412: 'unknown_type',
  E0308: 'type_mismatch',
  E0425: 'unknown_value',
  E0531: 'unknown_value',
  E0603: 'private_item',
  E0658: 'unstable_feature',
  E0554: 'nightly_only',
  E0405: 'unknown_trait',
};

export function isLibraryFrame(path: string, options: DiagnoseOptions = {}): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (options.projectRoot) {
    const root = options.projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === root || normalized.startsWith(`${root}/`)) return false;
  }
  // A relative span is always relative to the workspace root that cargo ran in.
  if (!normalized.startsWith('/')) return false;
  const cargoHome = (
    options.cargoHome ??
    process.env.CARGO_HOME ??
    join(homedir(), '.cargo')
  ).replace(/\\/g, '/');
  return (
    normalized.startsWith(`${cargoHome}/registry/`) ||
    normalized.startsWith(`${cargoHome}/git/`) ||
    // Match any Cargo home, so output produced on another machine is still
    // recognized as a library frame rather than blamed on the project.
    /(?:^|\/)\.cargo\/(?:registry|git)\//.test(normalized) ||
    normalized.includes('/rustup/toolchains/') ||
    normalized.includes('/lib/rustlib/') ||
    normalized.startsWith('/rustc/') ||
    /\/library\/(?:std|core|alloc|proc_macro|test)\//.test(normalized)
  );
}

function kindFor(code: string | undefined, message: string, children: string[]): string {
  const all = [message, ...children].join('\n');
  if (/could not find `?Cargo\.toml|failed to (?:load|parse) manifest/i.test(all)) {
    return 'manifest_error';
  }
  if (/no such command/i.test(all)) return 'missing_executable';
  if (/package ID specification .* did not match|no packages found/i.test(all)) {
    return 'unknown_package';
  }
  if (/linking with .* failed|undefined reference|cannot find -l/i.test(all)) return 'linker';
  if (/is gated behind|cfg\(feature|feature [`'"]|enable the .* feature/i.test(all)) {
    return 'feature_gated';
  }
  if (/assertion .* failed|panicked at|test failed/i.test(all)) return 'test_failure';
  if (/could not compile/i.test(all)) return 'compile_failed';
  if (code && CODE_KINDS[code]) return CODE_KINDS[code];
  return code ? 'compile_error' : 'unknown';
}

function extractMissingModule(message: string): string | undefined {
  const patterns = [
    /use of undeclared crate or module `([^`]+)`/,
    /unresolved import `([^`]+)`/,
    /can't find crate for `([^`]+)`/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

function suggestionsFor(
  kind: string,
  code: string | undefined,
  missingModule: string | undefined,
  missingExecutable: string | undefined,
  frame: FailureFrame | undefined,
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const location = frame ? ` at ${frame.path}:${frame.line}` : '';
  switch (kind) {
    case 'unresolved_import':
    case 'missing_crate':
    case 'missing_module':
      suggestions.push({
        message: missingModule
          ? `Add "${missingModule}" to [dependencies] in Cargo.toml, or fix the import path.`
          : 'Add the missing dependency to Cargo.toml, or fix the import path.',
        confidence: 'high',
        command: missingModule ? `cargo add ${missingModule}` : undefined,
      });
      break;
    case 'feature_gated':
      suggestions.push({
        message:
          'The item is behind a Cargo feature; confirm the feature exists and retry with --all-features to separate a feature gap from a real error.',
        confidence: 'high',
        command: 'cargo check --workspace --all-targets --all-features',
      });
      break;
    case 'trait_bound':
      suggestions.push({
        message: `A trait bound is not satisfied${location}. Import the trait, or add the missing bound to the generic parameter.`,
        confidence: 'medium',
      });
      break;
    case 'no_method':
      suggestions.push({
        message: `No method with that name is in scope${location}. Import the trait that provides it, or check the feature that adds it.`,
        confidence: 'medium',
      });
      break;
    case 'argument_count':
      suggestions.push({
        message: `The call passes the wrong number of arguments${location}. Compare it with the current signature.`,
        confidence: 'high',
      });
      break;
    case 'unknown_type':
      suggestions.push({
        message: `The type is not in scope${location}. Import it, or enable the feature that defines it.`,
        confidence: 'medium',
      });
      break;
    case 'type_mismatch':
      suggestions.push({
        message: `The value type does not match${location}.`,
        confidence: 'medium',
      });
      break;
    case 'linker':
      suggestions.push({
        message:
          'Linking failed, which is usually a missing system library or a build-script link directive.',
        confidence: 'medium',
      });
      break;
    case 'missing_executable':
      suggestions.push({
        message: missingExecutable
          ? `The "${missingExecutable}" subcommand is not installed.`
          : 'The requested cargo subcommand is not installed.',
        confidence: 'high',
        command: missingExecutable ? `cargo install --locked ${missingExecutable}` : undefined,
      });
      break;
    case 'manifest_error':
      suggestions.push({
        message: 'Cargo could not read the manifest; fix the syntax error it points at.',
        confidence: 'high',
      });
      break;
    case 'test_failure':
      suggestions.push({
        message: `A test failed${location}; inspect the assertion at that location.`,
        confidence: 'high',
      });
      break;
    default:
      suggestions.push({
        message: frame
          ? `Start at the first project frame${location}.`
          : 'No project frame was found; inspect the raw output.',
        confidence: 'low',
      });
  }
  if (code) {
    suggestions.push({
      message: `Run rustc --explain ${code} for the full explanation.`,
      confidence: 'low',
    });
  }
  return suggestions;
}

function framesFrom(
  spans: RawSpan[],
  options: DiagnoseOptions,
): { frames: FailureFrame[]; primary: boolean[] } {
  const frames: FailureFrame[] = [];
  const primary: boolean[] = [];
  for (const span of spans) {
    if (!span.file_name) continue;
    frames.push({
      path: span.file_name,
      line: span.line_start ?? 0,
      column: span.column_start,
      library: isLibraryFrame(span.file_name, options),
    });
    primary.push(span.is_primary === true);
  }
  return { frames, primary };
}

export interface RustDiagnostic {
  level: string;
  code?: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  library: boolean;
}

/** Structured `compiler-message` records from `--message-format=json`. */
export function parseCompilerDiagnostics(
  output: string,
  options: DiagnoseOptions = {},
): RustDiagnostic[] {
  const diagnostics: RustDiagnostic[] = [];
  for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let parsed: { reason?: string; message?: RawCompilerMessage };
    try {
      parsed = JSON.parse(line) as { reason?: string; message?: RawCompilerMessage };
    } catch {
      continue;
    }
    if (parsed.reason !== 'compiler-message' || !parsed.message) continue;
    const primary =
      parsed.message.spans?.find((span) => span.is_primary) ?? parsed.message.spans?.[0];
    diagnostics.push({
      level: parsed.message.level ?? 'unknown',
      code: parsed.message.code?.code,
      message: parsed.message.message ?? '',
      file: primary?.file_name,
      line: primary?.line_start,
      column: primary?.column_start,
      library: primary?.file_name ? isLibraryFrame(primary.file_name, options) : false,
    });
  }
  return diagnostics;
}

export function diagnoseRustFailure(
  output: string,
  options: DiagnoseOptions = {},
): FailureDiagnosis {
  // Colour escapes from `CARGO_TERM_COLOR=always` would break the text fallback.
  const clean = stripAnsi(output);
  const evidence: { message: string; file?: string; line?: number }[] = [];
  let code: string | undefined;
  let message = '';
  let spans: RawSpan[] = [];
  const children: string[] = [];

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let parsed: { reason?: string; message?: RawCompilerMessage };
    try {
      parsed = JSON.parse(line) as { reason?: string; message?: RawCompilerMessage };
    } catch {
      continue;
    }
    if (parsed.reason !== 'compiler-message' || !parsed.message) continue;
    if (parsed.message.level !== 'error') continue;
    code = parsed.message.code?.code;
    message = parsed.message.message ?? '';
    spans = parsed.message.spans ?? [];
    for (const child of parsed.message.children ?? []) {
      if (child.message) children.push(child.message);
    }
    break;
  }

  if (!message) {
    // Text fallback: short/plain rendering, or truncated output with no JSON.
    const header = clean.match(/^error(?:\[([A-Z]\d{4})\])?:\s*(.+)$/m);
    if (header) {
      code = header[1];
      message = header[2].trim();
    }
    const arrow = clean.match(/^\s*-->\s+([^\s:]+):(\d+):(\d+)/m);
    if (arrow)
      spans = [
        {
          file_name: arrow[1],
          line_start: Number(arrow[2]),
          column_start: Number(arrow[3]),
          is_primary: true,
        },
      ];
    for (const child of clean.matchAll(/^note:\s*(.+)$/gm)) children.push(child[1]);
  }

  if (!message) {
    return {
      kind: 'unknown',
      summary: 'The output did not contain a recognizable Rust error.',
      frames: [],
      evidence: [],
      suggestions: [
        {
          message: 'Re-run cargo check with --message-format=json to get a structured diagnostic.',
          confidence: 'medium',
          command: 'cargo check --workspace --all-targets --message-format=json',
        },
      ],
    };
  }

  const { frames, primary } = framesFrom(spans, options);
  const firstUserFrame =
    frames.find((frame, index) => !frame.library && primary[index]) ??
    frames.find((frame) => !frame.library);

  const missingModule = extractMissingModule(message);
  const missingExecutable = message.match(/no such command: `?([^`\s]+)/)?.[1];
  const kind = kindFor(code, message, children);

  evidence.push({ message });
  for (const child of children) evidence.push({ message: child });

  return {
    kind,
    summary: code ? `${code}: ${message}` : message,
    exceptionType: code,
    missingModule,
    missingExecutable,
    frames,
    firstUserFrame,
    evidence,
    suggestions: suggestionsFor(kind, code, missingModule, missingExecutable, firstUserFrame),
  };
}
