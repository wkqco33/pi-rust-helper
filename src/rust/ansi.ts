/**
 * Strip ANSI escape sequences from tool output.
 *
 * GitHub Actions sets `CARGO_TERM_COLOR=always`, so the same cargo and rustc
 * invocations that are plain text locally arrive with colour escapes in CI
 * (`\x1b[1m\x1b[92m     Running\x1b[0m unittests …`). Every line-oriented parse
 * has to run on the stripped text, otherwise results depend on the environment.
 */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
