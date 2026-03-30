-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "ptiType" TEXT;

-- AlterTable
ALTER TABLE "readings" ADD COLUMN     "firmware" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "modelId" TEXT,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "valueMax" DOUBLE PRECISION,
ADD COLUMN     "valueMin" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "alerts_ptiType_timestamp_idx" ON "alerts"("ptiType", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "readings_deviceId_modelId_timestamp_idx" ON "readings"("deviceId", "modelId", "timestamp" DESC);
