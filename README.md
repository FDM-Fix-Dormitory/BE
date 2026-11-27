# D.O.M 백엔드

TypeScript · Express 5 · MySQL 8.0.16 이상. 작업 브랜치: `feature/auth-report`(김정현), `codex/report-management`(유건우).

[노션 API 명세서](https://app.notion.com/p/API-3ffcaf3badd280829e5ce41711c99be9)의 v1 설계안을 기준으로 **12개 API**를 구현했습니다. 세부 계약은 [인증·신고 생성 문서](docs/AUTH_REPORT.md)(김정현)와 [신고 관리 문서](docs/REPORT_MANAGEMENT.md)(유건우)에 있습니다.

## 구현 범위

모든 경로 앞에 `/api/v1`을 붙입니다. 로그인을 제외한 모든 API는 `Authorization: Bearer <token>` 인증이 필요합니다.

| 메서드 | 경로 | 권한 | 기능 |
| --- | --- | --- | --- |
| POST | `/auth/sessions` | 공개 | 로그인, Bearer 세션 토큰 발급 |
| POST | `/auth/sessions/me/delete` | 로그인 | 로그아웃(현재 세션 철회). `DELETE /auth/sessions/current`도 지원 |
| GET | `/me` | STUDENT, ADMIN | 로그인 사용자 정보 |
| POST | `/reports` | STUDENT | 고장 신고 접수 |
| GET | `/me/reports` | STUDENT | 내 신고 목록, 상태 필터, 커서 페이지네이션 |
| POST | `/reports/{reportId}/images` | STUDENT(작성자) | 고장 사진 업로드(DB 저장) |
| GET | `/report-images/{imageId}` | 신고 열람 권한 | 사진 파일 조회 |
| GET | `/reports` | STUDENT, ADMIN | 공용시설 목록, 상태 필터, 커서 페이지네이션 |
| GET | `/reports/{reportId}` | STUDENT, ADMIN | 상세 조회, 개인 호실은 작성자·관리자만 |
| GET | `/admin/reports` | ADMIN | 전체 목록, 범위·상태 필터, 최신·오래된·동일 문제 많은 순 |
| PATCH | `/admin/reports/{reportId}/status` | ADMIN | 상태 변경 및 대상별 알림 저장 |
| POST | `/reports/{reportId}/confirmations` | STUDENT | 최초 201, 반복 200, 동시 중복 방지 |
| GET | `/me/notifications` | STUDENT | 본인 알림 목록, 미읽음 필터, 커서 페이지네이션 |

## 실행

Node.js 24 이상을 사용합니다.

```powershell
npm ci
Copy-Item .env.example .env
```

`.env`에 **새 개발용 MySQL 데이터베이스** 접속 정보를 입력합니다. 기존 MySQL을 사용하면 DB와 사용자를 별도로 생성합니다. Docker를 사용한다면 `DB_PASSWORD`, `MYSQL_ROOT_PASSWORD`를 변경하고 다음을 실행합니다. 로컬 MySQL이 3306을 사용 중이면 `DB_PORT=3307` 등 비어 있는 포트를 지정합니다.

```powershell
docker compose up -d mysql
```

MySQL 준비 후 초기 스키마를 적용합니다. `db:migrate`는 비어 있는 DB에만 실행되며, 공동 스키마 초안은 김정현 담당자와 통합 전에 검토해야 합니다. 기존 DB에는 자동 적용하지 않았습니다.

```powershell
npm run db:migrate
npm run db:seed
npm run dev
```

MySQL은 `CREATE TABLE`마다 암묵적으로 커밋하므로, 마이그레이션이 중간에 실패하면 앞에서 만든 테이블이 남고 다음 실행은 빈 DB 검사에서 멈춥니다. 초기 적용이 실패하면 오류 원인을 고친 뒤 **해당 DB에 보존할 데이터가 없는지 확인하고** DB를 다시 만든 다음 `db:migrate`를 처음부터 실행하세요.

```sql
DROP DATABASE <DB 이름>;
CREATE DATABASE <DB 이름> CHARACTER SET utf8mb4;
```

선택 명령인 `db:seed`는 개발용 학생 2명(`student1`, `student2`)·관리자 1명(`admin`)·공용 신고 1건과 8시간 세션을 추가하고, 무작위 비밀번호·토큰과 신고 ID를 출력합니다. 기존 데이터를 덮어쓰지 않습니다. `NODE_ENV=development`에서만 실행할 수 있습니다.

계정을 직접 만들 때는 다음을 실행하고 비밀번호를 입력합니다.

```powershell
npm run user:create -- student3 "새 학생" STUDENT
```

로그인해 토큰을 받습니다.

```powershell
$login = Invoke-RestMethod http://localhost:3000/api/v1/auth/sessions -Method Post -ContentType 'application/json' -Body '{"loginId":"student1","password":"<출력된 비밀번호>"}'
$headers = @{ Authorization = "Bearer $($login.data.token)" }
Invoke-RestMethod http://localhost:3000/api/v1/me -Headers $headers
```

서버 주소는 `http://localhost:3000`입니다. 출력된 **확인 학생** 토큰을 넣어 조회·같은 문제 표시·알림을 테스트하고, 관리자 토큰으로 상태를 변경합니다.

```powershell
$studentToken = '<확인 학생 토큰>'
$headers = @{ Authorization = "Bearer $studentToken" }
Invoke-RestMethod http://localhost:3000/api/v1/reports -Headers $headers
```

빌드 및 실행:

```powershell
npm run build
npm start
```

## 검증

```powershell
npm run typecheck
npm test
npm run test:integration
```

통합 테스트는 설치된 `mysqld`로 **별도 프로세스·임시 데이터 디렉터리·임의 로컬 포트**를 생성합니다. 기존 MySQL 서비스와 DB에는 접속하지 않고 종료 후 정리합니다. 기본 실행 파일은 `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe`입니다. 경로가 다르면 `MYSQLD_PATH` 환경변수로 지정합니다.

```powershell
$env:MYSQLD_PATH = 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe'
npm run test:integration
```

검증 항목: 로그인·로그아웃(두 경로), 토큰 해시 저장, 신고 접수 입력 검증, 내 신고 격리·커서, 이미지 시그니처·크기·장수 제한·열람 권한, 인증 만료·철회, 역할별 권한, 개인 호실 비공개, 입력 오류, 필터·정렬·커서, 동시 중복 확인, 상태·알림 트랜잭션 롤백, 본인 알림 격리.

## 구조 및 협업

- `src/auth-report-routes.ts`: 인증·신고 생성·이미지 HTTP 계약(김정현)
- `src/auth-report-repository.ts`: 세션·사용자·신고 생성·이미지 MySQL 저장
- `src/auth.ts`: 인증 미들웨어와 공용 세션 resolver
- `src/routes.ts`: HTTP 계약·입력 검증·응답 필드·인증 연결
- `src/repository.ts`: MySQL 조회·행 잠금·상태와 알림 트랜잭션
- `src/domain.ts`: 공통 타입·권한·공개 응답 모델
- `src/pagination.ts`: 커서 검증과 목록 페이지네이션
- `sql/001_initial.sql`: 6개 공통 테이블 초안

공통 테이블은 `users`, `sessions`, `reports`, `report_images`, `confirmations`, `notifications`입니다. DB 변경은 협의하고, 기능 PR 작성 후 상호 리뷰 및 통합 테스트를 진행합니다.
