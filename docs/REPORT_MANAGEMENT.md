# 신고 조회·관리 API 구현 계약

기준: [노션 API 명세서](https://app.notion.com/p/API-3ffcaf3badd280829e5ce41711c99be9), 2026-11-06 재검토. 담당: 유건우. 기본 경로: `/api/v1`.

## 2026-11-06 명세 재검토 기록

기존 명세의 공통 규약·데이터 모델·상태 변경·오류·DB 수용 조건과 아래 6개 상세 페이지를 다시 열어 비교했습니다. 현재 열람된 상세 페이지에는 모두 `2026-11-04 정리`가 표시되며, 담당 6개 API의 기존 계약 대비 경로·요청·응답·권한 변경은 확인되지 않았습니다. 이후 사용자가 전달한 2026-11-04 협업 대화의 로그아웃 경로 변경 요청을 아래 인증 연결 계약에 반영했습니다. 담당 6개 API 동작과 DB 스키마에는 변경이 없습니다.

| API | 확인한 상세 페이지 |
| --- | --- |
| GET /reports | [공용시설 신고 목록](https://app.notion.com/p/400caf3badd281e59b15e01af9b15de1) |
| GET /reports/{reportId} | [신고 상세 조회](https://app.notion.com/p/400caf3badd28169b67fd0e74425be88) |
| GET /admin/reports | [관리자 전체 신고 조회](https://app.notion.com/p/400caf3badd2811ba6caceb04e933339) |
| PATCH /admin/reports/{reportId}/status | [신고 처리 상태 변경](https://app.notion.com/p/400caf3badd2813dbf33e55caf2d9a90) |
| POST /reports/{reportId}/confirmations | [같은 문제 표시](https://app.notion.com/p/400caf3badd28137ad5cc87bf4028245) |
| GET /me/notifications | [상태 변경 알림 조회](https://app.notion.com/p/400caf3badd2817ca7b6c81db6c7511a) |

## 인증 연결

현재 기본 구현은 `Authorization: Bearer <불투명 세션 토큰>`을 받습니다. 토큰의 SHA-256 해시로 `sessions`를 조회하고, 만료·철회 여부 및 `users.role`을 매 요청 검사합니다. 사용자 ID·권한은 본문이나 사용자 지정 헤더로 받지 않습니다. JWT를 자체 디코딩해 신뢰하는 구현도 아닙니다.

로그인 발급 방식은 노션에서 미확정이고 김정현 담당이므로, 기본 세션 조회는 통합용 구현 선택입니다. 다음 중 한 방식으로 연결합니다.

1. 로그인에서 충분히 무작위인 토큰을 발급하고 `sessions(token_hash, user_id, expires_at, revoked_at)`에 저장합니다. 클라이언트는 원문 토큰을 Bearer로 보냅니다. 토큰을 갱신할 때 DB 만료값도 함께 갱신하고, 로그아웃 시 철회합니다.
2. 기존 인증 미들웨어를 사용한다면 `createApp(repository, resolveSession)`의 두 번째 인수에 **서버가 검증한** `{ id, role }`을 반환하는 함수를 연결합니다. 쿠키 인증이면 해당 인증 모듈에서 SameSite·CSRF 정책도 적용합니다.

기본 구현은 세션 발급 엔드포인트를 제공하지 않습니다. 독립 개발은 `npm run db:seed`로 가능합니다. 회원 비밀번호·학교 SSO 방식은 이 작업에서 정하지 않았습니다.

### 로그아웃 경로 변경

사용자가 전달한 협업 대화의 마지막 변경 요청을 기준으로 로그아웃 연동 경로를 **`POST /auth/sessions/me/delete`**로 반영합니다. 기본 경로를 포함하면 `POST /api/v1/auth/sessions/me/delete`입니다. 기존 `DELETE /auth/sessions/current`를 대체하며, 중간에 제안된 `POST /auth/sessions/me`는 사용하지 않습니다. 이는 사용자가 전달한 변경 요청에 따른 기록이며, 열람한 노션에 반영된 내용으로 확인된 것은 아닙니다.

담당은 김정현이며 이 브랜치에서는 로그아웃 라우트를 구현하지 않습니다. 연결할 로그아웃 모듈은 현재 인증 세션을 철회해야 하며, 관리 API는 이후 해당 세션으로 보낸 요청에 401을 반환합니다. 이번 전달 내용은 메서드·경로 변경이므로 기존 성공 응답 `204 No Content`를 유지하는 것으로 기록합니다. 요청 본문이나 별도 응답 JSON은 추가하지 않습니다.

## 응답 및 검증

성공은 `{ "data": ... }`, 목록은 `{ "data": [], "page": { "nextCursor": null, "hasMore": false } }`입니다. 오류는 `{ "error": { "code": "...", "message": "...", "details": [] } }`이며 `details`는 검증 실패 때만 포함합니다. 추적 ID는 `X-Request-Id` 응답 헤더에 있습니다.

JSON 문법·경로·쿼리 오류 400, 인증 실패 401, 작업 권한 부족 403, 존재하지 않거나 열람할 수 없는 신고 404, 트랜잭션 잠금 경합 409, 큰 JSON 413, 잘못된 미디어 유형 415, 상태 본문 의미 검증 실패 422를 반환합니다. 알 수 없는 쿼리·상태 변경 본문 필드도 거부합니다.

식별자는 UUID 또는 예시 ID를 모두 수용하는 영문·숫자·`_`·`-` 1~64자입니다. 일시는 ISO 8601 UTC입니다. 응답에는 `Cache-Control: private, no-store`가 적용됩니다. 요청 로그는 경로 템플릿·메서드·상태·인증 여부·추적 ID만 남깁니다.

## 6개 API

### GET /reports

권한: STUDENT, ADMIN. 쿼리: `status`, `limit`, `cursor`. 공용시설만 조회하며 개인 호실은 필터·페이지에도 들어가지 않습니다.

카드 필드: `id`, `scope`, `title`, `location`, `facilityType`, `status`, `sameIssueCount`, `createdAt`. 신고자 ID·호실·설명·첨부는 공용 목록에 반환하지 않습니다.

### GET /reports/{reportId}

공용 신고는 인증 사용자에게 공개합니다. 개인 호실은 원 작성자 또는 ADMIN만 조회하며 다른 학생에게는 존재하지 않는 신고와 동일한 404를 반환합니다.

카드 필드에 `roomNumber`, `description`, `isConfirmedByMe`, `updatedAt`, `images`를 추가합니다. `reporterId`는 본인 또는 ADMIN에게만 제공합니다. 이미지 메타데이터는 신고 권한 검사 후 조회하고 내부 저장 키는 반환하지 않습니다.

`images[].url`은 노션 예시의 `/api/v1/report-images/{id}` 형식을 따릅니다. **해당 파일 조회 경로와 실제 업로드는 아직 별도 담당자의 연동이 필요합니다.** 이미지 제공 시에도 같은 신고 권한 검사가 필요합니다.

### GET /admin/reports

권한: ADMIN. 쿼리: `scope=COMMON|ROOM`, `status`, `limit`, `cursor`, `sort`.

정렬: `createdAt_desc`(기본), `createdAt_asc`, `sameIssueCount_desc`. 동률은 생성 시각·ID로 정렬합니다. 응답 카드 필드는 노션 관리자 예시의 `id`, `scope`, `roomNumber`, `location`, `facilityType`, `status`, `sameIssueCount`, `createdAt`입니다.

### PATCH /admin/reports/{reportId}/status

권한: ADMIN. `Content-Type: application/json`.

```json
{ "status": "REPAIRING" }
```

상태: `RECEIVED`, `REVIEWING`, `REPAIRING`, `COMPLETED`. 결과는 `data.id`, `data.status`, `data.updatedAt`입니다.

신고 행을 잠근 뒤 상태와 대상별 인앱 알림을 하나의 트랜잭션으로 저장합니다. 알림 저장 실패 시 상태 변경도 취소합니다. 원 신고자와 확인 학생을 합집합으로 처리해 한 사람에게 한 이벤트가 중복 저장되지 않습니다. 동일한 상태의 반복 요청은 수정 시각을 변경하거나 추가 알림을 만들지 않습니다.

### POST /reports/{reportId}/confirmations

권한: STUDENT. 본문 없음(빈 JSON 객체도 허용). 공용 신고에만 사용할 수 있으며 최초 등록은 201, 재요청은 200입니다.

```json
{ "data": { "reportId": "rpt_example_1", "isConfirmedByMe": true, "sameIssueCount": 3 } }
```

`(report_id, user_id)` 복합 기본키와 신고 행 잠금으로 중복·동시 요청을 처리합니다. 수는 별도의 변경 가능한 카운터 대신 `confirmations` 집계에서 계산합니다. 권한 없는 개인 호실은 404, 본인 개인 호실이나 본인 공용 신고 표시는 403입니다.

### GET /me/notifications

권한: STUDENT(2026-11-04 개별 명세 기준). 쿼리: `cursor`, `limit`, `unreadOnly=true|false`. 세션 사용자 본인의 알림만 조회합니다.

알림 필드: `id`, `reportId`, `type=REPORT_STATUS_CHANGED`, `previousStatus`, `newStatus`, `createdAt`, `read`. 최신순이며 현재 열람할 수 없는 개인 호실 신고의 알림도 반환하지 않습니다. 읽음 처리 API는 명세에 없어 추가하지 않았습니다.

## 페이지네이션

기본 `limit=20`, 범위 1~100입니다. 커서는 서버가 만든 불투명 문자열로 취급합니다. 정렬·필터·API 종류에 묶이며 알림 커서는 사용자에도 묶입니다. 잘못되거나 다른 필터에서 발급된 커서는 400입니다. 마지막 페이지의 `nextCursor`는 null입니다.

커서는 권한을 부여하지 않습니다. 매 요청 DB에서 공개 범위와 사용자 조건을 다시 적용합니다. 목록 조회 도중 상태나 동일 문제 수가 변경되면 해당 정렬 결과도 바뀔 수 있으며, 페이지 전체를 시점 고정한 스냅샷을 제공하지는 않습니다.

## 통합 전에 협의할 구현 선택

노션에 미확정으로 남은 정책은 다음과 같이 구현했습니다. 프로젝트의 최종 합의로 확정된 정책이라는 의미는 아닙니다.

| 항목 | 현재 구현 |
| --- | --- |
| 인증 방식 | DB 저장형 불투명 Bearer 세션, 교체 가능한 세션 resolver |
| 본인 신고에 같은 문제 표시 | 금지. 원 신고자는 동일 문제 수에서 제외 |
| 완료 신고에 같은 문제 표시 | 허용. 명세에 없는 추가 상태 제한을 두지 않음 |
| 상태 전이 | 네 상태 사이 직접 변경 허용. 같은 상태 요청은 변경 없음 |
| 알림 채널 | DB에 인앱 목록 저장. 푸시·메일 발송 없음 |
| 커서 크기 | 기본 20, 최대 100 |
| 공통 DB | `sql/001_initial.sql`의 신규 DB용 초안. 공동 검토 후 적용 |

## 테스트 범위

`npm test`: JSON 오류·요청 크기·공통 보안 헤더·6개 API 인증 요구.

`npm run test:integration`: 설치된 MySQL을 이용한 독립 임시 인스턴스에서 권한과 개인 호실 비공개, 세션 만료·철회, 필터·정렬·커서 검증, 중복 확인 동시성, 상태 저장과 알림 대상, 중복 알림 방지, 알림 실패 시 롤백, 알림 목록의 사용자 분리를 검증합니다.
