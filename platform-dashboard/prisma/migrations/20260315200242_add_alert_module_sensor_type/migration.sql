-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "alertLevel" TEXT,
ADD COLUMN     "alertModule" TEXT;

-- AlterTable
ALTER TABLE "readings" ADD COLUMN     "sensorType" TEXT,
ADD COLUMN     "value2" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "alerts_alertModule_timestamp_idx" ON "alerts"("alertModule", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "readings_deviceId_sensorType_timestamp_idx" ON "readings"("deviceId", "sensorType", "timestamp" DESC);
