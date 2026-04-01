-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "ptiType" TEXT;

-- CreateIndex
CREATE INDEX "alerts_ptiType_timestamp_idx" ON "alerts"("ptiType", "timestamp" DESC);
