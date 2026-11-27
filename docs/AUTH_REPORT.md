# 인증·신고 생성 API 구현 계약

담당: 김정현. 기본 경로: `/api/v1`. 기준: `__docs/split_work.md`의 업무 분담과 [신고 관리 문서](REPORT_MANAGEMENT.md)의 공통 규약(응답·오류·페이지네이션·세션 테이블).

노션 API 명세서는 이 작업 환경에서 열람하지 못했습니다. 노션 상세 페이지와 다른 부분이 있으면 리뷰에서 알려 주세요.

## 6개 API

| 메서드 | 경로 | 권한 | 성공 |
| --- | --- | --- | --- |
| POST | `/auth/sessions` | 공개 | 201 |
| POST | `/auth/sessions/me/delete` (= `DELETE /auth/sessions/current`) | 로그인 | 204 |
| GET | `/me` | STUDENT, ADMIN | 200 |
| POST | `/reports` | STUDENT | 201 |
| GET | `/me/reports` | STUDENT | 200 |
| POST | `/reports/{reportId}/images` | STUDENT(신고 작성자) | 201 |
| GET | `/report-images/{imageId}` | 신고 열람 권한 | 200 (이미지 바이너리) |

`GET /report-images/{imageId}`는 분담표 12개에 없지만, `GET /reports/{reportId}`의 `images[].url`이 가리키는 파일 경로라서 이미지 업로드 담당으로 구현했습니다.

### 인증 방식

DB 저장형 불투명 Bearer 세션입니다(신고 관리 문서의 연결 방식 1).

- 로그인하면 32바이트 무작위 토큰을 발급합니다. DB `sessions.token_hash`에는 SHA-256 해시만 저장합니다. 유효 기간은 8시간입니다.
- 클라이언트는 `Authorization: Bearer <token>`으로 보냅니다.
- 로그아웃하면 현재 세션의 `revoked_at`을 기록합니다. 같은 사용자의 다른 세션은 유지합니다.
- `src/auth.ts`에서 다음 두 가지를 export합니다.
  - `sessionResolver`: 관리 라우터(`managementRoutes`)에 연결해 두 라우터가 같은 세션 검증을 씁니다.
  - `requireAuth`: 인증 미들웨어입니다.
- 비밀번호는 bcrypt(cost 10)로 해시합니다.
- 다음 세 경우는 모두 같은 401 `INVALID_CREDENTIALS`를 돌려줍니다. 계정이 없는 경우에도 같은 비용의 해시 비교를 해서, 응답 내용이나 응답 시간으로 계정 존재 여부가 드러나지 않게 했습니다.
  - 계정이 없는 경우
  - 비밀번호가 틀린 경우
  - 로그인 정보가 없는 계정(`login_id IS NULL`)인 경우

### POST /auth/sessions

```json
{ "loginId": "student1", "password": "..." }
```

- `loginId`: 1~50자
- `password`: 1~200자이면서 UTF-8 기준 72바이트 이하. bcrypt가 72바이트를 넘는 부분을 무시하기 때문입니다. 한글은 한 글자가 3바이트라서 24자까지 허용됩니다. `npm run user:create`도 같은 바이트 제한을 적용합니다.

```json
{ "data": { "token": "…", "tokenType": "Bearer", "expiresAt": "2026-11-20T11:00:00.000Z",
  "user": { "id": "…", "role": "STUDENT", "displayName": "신고 학생" } } }
```

오류 응답:
- 본문 필드 누락, 알 수 없는 필드, 비밀번호가 UTF-8 기준 72바이트 초과: 422 `VALIDATION_ERROR`
- JSON이 아닌 본문: 415
- 인증 실패: 401 `INVALID_CREDENTIALS`

### 로그아웃

- `POST /auth/sessions/me/delete`: 신고 관리 문서에 기록된 최신 변경 경로입니다.
- `DELETE /auth/sessions/current`: 업무 분담 문서의 경로입니다.

경로 하나로 확정되면 다른 하나를 제거합니다. 둘 다 `204 No Content`를 돌려주고 본문이 없습니다. 철회한 토큰으로 요청하면 모든 API에서 401입니다.

### GET /me

```json
{ "data": { "id": "…", "role": "STUDENT", "displayName": "신고 학생" } }
```

### POST /reports

권한: STUDENT. ADMIN은 403입니다.

```json
{ "scope": "ROOM", "title": "전등 고장", "location": "2층", "roomNumber": "201",
  "facilityType": "LIGHT", "description": "불이 안 켜집니다" }
```

| 필드 | 규칙 |
| --- | --- |
| `scope` | `COMMON`(공용시설) 또는 `ROOM`(개인 호실) |
| `title` | 1~200자, 앞뒤 공백 제거 |
| `location` | 1~255자 |
| `roomNumber` | ROOM이면 필수(`^[1-9][0-9]{2}$`), COMMON이면 생략 또는 null |
| `facilityType` | `VENDING_MACHINE`, `WASHING_MACHINE`, `DRYER`, `SHOWER`, `LIGHT`, `OTHER` |
| `description` | 1~5000자 |

- `status`, `reporterId`처럼 정의되지 않은 필드는 422입니다. 상태는 항상 `RECEIVED`로 시작하고, 작성자는 세션 사용자로 정해집니다.
- 201 응답은 `GET /reports/{reportId}` 상세와 같은 필드입니다. `images`는 빈 배열입니다.

### GET /me/reports

권한: STUDENT. 쿼리: `status`, `limit`(1~100, 기본 20), `cursor`.

- 세션 사용자의 신고만 최신순으로 돌려줍니다. 공용 신고와 개인 호실 신고를 모두 포함합니다.
- 카드 필드: `id`, `scope`, `title`, `location`, `roomNumber`, `facilityType`, `status`, `sameIssueCount`, `createdAt`
- 커서는 사용자와 필터에 묶여 있어서, 다른 사용자나 다른 필터의 커서를 쓰면 400입니다.

### POST /reports/{reportId}/images

권한: 신고 작성자인 STUDENT.

권한 오류:
- 열람할 수 없는 신고(다른 학생의 개인 호실)는 존재하지 않는 신고와 같은 404입니다.
- 열람은 가능한 다른 사람의 공용 신고와, ADMIN의 업로드는 403입니다.

요청은 `multipart/form-data`이고 필드명은 `images`입니다.
- 요청당 최대 5장, 한 장당 5MB입니다.
- 신고당 총 10장까지입니다. 동시에 업로드해도 넘지 않도록 신고 행을 잠급니다.

형식 검사: Content-Type이나 확장자가 아니라 파일 시그니처로 JPEG, PNG, WEBP, GIF만 받습니다. SVG처럼 스크립트를 담을 수 있는 형식은 거부합니다.

```json
{ "data": [ { "id": "…", "reportId": "…", "contentType": "image/png", "url": "/api/v1/report-images/…" } ] }
```

오류 응답:
- multipart가 아닌 본문: 415
- 크기 초과(한 장당 5 MiB = 5,242,880바이트 초과, 정확히 5 MiB는 허용): 413
- 장수 초과 또는 다른 필드명: 400
- boundary 누락이나 잘린 본문 등 잘못된 multipart 형식: 400
- 이미지가 아니거나 이미지가 0장, 신고당 10장 초과: 422

### GET /report-images/{imageId}

- 이미지가 속한 신고와 같은 열람 권한을 적용합니다. 공용 신고는 인증 사용자 모두, 개인 호실은 작성자와 ADMIN만 볼 수 있습니다.
- 권한이 없으면 존재하지 않는 이미지와 같은 404입니다.
- 응답은 저장된 형식의 Content-Type과 `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`를 함께 보냅니다.

## 공동 스키마 변경 (리뷰 필요)

`sql/001_initial.sql` 초안에 다음 컬럼을 추가했습니다. 초안이 아직 어떤 DB에도 적용되지 않은 상태라 별도 마이그레이션 파일 대신 초안을 직접 고쳤습니다.

| 테이블 | 추가 | 이유 |
| --- | --- | --- |
| `users` | `login_id`(UNIQUE, NULL 허용), `password_hash`(NULL 허용), 둘이 함께 NULL인지 확인하는 CHECK | 로그인. 기존 시드와 테스트처럼 자격 증명 없는 사용자도 계속 넣을 수 있습니다 |
| `report_images` | `data MEDIUMBLOB NULL`, `byte_size INT UNSIGNED NOT NULL` | 이미지 본문을 DB에 저장합니다. `storage_key`는 `db:<id>`로 채웁니다 |

이미지를 나중에 외부 저장소(S3 등)로 옮기려면 `storage_key`로 파일을 읽는 조회 경로를 먼저 구현해야 합니다. 현재 `findImage()`는 `data IS NOT NULL`인 행만 조회하므로, 그 경로 없이 `data`만 NULL로 바꾸면 신고 상세의 `images[].url`은 그대로 노출되지만 해당 URL은 404를 반환합니다. 관리 API의 `images()` 조회는 BLOB 컬럼을 읽지 않으므로 상세 조회 성능에는 영향이 없습니다.

## 통합 전에 협의할 구현 선택

| 항목 | 현재 구현 |
| --- | --- |
| 로그인 식별자 | `loginId` + 비밀번호. 학교 SSO나 학번 형식은 정하지 않았습니다 |
| 회원가입 | 명세에 없어서 API를 두지 않았습니다. `npm run user:create`로 계정을 만듭니다 |
| 세션 유효 기간 | 8시간 고정, 갱신(슬라이딩) 없음 |
| 로그인 시도 제한 | 없음. 운영 전에 rate limit이 필요합니다 |
| 신고 접수 권한 | STUDENT만 가능 |
| 이미지 업로드 시점 | 신고 상태와 관계없이 작성자가 업로드 가능 |
| 로그아웃 경로 | 두 경로를 모두 지원하고, 확정되면 하나를 제거 |
