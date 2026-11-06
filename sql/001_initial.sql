-- Shared schema proposal for a new D.O.M database. Review with the auth/report author before integration.
-- Apply once to an empty database. Never drops or overwrites existing tables.
CREATE TABLE users (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  role ENUM('STUDENT','ADMIN') NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  INDEX sessions_user (user_id),
  INDEX sessions_expiry (expires_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE reports (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  reporter_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope ENUM('COMMON','ROOM') NOT NULL,
  title VARCHAR(200) NOT NULL,
  location VARCHAR(255) NOT NULL,
  room_number CHAR(3) NULL,
  facility_type ENUM('VENDING_MACHINE','WASHING_MACHINE','DRYER','SHOWER','LIGHT','OTHER') NOT NULL,
  description TEXT NOT NULL,
  status ENUM('RECEIVED','REVIEWING','REPAIRING','COMPLETED') NOT NULL DEFAULT 'RECEIVED',
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT reports_room_scope CHECK (
    (scope = 'COMMON' AND room_number IS NULL) OR
    (scope = 'ROOM' AND room_number IS NOT NULL AND REGEXP_LIKE(room_number, '^[1-9][0-9]{2}$'))
  ),
  FOREIGN KEY (reporter_id) REFERENCES users(id),
  INDEX reports_scope_created (scope, created_at, id),
  INDEX reports_scope_status_created (scope, status, created_at, id),
  INDEX reports_status_created (status, created_at, id),
  INDEX reports_created (created_at, id),
  INDEX reports_reporter_created (reporter_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE report_images (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  report_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  FOREIGN KEY (report_id) REFERENCES reports(id),
  INDEX report_images_report (report_id, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE confirmations (
  report_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  PRIMARY KEY (report_id, user_id),
  FOREIGN KEY (report_id) REFERENCES reports(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  report_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  type ENUM('REPORT_STATUS_CHANGED') NOT NULL,
  previous_status ENUM('RECEIVED','REVIEWING','REPAIRING','COMPLETED') NOT NULL,
  new_status ENUM('RECEIVED','REVIEWING','REPAIRING','COMPLETED') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  read_at DATETIME(3) NULL,
  UNIQUE KEY notifications_event_recipient (event_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (report_id) REFERENCES reports(id),
  INDEX notifications_user_created (user_id, created_at, id),
  INDEX notifications_user_read (user_id, read_at, created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
