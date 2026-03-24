-- CreateTable
CREATE TABLE "forge_models" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sizeKb" DOUBLE PRECISION,
    "latencyMs" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "driftScore" DOUBLE PRECISION,
    "driftLevel" TEXT,
    "driftNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forge_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forge_jobs" (
    "id" TEXT NOT NULL,
    "jobRef" TEXT NOT NULL,
    "modelId" TEXT,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentEpoch" INTEGER NOT NULL DEFAULT 0,
    "totalEpochs" INTEGER NOT NULL DEFAULT 50,
    "eta" TEXT,
    "datasetSessions" INTEGER,
    "logs" TEXT,
    "trainLoss" DOUBLE PRECISION,
    "valLoss" DOUBLE PRECISION,
    "valAccuracy" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forge_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forge_deploys" (
    "id" TEXT NOT NULL,
    "deployRef" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "deviceIds" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "results" TEXT,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forge_deploys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forge_audit" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "label" TEXT,
    "modelRef" TEXT,
    "jobRef" TEXT,
    "deployRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forge_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forge_jobs_jobRef_key" ON "forge_jobs"("jobRef");

-- CreateIndex
CREATE INDEX "forge_jobs_status_idx" ON "forge_jobs"("status");

-- CreateIndex
CREATE INDEX "forge_jobs_createdAt_idx" ON "forge_jobs"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "forge_deploys_deployRef_key" ON "forge_deploys"("deployRef");

-- CreateIndex
CREATE INDEX "forge_deploys_deployedAt_idx" ON "forge_deploys"("deployedAt" DESC);

-- CreateIndex
CREATE INDEX "forge_audit_createdAt_idx" ON "forge_audit"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "forge_jobs" ADD CONSTRAINT "forge_jobs_modelId_fkey"
    FOREIGN KEY ("modelId") REFERENCES "forge_models"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forge_deploys" ADD CONSTRAINT "forge_deploys_modelId_fkey"
    FOREIGN KEY ("modelId") REFERENCES "forge_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
