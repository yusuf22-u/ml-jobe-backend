USE nawec_sdms;

ALTER TABLE shift ADD COLUMN min_staff INT NOT NULL DEFAULT 1;
UPDATE shift SET min_staff = 3 WHERE shift_name IN ('Morning','Afternoon','Night');