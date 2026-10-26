CREATE DATABASE IF NOT EXISTS nawec_sdms;
USE nawec_sdms;

CREATE TABLE department (
  dept_id     INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255)
);

CREATE TABLE employee (
  emp_id      INT AUTO_INCREMENT PRIMARY KEY,
  first_name  VARCHAR(60)  NOT NULL,
  last_name   VARCHAR(60)  NOT NULL,
  position    VARCHAR(100) NOT NULL,
  email       VARCHAR(120) UNIQUE,
  phone       VARCHAR(30),
  hire_date   DATE         NOT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  dept_id     INT          NOT NULL,
  FOREIGN KEY (dept_id) REFERENCES department(dept_id)
);

CREATE TABLE user (
  user_id       INT AUTO_INCREMENT PRIMARY KEY,
  emp_id        INT NOT NULL UNIQUE,
  username      VARCHAR(60)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('EMPLOYEE','SUPERVISOR','HR_ADMIN','PLANT_MANAGER')
                NOT NULL DEFAULT 'EMPLOYEE',
  FOREIGN KEY (emp_id) REFERENCES employee(emp_id)
);

CREATE TABLE shift (
  shift_id   INT AUTO_INCREMENT PRIMARY KEY,
  shift_name VARCHAR(30) NOT NULL UNIQUE,
  start_time TIME NOT NULL,
  end_time   TIME NOT NULL
);

CREATE TABLE duty_roster (
  roster_id   INT AUTO_INCREMENT PRIMARY KEY,
  emp_id      INT  NOT NULL,
  shift_id    INT  NOT NULL,
  roster_date DATE NOT NULL,
  status      ENUM('SCHEDULED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
  FOREIGN KEY (emp_id)   REFERENCES employee(emp_id),
  FOREIGN KEY (shift_id) REFERENCES shift(shift_id),
  UNIQUE KEY uq_emp_date (emp_id, roster_date),
  INDEX idx_roster_date (roster_date)
);

CREATE TABLE attendance (
  attendance_id INT AUTO_INCREMENT PRIMARY KEY,
  roster_id     INT NOT NULL UNIQUE,
  clock_in      DATETIME NULL,
  clock_out     DATETIME NULL,
  FOREIGN KEY (roster_id) REFERENCES duty_roster(roster_id)
);

CREATE TABLE leave_request (
  leave_id    INT AUTO_INCREMENT PRIMARY KEY,
  emp_id      INT NOT NULL,
  leave_type  ENUM('ANNUAL','SICK','CASUAL','OTHER') NOT NULL,
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  reason      VARCHAR(255),
  status      ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by INT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (emp_id)      REFERENCES employee(emp_id),
  FOREIGN KEY (reviewed_by) REFERENCES user(user_id)
);

CREATE TABLE shift_swap_request (
  swap_id      INT AUTO_INCREMENT PRIMARY KEY,
  roster_id    INT NOT NULL,
  requested_by INT NOT NULL,
  swap_with    INT NOT NULL,
  status       ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by  INT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roster_id)    REFERENCES duty_roster(roster_id),
  FOREIGN KEY (requested_by) REFERENCES employee(emp_id),
  FOREIGN KEY (swap_with)    REFERENCES employee(emp_id),
  FOREIGN KEY (reviewed_by)  REFERENCES user(user_id)
);