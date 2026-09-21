---
name: rust-development
description: pi-rust-helper를 활용한 cargo 기반 Rust 개발 워크플로. 툴체인/rust-toolchain.toml 점검, 워크스페이스 모델과 MSRV 확인, cargo test 실행 범위 검증, 컴파일 오류/실패 진단, 테스트 선별, 완료 게이트 검증 시 사용합니다.
license: Apache-2.0
---

# pi-rust-helper를 활용한 cargo 기반 Rust 개발 워크플로

원시 쉘 명령어(`cargo test`, `grep`, `rustc`)를 직접 실행하기 전에 Rust 전용 도구를 우선 사용하세요.

## 조사 및 작업 순서 (Investigation order)

1. 툴체인 상태가 불확실할 때는 `rust_environment`를 실행하세요. `rust-toolchain.toml`이 설치되지 않은 채널을 지정하면 `cargo`/`rustc` 실행만으로 rustup이 수백 MB를 다운로드합니다. 도구는 `~/.rustup/toolchains`를 읽어 `TOOLCHAIN_NOT_INSTALLED`를 먼저 보고하므로, 이 오류가 보이면 `rustup toolchain install <channel>` 전에는 어떤 cargo 명령도 실행하지 마세요.
2. `Cargo.toml`을 편집하기 전이나 워크스페이스 구성이 불확실할 때 `rust_project_inspect`를 사용하세요. 멤버, `default-members`, edition, MSRV(`rust-version`), 타깃, **실제 적용된 feature 집합**(`resolve.nodes`)을 보고합니다. `membersOutsideDefault`는 bare `cargo` 명령이 놓치는 크레이트입니다.
3. `rust-version` > 활성 release이면 `MSRV_UNSATISFIED`가 발생합니다. 테스트를 신뢰하기 전에 toolchain을 맞추세요.
4. 소스 변경 후에는 `rust_test_select`로 변경 파일을 크레이트로 매핑하세요. Rust에는 파일 단위 테스트 타깃이 없으므로 결과는 **크레이트 집합**입니다. `affectedCrates`는 역의존 그래프를 포함하므로 `-p` 타깃으로 그대로 쓰면 됩니다. `narrowed: false`는 모든 멤버가 영향받았다는 뜻입니다.
5. 테스트 실행은 `rust_test`를 사용하고 `execute=false`로 먼저 미리보기하세요. 기본은 `--workspace`입니다. `workspace:false`는 bare `cargo test`를 재현하는 용도이며, 이때 `DEFAULT_MEMBERS_ONLY`가 발생하면 그 실행은 워크스페이스를 검증하지 못한 것입니다.
6. `rust_test` 응답을 읽을 때는 `counts`만 보지 말고 `ranTargets`, `testedPackages`, `missingMembers`, `includedDocTests`를 함께 보세요. 실행 범위를 숨기지 않는 것이 이 도구의 존재 이유입니다.
7. `noTestsRan: true`이면 결과는 증거가 아닙니다(`ZERO_TESTS_RUN`). 필터가 모든 테스트를 걸러냈거나 필터/타깃 이름이 틀렸을 가능성을 확인하세요.
8. `docTests: false`(또는 `--tests`)는 doc test를 제외합니다. `DOCTESTS_SKIPPED`가 뜨면 의도한 것인지 확인하세요.
9. 컴파일 오류는 `rust_check`로 구조화된 진단을 받으세요. `errorCodes`(E0599 등)와 `firstFailure.firstUserFrame`이 프로젝트 파일을 가리킵니다.
10. 실패 출력이 이미 있을 때는 `rust_failure_diagnose`를 사용하세요. `~/.cargo/registry`, rustup toolchain, `library/std` 프레임은 library 위치로 분류되어 원인에서 배제됩니다. `feature_gated`는 심볼이 Cargo feature 뒤에 있다는 뜻이므로 `--all-features`로 재확인하세요.
11. feature 통합 때문에 컴파일 결과가 여러 가지가 될 수 있습니다. `features: 'all'`/`'none'`으로 재현 범위를 명시하세요.
12. `Cargo.lock`을 갱신해야 할 때는 도구가 대신 갱신하지 않습니다. `LOCKFILE_DRIFT`가 보이면 사용자가 직접 `cargo update`/`cargo metadata`를 실행해야 하며, lock이 최신이 되기 전에는 테스트 결과를 신뢰하지 마세요.
13. 작업 완료를 보고하기 전에 `rust_validation_bundle`(lock → check → test → 실행 범위 → 선언된 품질 게이트)을 실행하고 `rust_completion_evidence`로 근거를 확인하세요. `rust_tdd_checkpoint`로 프로덕션 변경에 대응하는 테스트 변경이 있는지도 확인하세요.

## 안전 규칙 (Safety)

- `rust_build`는 `target/`을 변경하므로 `mutating`으로 분류됩니다. `execute: true` 없이는 미리보기만 반환하고, 실행 시에도 대화형 확인을 요구합니다. `execute=true`를 사용자 확인 없이 반복 실행하지 마세요.
- `rust_test`는 소스를 수정하지 않지만 `target/`에 컴파일합니다. `rust_environment`/`rust_project_inspect`/`rust_test_select`/`rust_check`(미리보기)/`rust_failure_diagnose`/`rust_tdd_checkpoint`는 읽기 전용입니다.
- 다음은 되돌릴 수 없는 작업으로 취급하세요: `cargo publish`/`cargo yank`/`cargo owner`, `cargo add`/`cargo remove`(매니페스트 변경), `cargo install`, `cargo clean`(target 삭제), `rustup self uninstall`, `git push --force`, `rm -rf`.
- 도구는 `Cargo.toml`/`Cargo.lock`을 쓰지 않습니다. 매니페스트 수정은 항상 명시적인 편집 도구로 수행하세요.

## 해석 규칙 (Interpretation rules)

- `ok`는 도구의 **판정**이며 "도구가 실행됐다"는 뜻이 아닙니다. 검사 도구는 문제를 찾으면 도구 자체가 실패하지 않았어도 `ok: false`를 반환합니다. 조치 필요 여부는 `attention`으로 판단하세요: `ok: false`이거나 actionable 경고·오류가 있으면 `true`이며 `info`는 아닙니다.
- `ok: false`에는 항상 설명하는 진단이 함께 옵니다. 설명 없는 `ok: false`를 보면 도구 결함이므로 그대로 보고하세요.
- `PREVIEW_ONLY`는 실행되지 않았다는 뜻이며 통과가 아닙니다. 미리보기를 테스트 결과로 인용하지 마세요.
- `ranTargets`는 `--message-format=json`의 `compiler-artifact` 레코드에서 나온 **권위 있는** 값입니다. `Running src/lib.rs` 헤더는 어느 크레이트인지 알려주지 않으므로 헤더만으로 실행 범위를 판단하지 마세요.
- doc test는 컴파일 산출물이 아니므로 `testedPackages`/`ranTargets`에 나타나지 않습니다. doc test 포함 여부는 `includedDocTests`로 확인하세요.
- `LOCKFILE_MISSING`이 `info`이면 라이브러리 전용 워크스페이스로 정상일 수 있습니다. 바이너리를 빌드하는데도 lock이 없으면 `warning`이며, 재현 가능한 빌드를 위해 커밋을 권장하세요.
- `RESOLVE_UNAVAILABLE`는 lock이 없어 `--no-deps`로 읽었다는 뜻입니다. 이 상태에서는 적용 feature와 전체 의존 그래프가 알려지지 않습니다.
- `UNMATCHED_CHANGED_PATHS`는 변경 파일이 어떤 멤버에도 매핑되지 않았다는 뜻입니다(문서, 스크립트, 워크스페이스 밖 경로). Rust 소스 변경이 아니면 테스트 선별 대상이 아닙니다.
- `WORKSPACE_MEMBER_MISSING`은 `members` 글롭이 아무 패키지도 매칭하지 않았다는 뜻입니다. 크레이트가 조용히 워크스페이스 밖에 있을 수 있습니다.
