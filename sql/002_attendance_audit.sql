USE nawec_sdms;

ALTER TABLE attendance
  ADD COLUMN method ENUM('SELF','MANUAL') NOT NULL DEFAULT 'SELF',
  ADD COLUMN recorded_by INT NULL,
  ADD CONSTRAINT fk_att_recorder FOREIGN KEY (recorded_by) REFERENCES user(user_id);