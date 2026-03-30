-- AlterTable: add secondary sensor value (e.g. humidity % for TEMP module)
ALTER TABLE "readings" ADD COLUMN IF NOT EXISTS "value2" DOUBLE PRECISION;
