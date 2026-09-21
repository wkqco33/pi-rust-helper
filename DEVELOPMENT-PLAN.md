# pi-rust-helper 개발 계획

> 상태: **M0·M1·M2·M3 구현 완료** · 작성일 2026-09-21 · 구현일 2026-09-21
> 이 문서는 다음 pi 세션의 진입점입니다. 작업은 이 저장소를 cwd로 pi를 구동해 진행합니다.
> 구현 현황과 남은 작업은 문서 끝의 **구현 현황** 절을 참고하세요.

---

## 0. TL;DR

1. **공유 코어를 먼저 추출**한다. 근거는 측정된 중복이다: `pi-ros-helper`와 `pi-python-helper`가 같은 envelope/runner/safety/validation/staleness를 각자 구현했고, `src/core/version.ts`는 **바이트 단위로 동일**하며 `src/core/result.ts`는 이미 **드리프트**했다(ROS에는 `attention`/`CommandPreview.risk`가 없고, PY에는 `rosDistro`가 없다).
2. **Rust를 파일럿**으로 삼는다. 에이전트 실패 밀도가 가장 높고(feature 통합·toolchain·workspace 범위·doc test 누락), 빌드 시간이 지연을 지배하며, 진단 정보가 **완전 구조화**되어 있다.
3. 이 저장소는 **npm 워크스페이스 모노레포**로 만들어 `packages/pi-helper-core`(배포)와 `packages/pi-rust-helper`(배포)를 함께 둔다. 다음 세션에서 두 패키지를 동시에 편집할 수 있다.
4. **Rust는 Python 헬퍼가 필요 없다.** `cargo metadata --format-version 1`이 권위 있는 JSON을 주므로 `helpers/scan_project.py` 같은 스캐너와 **프로토콜 버전 관리가 통째로 사라진다.** 순수 TypeScript로 구현한다.
5. 기존 두 확장(ROS/Python) 마이그레이션은 **파일럿이 검증된 뒤** 별도·되돌릴 수 있는 단계로 미룬다.

---

## 1. 배경: 왜 이 순서인가 (측정 근거)

### 1.1 이미 존재하는 중복

| 파일 | ROS | Python | 비고 |
|---|---:|---:|---|
| `src/core/version.ts` | 20 | 20 | **완전 동일** |
| `src/core/result.ts` | 84 | 129 | 같은 계약, 59줄 차이 = 드리프트 |
| `src/core/runner.ts` | 91 | 96 | 동일 개념 |
| `src/core/safety.ts` | 14 | 181 | ROS는 도메인 휴리스틱, PY는 일반 위험도 분류 |
| `src/validation/{bundle,evidence,tdd}.ts` | 101 | 270 | 동일 개념 |
| `src/build/staleness.ts` | 140 | 117 | 동일 개념 |

계약 드리프트 실측:

- `pi-python-helper`의 envelope에는 `attention`, `CommandPreview.risk`, `projectRoot`, `pythonVersion`이 있다.
- `pi-ros-helper`의 envelope에는 `rosDistro`가 있고 **`attention`과 `risk`가 없다**.
- 두 패키지 모두 상태 변경 도구(`ros_topic_publish`, `ros_service_call`, `ros_action_goal`, `ros_lifecycle_transition`)를 갖지만 안전 메커니즘이 다르다(ROS는 `ctx.ui.confirm`, PY는 `classifyCommand` + 옵트인).

확장을 3개 더 복사하면 이 계약이 5벌로 갈라진다. 비용 추정:

| 전략 | 제품 코드 | CI 매트릭스 | envelope 계약 |
|---|---|---|---|
| 독립 3개 추가 | ~20k줄 + 인프라 3벌 | 3개 추가 | 5벌 분기 |
| **공유 코어 + 어댑터** | 코어 ~1k + 어댑터 1.5~2.5k ≈ **6~8k** | 1벌 재사용 | 1벌 통일 + 기존 드리프트 해소 |

### 1.2 Rust를 1순위로 두는 이유

| 축 | Rust | Go | Flutter |
|---|---|---|---|
| 에이전트 실패 밀도 | **높음** (feature 통합, toolchain/MSRV, workspace 범위, doc test) | 중간 | 높음 (codegen stale, SDK 제약) |
| 네이티브가 이미 해결 | 낮음 | **높음** (`GOTOOLCHAIN=auto`) | 중간 (`dart analyze` 우수) |
| 구조화 진단 | **완전** (`--message-format=json`) | 좋음 (`-json`) | 좋음(`--format=json`) |
| 지연 비용 | **최고** (빌드 시간이 지배) | 낮음 | 높음 |
| 구현 난이도 | **낮음** | 낮음 | 높음 |

---

## 2. 검증된 Rust 기술 사실 (이 계획의 핵심 근거)

로컬에서 실제로 실행해 확인했다. 환경: `cargo 1.98.1`, `rustc 1.98.1`, `rustup 1.29.1`, toolchain은 `stable`만 설치, `go 1.27.0`, `Flutter 3.47.5`/`Dart 3.13.4`.

### 2.1 거짓 초록(false green) — 파일럿의 존재 이유

워크스페이스 루트에서 `cargo test`를 실행하면 **`default-members`만** 테스트한다.

```
# Cargo.toml: default-members = ["crates/app"]
$ cargo test
     Running unittests src/main.rs (.../probe_app-...)
running 1 test
test result: ok. 1 passed; 0 failed; ...        ← core의 doc test는 실행되지 않음

$ cargo test --workspace
     Running unittests src/main.rs (...)        ← app: 1 passed
     Running unittests src/lib.rs (...)         ← core: 0 passed
   Doc-tests probe_core
running 1 test
test result: ok. 1 passed; ...                  ← 여기서만 실행됨
```

**에이전트는 "테스트 통과"라고 보고하지만 `probe-core`는 검증되지 않았다.** 이게 Rust 헬퍼의 최대 가치다.

### 2.2 libtest JSON은 nightly 전용

```
$ cargo test -- --format=json -Z unstable-options
error: the option `Z` is only accepted on the nightly compiler
```

→ **stable에서는 테스트 출력이 구조화되지 않는다.** `pytest`와 같은 텍스트 파서가 필요하다.
→ `cargo nextest`는 `--message-format json`을 주지만 **미설치**(`error: no such command: nextest`) → 선택적 지원.

### 2.3 0개 테스트 실행도 exit 0

```
$ cargo test --workspace -- --exact does_not_exist
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out
exit=0
```

→ `ZERO_TESTS_RUN`을 "not proven"으로 분류해야 한다(pytest의 `noTestsRan`과 동일한 실패 클래스).

### 2.4 `--tests`는 doc test를 제외한다

`cargo test --workspace --tests` 실행 시 `Doc-tests` 섹션이 **0개** → 플래그만 보고 doc test 누락을 탐지할 수 있다.

### 2.5 진단은 완전 구조화되어 있다

```
$ cargo check -p probe-app --message-format=json
level= error  code= E0599
primary: crates/app/src/main.rs 3  in_project= True
level= failure-note  code= None
```

- `code`(E0599 등), `spans[].is_primary`, `spans[].file_name`이 모두 구조화 → **정규식 없이** 첫 프로젝트 프레임을 뽑을 수 있다. Python의 traceback 파싱보다 훨씬 견고하다.
- `cargo clippy --message-format=json`도 동작(구조화됨).
- 사람이 읽는 형식(`--message-format=short`)은 `file:line:col: error[E0599]: msg`.

### 2.6 메타데이터와 오프라인

`cargo metadata --format-version 1`이 주는 것:

- `workspace_members`, `workspace_default_members`, `workspace_root`, `target_directory`
- 패키지별 `rust_version`(MSRV), `edition`, `features`, `targets[].kind`/`test`/`doctest`/`src_path`, `manifest_path`, `dependencies`
- 전체 해석 시 `resolve.nodes[].features` = **실제 적용된 feature 집합**(feature 통합 결과)

`--no-deps`를 주면 `resolve`가 `null`이 된다. `--offline`은 path-only 워크스페이스에서 성공한다.

### 2.7 toolchain 출처

```
$ rustc -vV
rustc 1.98.1 (...)
host: x86_64-unknown-linux-gnu
release: 1.98.1
LLVM version: 22.1.8

$ rustup show active-toolchain
stable-x86_64-unknown-linux-gnu (overridden by '/tmp/rprobe/rust-toolchain.toml')
```

`rustc -vV`만으로 host triple·release(MSRV 비교)·LLVM을 얻는다. `rustup toolchain list`로 설치된 toolchain을 확인한다.

> ⚠️ **위험**: `rust-toolchain.toml`이 설치되지 않은 채널을 지정하면 rustup이 **자동 다운로드**를 시도한다(네트워크 + `~/.rustup` 변경). 구현 시 `rust-toolchain.toml`을 먼저 읽어 활성 toolchain과 비교하고, 불일치하면 **경고 후 확인**받아야 한다. 이 동작은 파일럿에서 짧은 타임아웃으로 검증한다(대용량 다운로드 유발 금지).

---

## 3. 아키텍처

### 3.1 저장소 레이아웃

> **변경(2026-09-21)**: 코어는 모노레포 내부가 아니라 **별도 저장소**
> `/home/seoyc/Workspace/utils/pi-helper-core`에 이미 작성되었다(1,554줄 소스 + 737줄 테스트,
> 48 테스트 통과). 이 저장소는 Rust 확장만 담당하고 코어는 `file:` 또는 npm 의존으로 가져온다.

```
/home/seoyc/Workspace/utils/
├─ pi-helper-core/                  # 별도 저장소, 배포: pi-helper-core (작성 완료)
│  ├─ src/core/{result,runner,safety}.ts
│  ├─ src/validation/{bundle,evidence,tdd}.ts
│  ├─ src/build/staleness.ts
│  ├─ src/selection/select.ts
│  ├─ src/adapter.ts                # EcosystemAdapter 계약
│  └─ test/*.test.ts                # 48 tests, purity.test.ts 포함
│
└─ pi-rust-helper/                  # 이 저장소 (Rust 확장 전용)
   ├─ DEVELOPMENT-PLAN.md
   ├─ package.json                  # "pi-helper-core": "file:../pi-helper-core"
   ├─ extensions/index.ts
   ├─ extensions/tools/{environment,project,testing,validation}.ts
   ├─ src/rust/adapter.ts           # EcosystemAdapter 구현
   ├─ src/rust/{model,commands,output,failure,risk}.ts
   ├─ skills/rust-development/SKILL.md
   ├─ scripts/                      # 문서 생성
   └─ test/*.test.ts  test/manual/e2e-rust.ts
```

코어를 별도 저장소로 두면 코어만 독립적으로 버전·배포할 수 있고 각 헬퍼가 같은 버전을 고정해 쓸 수 있다. 대신 코어를 수정할 때는 코어 저장소를 cwd로 한 별도 세션이 필요하다.

### 3.1.1 코어에서 이미 확정된 것 (재구현 금지)

코어가 제공하므로 Rust 헬퍼는 **다시 만들지 않는다**:

| 코어 자산 | Rust 헬퍼가 하는 일 |
|---|---|
| `createResultFactory(toolVersion)` | `src/core/result.ts` shim만 두고 호출부는 그대로 |
| `runCommand` / `isSpawnFailure` | `cargo` 실행에 그대로 사용 |
| `classifyCommand(command, rules)` | universal 규칙은 자동, `cargo` 전용 규칙만 주입 |
| `buildCompletionEvidence` | `preparation.label`에 검사 단계 이름만 지정 |
| `summarizeValidation` | 라벨만 주입. **프리뷰는 자동으로 `ok:false`** |
| `detectStaleArtifacts` | Rust는 `derivedArtifacts()`가 빈 배열(콘텐츠 기반 캐시라 mtime 비교 무의미) |
| `selectTests` | `SelectionSignals` 구현만 제공 |
| `checkTdd` | `TddSignals` 구현만 제공 |

주의: 코어는 `EcosystemAdapter` 전체를 요구하지 않는다. M1 도구가 쓰는 메서드만 구현한다.

### 3.2 패키지 경계 원칙

- `pi-helper-core`는 **생태계 지식을 갖지 않는다.** `cargo`, `uv`, `ros2` 같은 문자열이 등장하면 경계 위반이다. 이를 테스트로 강제한다(`core/test/no-ecosystem-imports.test.ts`).
- `pi-rust-helper`는 **코어를 복사하지 않는다.** 모든 공통 로직은 core import.
- 코어는 도구를 등록하지 않는다(`pi.registerTool` 호출 금지). 확장 등록은 각 헬퍼 패키지의 책임이다.

### 3.3 배포·버전 전략

- 이 저장소는 `"pi-helper-core": "file:../pi-helper-core"`로 로컬 개발하고, 배포 시 `^0.1.0` 같은 고정 버전으로 바꾼다. 코어를 먼저 npm에 배포해야 헬퍼를 배포할 수 있다.
- 코어는 `CORE_SCHEMA_VERSION`을 노출한다. envelope 구조가 바뀌면 올리고, 헬퍼는 자신이 기대하는 버전과 다르면 그대로 보고한다.
- **breaking 변경 규칙**: envelope 필드 추가/제거나 `EcosystemAdapter` 시그니처 변경은 core의 minor(0.y)에서 허용하되 CHANGELOG에 `**Breaking:**`으로 명시. 스캐너가 없으므로 프로토콜 버전은 없고 `CORE_SCHEMA_VERSION`만 있다.
- 릴리스는 기존 두 저장소와 동일하게 Conventional Commits + `chore(release): bump version to X` + `vX` 태그 → publish 워크플로.

---

## 4. `pi-helper-core` 상세 설계

### 4.1 `core/result.ts` — envelope

기존 두 패키지의 합집합 + 0.3.0에서 확정한 `ok`/`attention` 계약을 그대로 이식한다.

```ts
export type Severity = 'info' | 'warning' | 'error';
export type CommandRisk = 'read' | 'mutating' | 'irreversible';

export interface Diagnostic { code?: string; message: string; severity: Severity; path?: string; line?: number }
export interface Evidence { kind: string; message?: string; [key: string]: unknown }
export interface Suggestion { message: string; confidence?: 'low' | 'medium' | 'high'; command?: string }
export interface CommandPreview { executable: string; args: string[]; cwd?: string; risk?: CommandRisk }

/** 생태계 중립적 toolchain 서술자. pythonVersion/rosDistro를 대체한다. */
export interface ToolchainInfo {
  kind: string;          // 'rust' | 'python' | ...
  version?: string;      // release
  source?: 'venv' | 'path' | 'rustup' | 'unknown';
  host?: string;         // target triple 등
  detail?: Record<string, string>;
}

export interface ToolMetadata {
  toolVersion: string; cwd: string; durationMs: number; truncated: boolean;
  projectRoot?: string; toolchain?: ToolchainInfo;
}

export interface ToolResult<T = unknown> {
  ok: boolean;        // 이 도구가 묻는 질문에 긍정 답을 얻었는가 (판정)
  attention: boolean; // 조치가 필요한가 (ok:false 또는 warning/error 존재; info는 제외)
  summary: string;
  data?: T;
  evidence: Evidence[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
  suggestions: Suggestion[];
  commands?: CommandPreview[];
  metadata: ToolMetadata;
}
```

불변식(테스트로 강제):

- `ok === false`이면 `warnings`/`errors` 중 **actionable한 진단이 최소 1개** 존재한다(설명 없는 `ok:false` 금지).
- `attention === !ok || actionable(warnings) || actionable(errors)` 이며, `severity:'info'`는 actionable이 아니다.
- 모든 도구는 동일한 envelope를 반환한다.

### 4.2 `core/runner.ts`

`runCommand(executable, args, { cwd, signal, timeoutMs, maxBytes })` → `{ code, stdout, stderr, timedOut, truncated, durationMs }`

- 인자 배열만 사용(쉘 보간 금지).
- 타임아웃·`AbortSignal`·출력 상한·truncation 플래그 필수.
- 표준입력 주입이 필요한 경우를 위해 `stdin?: string`을 지원(스캐너류 대체).

### 4.3 `core/safety.ts`

```ts
export interface RiskRule { pattern: RegExp; risk: CommandRisk; note: string }
export function classifyCommand(argv: string[], rules: RiskRule[]): CommandRisk;
export function isMutatingCommand(argv: string[], rules: RiskRule[]): boolean;
```

- **규칙은 어댑터가 주입**한다(코어에 생태계 문자열 금지).
- 복합 명령(`&&`, `;`, `|`)은 **최고 위험 세그먼트를 상속**한다(기존 `core.test.ts`가 검증하던 동작).
- `read`만 자동 실행, 나머지는 `execute:true` + (해당되면) `ctx.ui.confirm`.

### 4.4 `validation/` — 완료 게이트

- `evidence.ts`: `{ syncExecuted, syncOk, testExecuted, testOk, stale, changedPaths }` → `{ ok, blockers }`. 실행되지 않은 단계는 **증거 부족**으로 차단한다.
- `bundle.ts`: 단계 배열(`lock|sync|test|quality|conformance|stale`) → `{ ok, checks, reason }`. 미실행 단계가 있으면 통과시키지 않는다.
- `tdd.ts`: 프로덕션 변경 ↔ 테스트 변경 연관. **파일 분류와 모듈명 계산은 어댑터 주입**. 공유 패키지 접두사만으로 매칭된 경우 `weakAssociation`으로 공개(기존 규칙 유지).
- `staleness.ts`: `ArtifactSpec[]`(글롭 + 소스 글롭)을 받아 "파생 산출물이 소스보다 오래됨"을 판정. Python은 `.coverage`, Flutter는 `*.g.dart`; **Rust는 `target/` fingerprint가 콘텐츠 기반이라 해당 없음** → Rust 어댑터는 빈 목록을 반환하고, 대신 아래 4.6의 "실행 범위" 검사가 그 역할을 대신한다.

### 4.5 `selection/select.ts` — 테스트 선별

기존 `selection.ts`는 이미 생태계 무관한 형태다. 그대로 이식하고 다음만 주입받는다.

```ts
export interface SelectionSignals {
  isSourceFile(path: string): boolean;
  isTestFile(path: string): boolean;
  isRunnableTestFile(path: string): boolean;
  pathTokens(path: string): string[];
  moduleNamesForFile(path: string): string[];
  supportFileNames: string[];   // conftest.py, mod.rs 등
}
export function selectTests(changedPaths, candidates, signals, options?): SelectionResult;
```

유지할 규칙: import 근거 > 이름 규약, **모든 후보가 공유하는 신호는 점수에서 제외**(전체 스위트 퇴화 방지), `narrowed`/`importEvidenceUsed` 공개, `SELECTION_WITHOUT_IMPORT_EVIDENCE` 경고.

### 4.6 `EcosystemAdapter` 계약

```ts
export interface AdapterContext { cwd: string; projectRoot?: string; signal?: AbortSignal }

export interface TestReport {
  executed: boolean; exitCode: number | null; timedOut: boolean;
  counts: { passed: number; failed: number; ignored: number; filtered: number };
  ranTargets: string[];         // 실제로 실행된 crate/target (Rust의 핵심)
  includedDocTests: boolean;
  noTestsRan: boolean;          // 0개 실행 → not proven
  failures: { test: string; message: string; file?: string; line?: number }[];
  incomplete: boolean;
}

export interface FailureDiagnosis {
  kind: FailureKind;            // 'missing_crate' | 'unresolved_import' | 'trait_bound' | 'borrow' | 'linker' | 'feature_gated' | 'unknown' | ...
  summary: string;
  exceptionType?: string;       // 'E0599' 등
  firstUserFrame?: { path: string; line: number; column?: number };
  evidence: { message: string; file?: string; line?: number }[];
  suggestions: Suggestion[];
}

export interface ProjectModel {
  root: string; toolchain: ToolchainInfo;
  packages: { name: string; version: string; manifest: string; members: boolean; defaultMember: boolean;
              rustVersion?: string; edition?: string; features: string[] }[];
  warnings: Diagnostic[];
}

export interface EcosystemAdapter {
  readonly id: string;
  riskRules: RiskRule[];
  resolveToolchain(ctx: AdapterContext): Promise<ToolchainInfo>;
  readProjectModel(ctx: AdapterContext): Promise<ProjectModel>;
  isSourceFile(path: string): boolean;
  isTestFile(path: string): boolean;
  isRunnableTestFile(path: string): boolean;
  pathTokens(path: string): string[];
  moduleNamesForFile(path: string): string[];
  testCommand(input: { targets?: string[]; features?: FeatureSelection; docTests?: boolean; flags?: string[] }, ctx: AdapterContext): CommandPreview;
  checkCommand(input: { targets?: string[]; allTargets?: boolean; features?: FeatureSelection }, ctx: AdapterContext): CommandPreview;
  parseTestOutput(stdout: string, stderr: string): TestReport;
  diagnoseFailure(output: string, model?: ProjectModel): FailureDiagnosis;
  derivedArtifacts(model: ProjectModel): ArtifactSpec[];
  testDirectories(model: ProjectModel): string[];
}
```

**파일럿 규율**: 세 개 도구(M1)가 필요로 하는 메서드만 먼저 구현한다. 나머지는 인터페이스에만 두고 `TODO(adapter)`로 표시한다. 쓰이지 않는 추상화를 먼저 만들지 않는다.

---

## 5. Rust 파일럿 상세 설계

### 5.1 도구 목록과 마일스톤

도구 접두사는 `rust_`로 한다(에이전트가 생태계를 즉시 식별). **상한 10개**.

#### M0 — 워크스페이스 + 코어 (도구 없음)
- 워크스페이스 부트스트랩, `pi-helper-core` 모듈 이식, envelope/attention/selection 테스트.
- 수용 기준: 코어 테스트 그린, "코어에 생태계 문자열 없음" 테스트 그린.

#### M1 — MVP (4 도구): 거짓 초록을 잡는다

| 도구 | 역할 | 핵심 데이터 |
|---|---|---|
| `rust_environment` | 실제로 실행될 toolchain 증명 | `rustc -vV`(release/host/LLVM), `cargo --version`, `rustup toolchain list`, `rust-toolchain.toml` 채널, target dir, workspace root |
| `rust_project_inspect` | 워크스페이스 모델 + 정합성 | `cargo metadata --offline`; members/default-members, MSRV vs 설치 release, edition, feature 표, `Cargo.lock` 유무, path/git/patch 의존성 |
| `rust_test` | 테스트 실행 + **실행 범위 보고** | `ranTargets`, `includedDocTests`, `noTestsRan`, counts, 실패 목록 |
| `rust_validation_bundle` | 완료 게이트 | lock/해석 → (선택) check → test → 실행범위 → stale |

`rust_completion_evidence`는 코어 `evidence.ts`를 그대로 노출하는 얇은 도구로 M1에 포함(총 5개).

**M1이 반드시 탐지해야 하는 오류 코드**

- `ZERO_TESTS_RUN` (error): 0개 실행 → 결과를 신뢰할 수 없음
- `DEFAULT_MEMBERS_ONLY` (warning): `--workspace` 없이 실행되어 일부 crate가 미검증
- `DOCTESTS_SKIPPED` (warning): `--tests` 등으로 doc test 제외
- `TOOLCHAIN_FILE_MISMATCH` (warning): `rust-toolchain.toml` 채널 ≠ 활성 toolchain
- `TOOLCHAIN_NOT_INSTALLED` (error): 채널 미설치 → 실행 시 자동 다운로드 유발
- `MSRV_UNSATISFIED` (warning): `rust-version` > 설치된 release
- `WORKSPACE_MEMBER_MISSING` (warning): `members` 글롭이 아무것도 매칭하지 않음
- `LOCKFILE_MISSING` / `RESOLVE_REQUIRES_NETWORK` (info/warning)

#### M2 — 정밀도 (4 도구)

| 도구 | 역할 |
|---|---|
| `rust_check` | `cargo check -p <crate> --all-targets [--all-features\|--no-default-features]`, 구조화 진단 요약 |
| `rust_test_select` | 변경 파일 → `cargo metadata` 역의존 그래프 → 영향 crate → `-p` 타깃 |
| `rust_failure_diagnose` | `--message-format=json` 기반. error code(E0432/E0433/E0599/E0277/E0061/E0412), 첫 in-project span, registry/`~/.cargo` 프레임 배제 |
| `rust_tdd_checkpoint` | 프로덕션 crate 변경 ↔ 테스트 변경 |

#### M3 — 의존성·빌드 (2 도구)

| 도구 | 역할 |
|---|---|
| `rust_dependency_plan` | `Cargo.toml` ↔ `Cargo.lock` 드리프트, 미사용 의존성, 중복 버전, `[patch]`/git 의존성, `--all-features` 컴파일 공백 |
| `rust_build` | `cargo build -p`, 위험도 분류 + 옵트인 |

### 5.2 Rust 특화 함정과 대응 (검증됨)

| 함정 | 검증 결과 | 대응 |
|---|---|---|
| 루트 `cargo test`가 default-members만 실행 | §2.1 확인 | `ranTargets` 보고 + `DEFAULT_MEMBERS_ONLY` |
| 0개 테스트도 exit 0 | §2.3 확인 | `ZERO_TESTS_RUN` → `ok:false` |
| libtest JSON은 nightly 전용 | §2.2 확인 | libtest **텍스트 파서** + nextest JSON 선택 지원 |
| `--tests`가 doc test 제외 | §2.4 확인 | `DOCTESTS_SKIPPED` |
| 전체 `cargo metadata`가 네트워크 요구 가능 | `--offline` 성공 확인 | 기본 `--offline`, 실패 시 이유 반환 |
| `rust-toolchain.toml` 미설치 채널 → 자동 다운로드 | 설계상 위험 | 실행 전 감지·경고, 구현 시 짧은 타임아웃으로 검증 |
| feature 통합으로 컴파일이 3가지 | `resolve.nodes[].features` 확인 | 실행된 feature 집합을 항상 보고 |
| 컴파일 오류가 완전 구조화 | §2.5 확인 | 정규식 없이 JSON 파싱 |

### 5.3 명령 빌더 규칙

- 기본: `cargo metadata --format-version 1 --offline` (읽기 전용).
- 테스트: `cargo test [--workspace] [-p <crate>] [--all-features|--no-default-features] [--tests|--doc]`.
- 검사: `cargo check [-p] [--all-targets] [--all-features] --message-format=json`.
- 품질 게이트: `cargo clippy --message-format=json` — **선언된/clippy가 있을 때만**, 독립 도구로 만들지 않는다.
- 빌드: `cargo build [-p]` — `mutating`.
- 위험도 규칙(Rust):

| 명령 | risk |
|---|---|
| `cargo metadata`, `cargo tree`, `cargo check`, `cargo test`, `cargo clippy`, `rustc -vV` | `read` |
| `cargo build`, `cargo run`, `cargo fetch`, `cargo update` | `mutating` |
| `cargo add`, `cargo remove`, `cargo publish`, `cargo clean`, `cargo install`, `rm -rf target` | `irreversible` |

### 5.4 테스트 출력 파서 (libtest 텍스트)

파싱 대상과 규칙:

- 섹션 헤더: `Running unittests src/lib.rs (...)` / `Doc-tests <crate>` → `ranTargets`와 `includedDocTests`를 만든다. **여기가 `DEFAULT_MEMBERS_ONLY` 판정 근거**다.
- 결과 줄: `test result: ok. N passed; M failed; K ignored; J measured; F filtered out` → counts.
- 실패: `---- <name> stdout ----` 블록과 `failures:` 목록 → `failures[]`.
- 종료 상태: `error: could not compile` / `error[E...]` → `incomplete` 또는 컴파일 실패로 분류.
- `running 0 tests` + `0 passed; ... N filtered out` → `noTestsRan`.

### 5.5 실패 진단 설계

1. `--message-format=json`을 우선 사용한다(구조화). `reason === 'compiler-message'`에서 `level`, `code.code`, `spans[].is_primary`, `spans[].file_name`, `line_start`, `column_start`를 읽는다.
2. `~/.cargo/registry`, `rustup/toolchains/.../lib/rustlib` 경로는 **library frame으로 분류**해 원인에서 배제한다(기존 규칙).
3. 오류 코드 → kind 매핑: `E0432`/`E0433`(unresolved import/crate → 의존성 누락 가능), `E0599`(메서드 없음 → trait 미import 또는 feature 게이트), `E0277`(trait bound), `E0061`(인자 개수), `E0412`(타입 없음), `E0463`(crate 없음 → target/feature).
4. `#[cfg(feature = ...)]`로 감싸인 심볼이 없을 때는 **feature 게이트 힌트**를 제안에 넣는다.

---

## 6. 마일스톤 수용 기준 (Definition of Done)

각 마일스톤은 아래를 **모두** 통과해야 완료로 본다.

| 게이트 | 명령 | 기준 |
|---|---|---|
| 단위·통합 테스트 | `npm test` | 전부 통과, `cargo` 없는 환경은 `t.skip()`으로 **명시적 skip**(조용한 통과 금지) |
| 타입 | `npm run typecheck` | 오류 0 |
| 포맷 | `npm run format:check` | 통과 |
| 문서 최신성 | `npm run docs:check` | 도구 스키마/스냅샷 일치 |
| 패키지 | `npm run pack-check` | 포함 파일 목록 검증 |
| e2e | `npm run test:e2e` | 실제 cargo 프로젝트 대상, 스캐너 대신 `cargo metadata` 경로 |
| CI | GitHub Actions | Node 20/22/24, rust stable. `cargo` 미설치 시 skip 경로도 검증 |
| **거짓 초록 회귀** | 픽스처 | `default-members` 워크스페이스에서 `DEFAULT_MEMBERS_ONLY`가 **반드시** 발생 |

**필수 회귀 테스트(고정)**: §2의 실측 동작을 픽스처로 고정한다.

- `default-members` 워크스페이스 → `DEFAULT_MEMBERS_ONLY` + `ranTargets` 정확성
- 0개 실행 → `ZERO_TESTS_RUN`, `ok:false`, actionable 진단 존재
- `--tests` 실행 → `DOCTESTS_SKIPPED`
- 컴파일 오류 JSON → `firstUserFrame`이 registry가 아닌 프로젝트 파일
- `rust-version` > 설치 release → `MSRV_UNSATISFIED`

---

## 7. 테스트 전략

- **순수 함수 우선**: 파서(`parseTestOutput`), 명령 빌더, 위험도 분류, 선별 랭킹, 게이트 로직은 전부 순수 함수 + 단위 테스트.
- **픽스처 프로젝트**: `test/fixtures/`에 최소 워크스페이스(core lib + app bin + doctest + default-members)를 두고, 테스트가 필요 시 `target/`을 임시 디렉터리로 돌린다(`CARGO_TARGET_DIR`).
- **cargo 없으면 skip**: `rustc --version` 실패 시 `t.skip('no Rust toolchain')`. Python 헬퍼의 규칙과 동일.
- **e2e**(`test/manual/e2e-rust.ts`): 임시 워크스페이스를 만들어 (1) 거짓 초록 탐지, (2) 컴파일 오류 진단, (3) MSRV 탐지를 하나의 흐름으로 검증.
- **코어 계약 테스트**: envelope 불변식 2개(`ok:false ⇒ actionable 진단`, `attention` 파생)와 "코어에 생태계 문자열 없음"을 core 패키지에서 강제.

---

## 8. CI / 릴리스

- `ci.yml`: Node 20/22/24 매트릭스 + `dtolnay/rust-toolchain@stable` 설치. **Python 매트릭스가 필요 없다**(스캐너 없음).
- `publish.yml`: `v*` 태그 → `npm publish --provenance --access public`. **모노레포이므로 태그-버전 일치 검사를 패키지별로 확장**해야 한다(어느 패키지를 배포할지 결정 규칙 필요, §11 열린 결정).
- 릴리스 순서(기존 저장소와 동일): 버전 범프 → CHANGELOG `[Unreleased]` → 새 버전 섹션 → 태그 푸시.
- ⚠️ 태그 푸시는 **곧 npm 배포**다(되돌릴 수 없음). 워크플로가 의도대로 동작하는지 `--dry-run` 상당의 사전 검증 절차를 둔다.

---

## 9. 위험 등록부

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| R1 | `pi-helper-core` API를 표본 1개(Rust)로 확정 | 나중에 어댑터 seam이 부족해 대개편 | M1에서 **쓰이는 메서드만** 구현, 나머지는 TODO. ROS/Python 마이그레이션 때 재검토 |
| R2 | `rust-toolchain.toml` 미설치 채널로 대용량 다운로드 유발 | 시간·디스크·네트워크 | 실행 전 파일 파싱으로 감지, 경고 후 확인. 테스트는 짧은 타임아웃 |
| R3 | libtest 텍스트 출력 포맷 변경 | 파서 오작동 | 파서를 순수 함수로 격리, cargo 버전별 회귀 테스트. nextest JSON 대안 유지 |
| R4 | 모노레포 publish 복잡도(태그 ↔ 패키지 매핑) | 잘못된 패키지 배포 | 배포 워크플로에 드라이런 단계, 패키지별 version 검증 |
| R5 | 기존 두 확장과 계약이 또 갈라짐 | 원래 문제 재발 | core를 단일 진실로. 각 헬퍼는 envelope를 재정의하지 못하게 테스트로 차단 |
| R6 | clippy/rustfmt 범위 팽창 | 범위 위반(린트는 별도 확장 원칙) | "선언된 품질 게이트"로만 실행, 독립 도구 금지 |
| R7 | 도구 수 팽창 | 에이전트 오선택 | **상한 10개** 유지, 초과 시 기존 도구 파라미터로 흡수 |

---

## 10. 파일럿 성공 판정 (측정)

파일럿은 "만들었다"가 아니라 아래 지표로 판정한다.

| 지표 | 측정 방법 | 성공 기준 |
|---|---|---|
| 거짓 초록 탐지 | 실제 Rust 과제 로그에서 `ZERO_TESTS_RUN`/`DEFAULT_MEMBERS_ONLY`/`DOCTESTS_SKIPPED` 발생 건수 | 과제 5개에서 **≥1건** |
| 과장 차단 | 완료 게이트가 막은 "검증 없이 완료 선언" | **≥1건** |
| 시간 절감 | `cargo test`(워크스페이스 전체) 대비 `rust_test_select`가 좁힌 대상/소요 | 루트 전체 실행 대비 **유의미한 감소** |
| 오탐률 | 도구 경고 중 실제 문제가 아니었던 비율 | **< 10%** (초과 시 경고를 `info`로 강등) |

측정은 기존 두 확장과 동일하게 "도구 호출이 에이전트의 결정을 바꿨는가"를 로그로 남겨 판단한다.

---

## 11. 열린 결정 (사용자 확인 필요)

1. **저장소 형태**: 이 모노레포(권장) vs `pi-helper-core` 별도 저장소.
2. **패키지명**: `pi-helper-core` vs `@pi/helper-core`(npm 스코프 필요 여부).
3. **도구 접두사**: `rust_*`(권장) vs `cargo_*`.
4. **clippy/rustfmt**: 완전 제외 vs "선언된 품질 게이트"로만 포함(권장).
5. **모노레포 publish 규칙**: 태그 이름 규칙(예: `v*` 공통 vs `core-v*`/`rust-v*` 분리).
6. **기존 두 확장 마이그레이션 시점**: Rust 파일럿 검증 후(권장) vs 즉시.

---

## 12. 다음 세션 시작 절차

```bash
cd /home/seoyc/Workspace/utils/pi-rust-helper
rustc --version && cargo --version && node --version   # 전제 확인
git init && git add -A && git commit -m "docs: add development plan"

# M0
npm init -y                       # private root, workspaces: ["packages/*"]
mkdir -p packages/pi-helper-core packages/pi-rust-helper
# core 이식 → envelope 불변식 테스트 → "생태계 문자열 없음" 테스트
# 그 다음 M1 도구 1개(environment) → 픽스처 → 회귀 테스트
```

**첫 커밋 이후 반드시 지킬 것**

- 픽스처로 §2의 실측 동작(거짓 초록)을 **먼저 테스트로 고정**한 뒤 구현한다(TDD).
- `runCommand` 인자 배열·타임아웃·출력 상한 없이 명령을 실행하지 않는다.
- 읽기 전용은 자동, 상태 변경은 `execute:true` + 필요 시 `ctx.ui.confirm`.
- 도구 반환은 항상 코어 envelope를 사용하고 `ok`/`attention` 계약을 재정의하지 않는다.
- 커밋 전 `npm test && npm run typecheck && npm run format:check && npm run docs:check`.

---

## 13. 구현 현황 (2026-09-21)

`pi-helper-core`는 npm에 배포된 **0.1.1**을 `^0.1.1`로 의존한다(로컬 `file:` 아님).
`npm run check`(86 테스트 + typecheck + format + docs + pack)와
`npm run test:e2e`(5/5)가 통과한다.

### 완료

| 마일스톤 | 내용 |
|---|---|
| M0 | 코어 연동, envelope/attention 불변식 테스트(`test/helpers/harness.ts`의 `assertEnvelope`) |
| M1 | `rust_environment`, `rust_project_inspect`, `rust_test`, `rust_validation_bundle`, `rust_completion_evidence` |
| M2 | `rust_check`, `rust_test_select`, `rust_failure_diagnose`, `rust_tdd_checkpoint` |
| M3 | `rust_build` (mutating + `ctx.ui.confirm`). `rust_dependency_plan`은 `rust_project_inspect`로 흡수(중복 버전/source 통계 + `scanUnusedDependencies` 스캔). `rust_test_select.checkAllFeatures`가 계획의 "컴파일 공백"을 담당 |
| 회귀 | `default-members` 거짓 초록, 0개 테스트, `--tests` doc test 누락, 컴파일 오류 프레임, MSRV, 미사용 의존성 — 픽스처로 고정 |

### 계획과 달라진 결정 (근거 포함)

1. **rustup을 호출하지 않는다.** 실측: rustup 1.29는 `rustup toolchain list`와
   `rustup show`에서도 `rust-toolchain.toml`의 미설치 채널을 **자동 다운로드**한다
   (계획 R2보다 범위가 넓다). 그래서 `rust_environment`는 `~/.rustup/toolchains`
   디렉터리와 `settings.toml`을 읽어 채널을 비교하고, 미설치면 `rustc`/`cargo`를
   아예 실행하지 않는다(`TOOLCHAIN_NOT_INSTALLED`).
2. **모델 읽기는 파일을 변조하지 않는다.** lockfile이 있으면 `--locked`, 없으면
   `--no-deps`로 `cargo metadata`를 실행한다. `--offline` 단독 실행은 드리프트를
   조용히 복구해 버리므로, 드리프트는 `LOCKFILE_DRIFT`로 보고하고 `cargo check`/`test`를
   건너뛴다. `rust_project_inspect`는 `rust_dependency_plan`의 중복 버전·source 종류·
   미사용 의존성 분석을 `data.dependencies`로 제공한다(미사용 스캔은 opt-in, 예산 초과 시
   `incompleteReason` 공개).
3. **`--message-format=json`을 테스트 실행에 사용한다.** stable에서 libtest JSON은
   불가능하지만 `compiler-artifact` 레코드는 stable에서도 나온다. 이를 이용해
   `ranTargets`/`testedPackages`를 헤더 추측이 아니라 구조화 데이터로 만든다.
   (헤더 `Running …`/`Doc-tests …`는 stderr, 결과 줄은 stdout이므로 순서로 짝지어 파싱한다.)
4. **도구 상한 10개 유지.** 계획의 M1+M2+M3 합계는 11개였다. `rust_dependency_plan`을
   별도 도구로 만들지 않고 `rust_project_inspect`로 흡수했다.
5. **프리뷰는 `ok:false` + `PREVIEW_ONLY` 경고.** 코어 불변식(`ok:false`에는 설명하는
   진단이 최소 1개)을 만족시키기 위해 미리보기는 통과로 표시하지 않는다.

### 남은 작업

- 기존 두 확장(`pi-ros-helper`, `pi-python-helper`)의 코어 마이그레이션: 파일럿이
  검증됐으므로 별도·되돌릴 수 있는 단계로 진행 가능(§11.6).
- `pi-rust-helper` 자체의 npm 최초 배포(수동 1회 + trusted publisher 등록, 코어와 동일).
- 선택적 확장(요구가 확인되면): `cargo nextest` JSON 파서, `--all-features` 매트릭스
  도구화, workspace `members` 글롭과 `exclude` 교차 검증.

### 계획 §11 열린 결정에 대한 확정

1. 저장소 형태: **별도 `pi-helper-core` 저장소** (계획 §3.1 변경 사항대로).
2. 패키지명: `pi-helper-core`/`pi-rust-helper` (npm 스코프 없음).
3. 도구 접두사: `rust_*`.
4. clippy/rustfmt: **선언된 품질 게이트로만** 실행(`clippy.toml`/`[lints.clippy]`/`rustfmt.toml`
   존재 시). 독립 도구는 만들지 않았다.
5. publish 규칙: 저장소가 분리되어 있으므로 각 저장소가 `v*` 태그를 쓴다.
6. 기존 두 확장 마이그레이션: 파일럿 검증 후.
