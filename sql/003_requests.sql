USE nawec_sdms;

ALTER TABLE shift_swap_request
  ADD COLUMN swap_roster_id INT NULL,   -- NULL = handover, set = exchange
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD CONSTRAINT fk_swap_roster2 FOREIGN KEY (swap_roster_id) REFERENCES duty_roster(roster_id);

ALTER TABLE leave_request
  ADD COLUMN reviewed_at DATETIME NULL;