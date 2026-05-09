-- Align security tables created by 0028 with Prisma @map snake_case columns.
-- This migration is idempotent and only renames columns when legacy camelCase names exist.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'adminUserId'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "adminUserId" TO "admin_user_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'deviceFingerprint'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "deviceFingerprint" TO "device_fingerprint";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'deviceName'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "deviceName" TO "device_name";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'userAgent'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "userAgent" TO "user_agent";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'ipAddress'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "ipAddress" TO "ip_address";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'isActive'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "isActive" TO "is_active";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'lastSeenAt'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "lastSeenAt" TO "last_seen_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "createdAt" TO "created_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminDeviceSession' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "AdminDeviceSession" RENAME COLUMN "updatedAt" TO "updated_at";
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminMfaRecoveryCode' AND column_name = 'adminUserId'
  ) THEN
    ALTER TABLE "AdminMfaRecoveryCode" RENAME COLUMN "adminUserId" TO "admin_user_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminMfaRecoveryCode' AND column_name = 'usedAt'
  ) THEN
    ALTER TABLE "AdminMfaRecoveryCode" RENAME COLUMN "usedAt" TO "used_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AdminMfaRecoveryCode' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "AdminMfaRecoveryCode" RENAME COLUMN "createdAt" TO "created_at";
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'agenteId'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "agenteId" TO "agente_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'deviceFingerprint'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "deviceFingerprint" TO "device_fingerprint";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'deviceName'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "deviceName" TO "device_name";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'userAgent'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "userAgent" TO "user_agent";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'ipAddress'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "ipAddress" TO "ip_address";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'isActive'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "isActive" TO "is_active";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'lastSeenAt'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "lastSeenAt" TO "last_seen_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "createdAt" TO "created_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentDeviceSession' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "AgentDeviceSession" RENAME COLUMN "updatedAt" TO "updated_at";
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'adminUserId'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "adminUserId" TO "admin_user_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'agenteId'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "agenteId" TO "agente_id";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'activityType'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "activityType" TO "activity_type";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'deviceFingerprint'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "deviceFingerprint" TO "device_fingerprint";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'ipAddress'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "ipAddress" TO "ip_address";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'userAgent'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "userAgent" TO "user_agent";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'acknowledgedAt'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "acknowledgedAt" TO "acknowledged_at";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SuspiciousActivity' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "SuspiciousActivity" RENAME COLUMN "createdAt" TO "created_at";
  END IF;
END
$$;
