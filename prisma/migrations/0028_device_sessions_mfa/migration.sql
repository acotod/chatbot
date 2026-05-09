-- Add device session tracking for enhanced security
CREATE TABLE "AdminDeviceSession" (
    "id" TEXT NOT NULL,
    "adminUserId" INTEGER NOT NULL,
    "deviceFingerprint" TEXT NOT NULL,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminDeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminDeviceSession_adminUserId_idx" ON "AdminDeviceSession"("adminUserId");
CREATE INDEX "AdminDeviceSession_deviceFingerprint_idx" ON "AdminDeviceSession"("deviceFingerprint");

ALTER TABLE "AdminDeviceSession" ADD CONSTRAINT "AdminDeviceSession_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add MFA recovery codes for admin users
CREATE TABLE "AdminMfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "adminUserId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminMfaRecoveryCode_adminUserId_idx" ON "AdminMfaRecoveryCode"("adminUserId");
CREATE UNIQUE INDEX "AdminMfaRecoveryCode_code_key" ON "AdminMfaRecoveryCode"("code");

ALTER TABLE "AdminMfaRecoveryCode" ADD CONSTRAINT "AdminMfaRecoveryCode_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add agent device sessions
CREATE TABLE "AgentDeviceSession" (
    "id" TEXT NOT NULL,
    "agenteId" INTEGER NOT NULL,
    "deviceFingerprint" TEXT NOT NULL,
    "deviceName" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentDeviceSession_agenteId_idx" ON "AgentDeviceSession"("agenteId");
CREATE INDEX "AgentDeviceSession_deviceFingerprint_idx" ON "AgentDeviceSession"("deviceFingerprint");

ALTER TABLE "AgentDeviceSession" ADD CONSTRAINT "AgentDeviceSession_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "agentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add suspicious activity log
CREATE TABLE "SuspiciousActivity" (
    "id" TEXT NOT NULL,
    "adminUserId" INTEGER,
    "agenteId" INTEGER,
    "activityType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "description" TEXT,
    "deviceFingerprint" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuspiciousActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SuspiciousActivity_adminUserId_idx" ON "SuspiciousActivity"("adminUserId");
CREATE INDEX "SuspiciousActivity_agenteId_idx" ON "SuspiciousActivity"("agenteId");
CREATE INDEX "SuspiciousActivity_createdAt_idx" ON "SuspiciousActivity"("createdAt");
CREATE INDEX "SuspiciousActivity_severity_idx" ON "SuspiciousActivity"("severity");
