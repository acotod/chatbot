# Phase 2: Enterprise Authentication Hardening - Implementation Guide

## Overview

Phase 2 implements enterprise-grade security features including device session tracking, suspicious activity detection, and MFA recovery codes. These features provide visibility into authentication patterns and emergency access mechanisms.

## Database Schema

### New Tables

#### `admin_device_sessions`
Tracks authenticated devices for admin users
```sql
- id: CUID (primary key)
- admin_user_id: UUID (foreign key → admin_users.id)
- device_fingerprint: VARCHAR(64) - SHA256 hash of User-Agent + IP
- device_name: VARCHAR(100) - Parsed device type (Chrome, Safari, Mobile, etc.)
- user_agent: TEXT - Full User-Agent header
- ip_address: VARCHAR(45) - IPv4 or IPv6 address
- is_active: BOOLEAN - Current session status
- last_seen_at: TIMESTAMP - Last activity on device
- created_at, updated_at: TIMESTAMP
- Indexes: (admin_user_id, device_fingerprint), (admin_user_id)
```

#### `agent_device_sessions`
Tracks authenticated devices for agent users
```sql
- id: CUID (primary key)
- agente_id: INT (foreign key → agentes.id)
- device_fingerprint: VARCHAR(64)
- device_name: VARCHAR(100)
- user_agent: TEXT
- ip_address: VARCHAR(45)
- is_active: BOOLEAN
- last_seen_at: TIMESTAMP
- created_at, updated_at: TIMESTAMP
- Indexes: (agente_id, device_fingerprint), (agente_id)
```

#### `admin_mfa_recovery_codes`
Stores one-time MFA recovery codes for admin emergency access
```sql
- id: CUID (primary key)
- admin_user_id: UUID (foreign key → admin_users.id)
- code: VARCHAR(128) - SHA256 hash of recovery code
- used: BOOLEAN - Consumption status
- used_at: TIMESTAMP - When code was used
- created_at: TIMESTAMP
- Indexes: (admin_user_id), (code, used)
```

#### `suspicious_activities`
Logs authentication anomalies and security events
```sql
- id: CUID (primary key)
- admin_user_id: UUID (nullable) - User involved
- agente_id: INT (nullable) - Agent involved
- activity_type: VARCHAR(50) - Event classification
- severity: VARCHAR(20) - low|medium|high|critical
- description: TEXT - Human-readable summary
- device_fingerprint: VARCHAR(64) - Identifying device
- ip_address: VARCHAR(45) - Source IP
- user_agent: TEXT - Client info
- metadata: JSONB - Additional context
- acknowledged_at: TIMESTAMP - Security review status
- created_at: TIMESTAMP
- Indexes: (admin_user_id, created_at), (agente_id, created_at), (severity)
```

## Backend Services

### deviceFingerprint.js

**Purpose:** Generate consistent device identifiers

```javascript
generateDeviceFingerprint(userAgent, ipAddress)
  → SHA256(userAgent|ipAddress)
  
parseDeviceNameFromUserAgent(userAgent)
  → 'Chrome Browser' | 'Safari Browser' | 'Mobile Device' | etc.
```

**Usage:** Called on every login to identify the physical/browser device

### suspiciousActivityDetection.js

**Purpose:** Monitor and log security anomalies

```javascript
logSuspiciousActivity({
  adminUserId,      // UUID or null
  agenteId,         // INT or null
  activityType,     // NEW_DEVICE_LOGIN | IMPOSSIBLE_TRAVEL | etc.
  severity,         // low | medium | high | critical
  description,      // "Agent logged in from new device"
  deviceFingerprint,
  ipAddress,
  userAgent,
  metadata          // Custom context object
})

detectNewDevice(userIdentifier, deviceFingerprint)
  → boolean (true if device is new/untrusted)

checkSuspiciousPattern(userIdentifier, hoursLookback = 24)
  → { count, highSeverityCount, criticalCount, activities[] }
```

**Activity Types:**
- `NEW_DEVICE_LOGIN` - First login from device
- `IMPOSSIBLE_TRAVEL` - Login from distant location too quickly
- `MULTIPLE_FAILED_LOGINS` - Brute force pattern
- `UNUSUAL_TIME_LOGIN` - Access outside normal hours
- `LOCATION_CHANGE` - Country/region shift detected
- `TOKEN_REUSE` - Suspicious token usage

### adminDeviceSession.js

**Purpose:** Manage admin device sessions

```javascript
storeAdminDeviceSession(adminUserId, fingerprint, name, ua, ip)
  → Creates new session or updates existing one

getAdminDeviceSessions(adminUserId)
  → DeviceSession[] (active sessions only)

revokeDeviceSession(sessionId)
  → Marks session inactive

revokeAllOtherSessions(adminUserId, currentSessionId)
  → Logout all other devices (security incident response)

isDeviceTrusted(adminUserId, deviceFingerprint)
  → boolean
```

### agentDeviceSession.js

**Purpose:** Manage agent device sessions (same interface as admin service)

### mfaRecoveryCode.js

**Purpose:** Generate and manage MFA emergency access codes

```javascript
generateRecoveryCodes(count = 8)
  → ['ABC-123-XYZ', 'DEF-456-UVW', ...] (plaintext, shown once)

storeRecoveryCodes(adminUserId, codes)
  → Saves hashed codes to database

consumeRecoveryCode(adminUserId, code)
  → boolean (validates and marks as used)

getUnusedCodeCount(adminUserId)
  → number (warning if < 3)
```

## API Endpoints

### Device Sessions Management

```
GET /device-sessions/admin
  Auth: JWT (admin)
  Response: { sessions: DeviceSession[], count: number }

POST /device-sessions/admin/:sessionId/revoke
  Auth: JWT (admin)
  Response: { success: true, message: "Device session revoked" }

GET /device-sessions/agent
  Auth: JWT (agent)
  Response: { sessions: DeviceSession[], count: number }

POST /device-sessions/agent/:sessionId/revoke
  Auth: JWT (agent)
  Response: { success: true, message: "Device session revoked" }
```

### MFA Recovery Codes

```
POST /device-sessions/mfa/generate-recovery-codes
  Auth: JWT (admin)
  Response: { 
    success: true,
    codes: ['ABC-123-XYZ', ...],  // Show only once
    expiryWarning: "..."
  }

GET /device-sessions/mfa/recovery-codes-count
  Auth: JWT (admin)
  Response: {
    unusedCodeCount: number,
    needsGeneration: boolean,
    warning: string | null
  }
```

## Frontend Integration

### Security Settings Page (Admin)

Route: `/security`

Tabs:
1. **Connected Devices** - View and revoke sessions
2. **MFA Recovery Codes** - Generate and download codes

### Security Settings Page (Agent)

Route: `/agente/security`

Features:
- View connected devices
- One-click device revocation
- Security tips and best practices

### Components

**DeviceManagement.tsx**
- Displays device list with IP, last seen, device name
- Revocation with confirmation dialog
- Loading and error states
- Auto-refresh capability

**MFARecoveryCodes.tsx**
- Shows unused code count
- One-click generation
- Copy-to-clipboard for generated codes
- Security education section
- Low-code warnings

## Authentication Flow Integration

### Admin Login

```
1. User submits credentials
2. Validate email/password
3. Generate device fingerprint: SHA256(User-Agent|IP)
4. Check if device exists and is trusted
5. If new device:
   - Create AdminDeviceSession entry
   - Log to SuspiciousActivity (severity: LOW)
6. If known device:
   - Update AdminDeviceSession.lastSeenAt
7. Issue JWT tokens
8. Audit log successful login
```

### Agent Login

```
1. User submits tenant slug + email + password
2. Validate credentials
3. Generate device fingerprint: SHA256(User-Agent|IP)
4. Check if device exists and is trusted
5. If new device:
   - Create AgentDeviceSession entry
   - Log to SuspiciousActivity (severity: LOW)
6. If known device:
   - Update AgentDeviceSession.lastSeenAt
7. Issue JWT tokens
8. Audit log successful login
```

## Security Considerations

### Device Fingerprinting
- **Stability:** User-Agent + IP combination remains consistent within office networks
- **Privacy:** Fingerprints are SHA256 hashed, not reversible
- **Limitations:** Mobile/dynamic IPs may cause false device detection
- **Mitigation:** Users can manually revoke and re-add devices

### MFA Recovery Codes
- **One-time use:** Each code consumed on use
- **Format:** 8 codes per generation (ABC-123-XYZ format)
- **Storage:** Hashed with SHA256 for database security
- **User responsibility:** Users must save codes securely
- **Regeneration:** Old codes invalidated when new ones generated

### Audit Trail
- All device operations logged to audit_logs table
- Revocation tracked with admin_user_id/agente_id
- Timestamp and IP recorded for every action

## Deployment Steps

1. **Database Migration**
   ```bash
   npx prisma migrate deploy
   ```

2. **Verify Tables Created**
   ```bash
   # Check if new tables exist in PostgreSQL
   \dt admin_device_sessions
   \dt agent_device_sessions
   \dt admin_mfa_recovery_codes
   \dt suspicious_activities
   ```

3. **Test Admin Device Tracking**
   - Login as admin from different browser
   - Navigate to /security
   - Should see new device listed

4. **Test Agent Device Tracking**
   - Login as agent from different device
   - Navigate to /agente/security
   - Should see new device listed

5. **Test MFA Recovery Codes**
   - On security settings, generate new codes
   - Verify codes display and can be copied
   - Refresh page - codes should not display again
   - Check recovery code count endpoint

## Monitoring & Maintenance

### Regular Tasks
- Review SuspiciousActivity table weekly for patterns
- Check for accounts with >5 active devices (possible compromise)
- Monitor failed_attempts patterns
- Verify rate limiting is working (5 failures → lockout)

### Alerting
- HIGH/CRITICAL suspicious activity should trigger notifications
- New admin device from unusual location/time
- Agent device from multiple IPs within seconds (impossible travel)
- Recovery codes near depletion

### Future Enhancements
- Geolocation-based impossible travel detection
- ML-based anomaly detection
- TOTP-based MFA (requires separate service)
- Push notification for device approval
- Biometric authentication on mobile

## Troubleshooting

### Device fingerprint keeps changing
**Cause:** Dynamic IP address or VPN
**Solution:** User should revoke and re-add device, or disable VPN

### Recovery codes not working
**Cause:** Code already consumed
**Solution:** Generate new set of codes

### Suspicious activity not logging
**Cause:** Service not registered in app.js
**Solution:** Verify `require('./routes/deviceSessions')` is imported

### Database migration fails
**Cause:** PostgreSQL connection issue
**Solution:** Ensure database is running: `docker compose ps postgres`
