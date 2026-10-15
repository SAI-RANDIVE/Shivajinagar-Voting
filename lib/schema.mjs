// Database schema. Applied by scripts/seed.mjs (idempotent).
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS raw_graduate_list (
     row_no  int PRIMARY KEY,
     data    jsonb NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS raw_teacher_list (
     row_no  int PRIMARY KEY,
     data    jsonb NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS voters (
     id              text PRIMARY KEY,
     source          text NOT NULL CHECK (source IN ('graduate','teacher','both')),
     part            int,
     serial          int,
     name_en         text,
     name_mr         text,
     relative        text,
     address         text,
     pin             text,
     education       text,
     occupation      text,
     institution     text,
     age             int,
     gender          text,
     id_card         text,
     mobile          text,
     remark          text,
     teacher_part    int,
     teacher_serial  int,
     tier            int NOT NULL,
     raw_row         int
   )`,
  `CREATE INDEX IF NOT EXISTS voters_pin_idx ON voters (pin)`,
  `CREATE TABLE IF NOT EXISTS call_logs (
     id          bigserial PRIMARY KEY,
     voter_id    text NOT NULL REFERENCES voters(id),
     caller      text NOT NULL,
     status      text NOT NULL,
     note        text,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS call_logs_voter_idx ON call_logs (voter_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS call_logs_created_idx ON call_logs (created_at DESC)`,
  // Latest outcome per voter, kept in step with call_logs by the API.
  `CREATE TABLE IF NOT EXISTS voter_status (
     voter_id    text PRIMARY KEY REFERENCES voters(id),
     status      text NOT NULL,
     caller      text NOT NULL,
     note        text,
     attempts    int NOT NULL DEFAULT 1,
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
];

export const STATUSES = ['S', 'N', 'O', 'NA', 'CB', 'WN'];
