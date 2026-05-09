-- Add device session tracking for enhanced security
CREATE TABLE "AdminDeviceSession" (
    "id" TEXT NOT NULL,
    "admin_user_id" INTEGER NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "device_name" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminDeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminDeviceSession_admin_user_id_idx" ON "AdminDeviceSession"("admin_user_id");
CREATE INDEX "AdminDeviceSession_device_fingerprint_idx" ON "AdminDeviceSession"("device_fingerprint");

ALTER TABLE "AdminDeviceSession" ADD CONSTRAINT "AdminDeviceSession_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add MFA recovery codes for admin users
CREATE TABLE "AdminMfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "admin_user_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdminMfaRecoveryCode_admin_user_id_idx" ON "AdminMfaRecoveryCode"("admin_user_id");
CREATE UNIQUE INDEX "AdminMfaRecoveryCode_code_key" ON "AdminMfaRecoveryCode"("code");

ALTER TABLE "AdminMfaRecoveryCode" ADD CONSTRAINT "AdminMfaRecoveryCode_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add agent device sessions
CREATE TABLE "AgentDeviceSession" (
    "id" TEXT NOT NULL,
    "agente_id" INTEGER NOT NULL,
    "device_fingerprint" TEXT NOT NULL,
    "device_name" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentDeviceSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentDeviceSession_agente_id_idx" ON "AgentDeviceSession"("agente_id");
CREATE INDEX "AgentDeviceSession_device_fingerprint_idx" ON "AgentDeviceSession"("device_fingerprint");

ALTER TABLE "AgentDeviceSession" ADD CONSTRAINT "AgentDeviceSession_agente_id_fkey" FOREIGN KEY ("agente_id") REFERENCES "agentes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add suspicious activity log
CREATE TABLE "SuspiciousActivity" (
    "id" TEXT NOT NULL,
    "admin_user_id" INTEGER,
    "agente_id" INTEGER,
    "activity_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "description" TEXT,
    "device_fingerprint" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuspiciousActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SuspiciousActivity_admin_user_id_idx" ON "SuspiciousActivity"("admin_user_id");
CREATE INDEX "SuspiciousActivity_agente_id_idx" ON "SuspiciousActivity"("agente_id");
CREATE INDEX "SuspiciousActivity_created_at_idx" ON "SuspiciousActivity"("created_at");
CREATE INDEX "SuspiciousActivity_severity_idx" ON "SuspiciousActivity"("severity");
