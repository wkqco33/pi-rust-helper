# pi-rust-helper (작업 예정)

공유 코어(`pi-helper-core`) 추출 + Rust 파일럿을 함께 진행하는 모노레포입니다.

> **현재 상태: 계획만 있음. 코드 없음.**

- 개발 계획: [`DEVELOPMENT-PLAN.md`](./DEVELOPMENT-PLAN.md) ← **먼저 읽으세요**
- 시작 절차: 계획 §12
- 확정이 필요한 항목: 계획 §11

## 요약

`pi-ros-helper`와 `pi-python-helper`가 동일한 envelope/runner/safety/validation/staleness를 각자 구현해 이미 드리프트가 발생했습니다(`src/core/version.ts`는 동일, `src/core/result.ts`는 분기). 그래서 확장을 더 복사하는 대신 **코어를 추출**하고, 에이전트 실패 밀도가 가장 높고 진단이 완전히 구조화된 **Rust를 파일럿**으로 삼습니다.

Rust는 `cargo metadata --format-version 1`이 권위 있는 JSON을 주므로 **Python 스캐너와 프로토콜 버전 관리가 불필요**합니다. 순수 TypeScript로 구현합니다.
