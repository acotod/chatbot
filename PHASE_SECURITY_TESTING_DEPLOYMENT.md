# Phase 2-3: Security Testing & Production Deployment

**Status:** 🔄 IN PROGRESS  
**Date Started:** May 11, 2026  
**Phase 1 (Security Hardening):** ✅ COMPLETE

---

## Overview

This guide validates the security hardening from Phase 1 and provides comprehensive production deployment procedures for WhatsApp chatbot SaaS certification.

---

## Phase 2: Security Testing & Validation

### 2.1 Local Environment Tests

#### Test 2.1.1: JWT Secret Enforcement
**Objective:** Verify JWT_SECRET is enforced and validated

```bash
# Test 1: Verify env var is required (remove JWT_SECRET)
cd /Users/andrescoto/Documents/Proyectos/Chatbot/chatbot
JWT_SECRET="" npm test 2>&1 | grep -i "FATAL\|JWT_SECRET\|aborting"
# Expected: FATAL error about JWT_SECRET length

# Test 2: Verify minimum length enforcement
JWT_SECRET="short" npm test 2>&1 | grep -i "FATAL"
# Expected: FATAL error about 32 characters

# Test 3: Verify valid secret allows startup
JWT_SECRET=$(openssl rand -base64 32) npm test 2>&1 | head -20
# Expected: Tests run, no FATAL errors
```

#### Test 2.1.2: Docker Compose Configuration
**Objective:** Verify hardened docker-compose.yml

```bash
# Verify JWT_SECRET has no fallback
grep "JWT_SECRET:" docker-compose.yml
# Expected: JWT_SECRET: ${JWT_SECRET} (without default)

# Verify env_file binding
grep "env_file:" docker-compose.yml
# Expected: env_file: - .env

# Verify .env is in .gitignore
grep "^\.env$" .gitignore
# Expected: .env (not commented out)
```

#### Test 2.1.3: Dependency Vulnerability Scan
**Objective:** Verify all npm vulnerabilities are resolved

```bash
# Backend vulnerabilities
cd /Users/andrescoto/Documents/Proyectos/Chatbot/chatbot
npm audit
# Expected: "found 0 vulnerabilities"

# Admin vulnerabilities (documented acceptable risks)
cd admin
npm audit
# Expected: 0 vulnerabilities or documented acceptable risks
```

#### Test 2.1.4: CORS Configuration
**Objective:** Verify CORS is properly configured

```bash
# Start local containers
cd /Users/andrescoto/Documents/Proyectos/Chatbot/chatbot
docker compose up -d --build api

# Test CORS preflight for allowed origin
curl -s -i -X OPTIONS http://localhost:3000/auth/login \
  -H "Origin: http://localhost:3001" \
  -H "Access-Control-Request-Method: POST" | grep -i "access-control"
# Expected: 
# - Access-Control-Allow-Origin: http://localhost:3001 (or configured origin)
# - Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
```

#### Test 2.1.5: Rate Limiting
**Objective:** Verify rate limiting is active

```bash
# Make 101+ requests to a rate-limited endpoint
for i in {1..102}; do
  curl -s http://localhost:3000/auth/login \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{}" | grep -o "status\|Too many" || echo "."
done | tail -5
# Expected: Response 429 (Too Many Requests) after limit exceeded
```

#### Test 2.1.6: Session Management
**Objective:** Verify device sessions are created and tracked

```bash
# Create a test session
curl -s -X POST http://localhost:3000/auth/facebook \
  -H "Content-Type: application/json" \
  -d "{\"accessToken\":\"test-token\"}"

# Query database for device session
docker compose exec -T postgres psql -U chatbot -d chatbot -c \
  "SELECT COUNT(*) as session_count FROM admin_device_sessions;"
# Expected: At least 1 session created
```

#### Test 2.1.7: MFA Recovery Codes
**Objective:** Verify recovery codes are generated and functional

```bash
# Generate recovery codes (requires auth)
curl -s -X POST http://localhost:3000/device-sessions/mfa/generate-recovery-codes \
  -H "Authorization: Bearer ${VALID_JWT}"

# Verify they're stored
docker compose exec -T postgres psql -U chatbot -d chatbot -c \
  "SELECT COUNT(*) as code_count FROM admin_mfa_recovery_codes WHERE used = false;"
# Expected: 10 unused recovery codes
```

#### Test 2.1.8: Database Connection Security
**Objective:** Verify database uses provided credentials

```bash
# Check DATABASE_URL in container
docker compose exec api env | grep DATABASE_URL
# Expected: postgresql://user:password@postgres:5432/chatbot

# Verify connection is encrypted (if using Prisma SSL)
docker compose exec -T postgres psql -U chatbot -d chatbot -c "SELECT version();" | grep -i "postgres"
```

---

### 2.2 Container Build Verification

#### Test 2.2.1: Container Image Scan
**Objective:** Verify containers don't contain hardcoded secrets

```bash
# Inspect API container image
docker inspect chatbot-api-1 | grep -i "JWT_SECRET\|ADMIN_API_KEY\|SECRET" || echo "✓ No hardcoded secrets found"

# Check Dockerfile for secret patterns
grep -r "ENV.*SECRET\|ENV.*PASSWORD" Dockerfile admin/Dockerfile
# Expected: Only environment variable references, no actual values
```

#### Test 2.2.2: Health Check Validation
**Objective:** Verify health checks are configured

```bash
# Check health status
docker compose ps api
# Expected: "healthy" status for api service

# View health check command
docker inspect chatbot-api-1 --format='{{json .Config.Healthcheck}}'
```

---

### 2.3 Security Best Practices Validation

#### Test 2.3.1: Secret Rotation Readiness
**Objective:** Verify secrets can be rotated without downtime

```bash
# Current secrets in .env
grep "JWT_SECRET\|ADMIN_API_KEY\|WA_VERIFY_TOKEN" .env

# Plan: New secrets can be generated and deployed without code changes:
# 1. Generate new secrets (already in .env template)
# 2. Deploy to production with new .env
# 3. API validates on startup
# Expected: ✓ Rotation possible via environment variable change
```

#### Test 2.3.2: TLS/HTTPS Readiness
**Objective:** Verify application supports HTTPS

```bash
# Check if Express app sets security headers
grep -r "helmet\|hsts\|x-frame\|x-content" src/app.js
# Expected: Security middleware configured

# Verify CORS headers are set
grep -r "Access-Control\|CORS\|cors" src/
# Expected: CORS configuration found
```

---

## Phase 3: Production Deployment

### 3.1 Pre-Deployment Checklist

#### Configuration Readiness

- [ ] **Database Configuration**
  ```bash
  # Verify production DATABASE_URL format
  echo "DATABASE_URL=postgresql://prod_user:${SECURE_PASSWORD}@prod-db-host:5432/chatbot_prod"
  ```
  
- [ ] **Redis Configuration**
  ```bash
  # Verify production REDIS_URL (with optional auth)
  echo "REDIS_URL=redis://:${REDIS_PASSWORD}@prod-redis-host:6379"
  ```

- [ ] **Domain Configuration**
  ```bash
  # Update ALLOWED_ORIGINS
  ALLOWED_ORIGINS="https://api.tu-dominio.com,https://admin.tu-dominio.com,https://agente.tu-dominio.com"
  ```

- [ ] **Meta/WhatsApp Configuration**
  ```bash
  # Verify all Meta credentials are set
  grep -E "FACEBOOK_APP_ID|FACEBOOK_APP_SECRET|WA_ACCESS_TOKEN|WA_APP_SECRET" .env
  # Expected: All values present (not placeholders)
  ```

- [ ] **Secrets Generated and Stored**
  ```bash
  # Verify secrets file is secure
  ls -la .env
  # Expected: -rw-r--r-- (readable by app, not world-readable in production)
  ```

### 3.2 Production Environment Setup

#### Step 3.2.1: Create Production .env

```bash
# Production environment variables
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Secrets (use unique production values - NOT from dev)
JWT_SECRET=${PRODUCTION_JWT_SECRET}
ADMIN_API_KEY=${PRODUCTION_ADMIN_API_KEY}
WA_VERIFY_TOKEN=${PRODUCTION_WA_VERIFY_TOKEN}

# Database (production instance)
DATABASE_URL=postgresql://prod_user:${PROD_DB_PASSWORD}@prod-db-host:5432/chatbot_prod

# Redis (production instance)
REDIS_URL=redis://:${PROD_REDIS_PASSWORD}@prod-redis-host:6379

# Domains
ALLOWED_ORIGINS=https://api.tu-dominio.com,https://admin.tu-dominio.com,https://agente.tu-dominio.com

# Meta/WhatsApp
FACEBOOK_APP_ID=${PROD_FACEBOOK_APP_ID}
FACEBOOK_APP_SECRET=${PROD_FACEBOOK_APP_SECRET}
FACEBOOK_GRAPH_VERSION=v25.0
WA_PHONE_NUMBER_ID=${PROD_PHONE_NUMBER_ID}
WA_BUSINESS_ACCOUNT_ID=${PROD_BUSINESS_ACCOUNT_ID}
WA_ACCESS_TOKEN=${PROD_WA_ACCESS_TOKEN}
WA_APP_SECRET=${PROD_WA_APP_SECRET}

# Rate Limiting
RATE_LIMIT_PER_TENANT=100
RATE_LIMIT_WINDOW_MS=60000
```

#### Step 3.2.2: SSL/TLS Certificate Setup

```bash
# Option A: Let's Encrypt with Certbot (recommended)
certbot certonly --standalone -d api.tu-dominio.com -d admin.tu-dominio.com -d agente.tu-dominio.com
# Result: Certificates in /etc/letsencrypt/live/

# Option B: Self-signed (only for testing)
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365

# Verify certificate
openssl x509 -in cert.pem -text -noout | grep -A2 "Subject\|Validity"
```

#### Step 3.2.3: Nginx/Reverse Proxy Configuration

```nginx
# /etc/nginx/sites-available/chatbot.conf
upstream api_backend {
    server localhost:3000;
}

upstream admin_frontend {
    server localhost:3001;
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name api.tu-dominio.com admin.tu-dominio.com agente.tu-dominio.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS API proxy
server {
    listen 443 ssl http2;
    server_name api.tu-dominio.com;

    ssl_certificate /etc/letsencrypt/live/api.tu-dominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.tu-dominio.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}

# HTTPS Admin proxy
server {
    listen 443 ssl http2;
    server_name admin.tu-dominio.com;

    ssl_certificate /etc/letsencrypt/live/admin.tu-dominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.tu-dominio.com/privkey.pem;

    location / {
        proxy_pass http://admin_frontend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 3.3 Database Backup & Recovery

#### Step 3.3.1: Automated Backup Script

```bash
#!/bin/bash
# /opt/chatbot/scripts/backup-database.sh

BACKUP_DIR="/opt/chatbot/backups"
DB_NAME="chatbot_prod"
DB_USER="prod_user"
DB_HOST="prod-db-host"
RETENTION_DAYS=30

mkdir -p $BACKUP_DIR

# Create backup
pg_dump -h $DB_HOST -U $DB_USER $DB_NAME | gzip > $BACKUP_DIR/db_$(date +%Y%m%d_%H%M%S).sql.gz

# Cleanup old backups
find $BACKUP_DIR -name "db_*.sql.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed at $(date)"
```

#### Step 3.3.2: Restore Procedure

```bash
# Restore from backup
gunzip < /opt/chatbot/backups/db_20260511_120000.sql.gz | \
  psql -h prod-db-host -U prod_user chatbot_prod

# Verify restore
psql -h prod-db-host -U prod_user -d chatbot_prod -c "SELECT COUNT(*) FROM mensajes;"
```

### 3.4 Monitoring & Alerting Setup

#### Step 3.4.1: Health Check Endpoints

```javascript
// GET /health - Basic liveness probe
// GET /health/detailed - Readiness with dependency checks (db, redis)
// GET /metrics - Prometheus metrics for monitoring

// Verify endpoints
curl -s http://localhost:3000/health | jq .
curl -s http://localhost:3000/health/detailed | jq .
```

#### Step 3.4.2: Logging Configuration

```javascript
// Production logging level: info
// Log format: JSON for parsing by aggregation systems
// Fields: timestamp, level, service, tenantId, userId, action, status, duration

// Example:
{"timestamp":"2026-05-11T12:00:00Z","level":"info","service":"auth","action":"login","userId":"...","status":"success","duration":234}
```

#### Step 3.4.3: Error Tracking

```bash
# Setup error tracking (e.g., Sentry)
SENTRY_DSN="https://examplePublicKey@o0.ingest.sentry.io/0"

# Test error capture
curl -X POST http://localhost:3000/sandbox/simulate/error \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"test_error\"}"

# Expected: Error logged to Sentry dashboard
```

### 3.5 Deployment Steps

#### Step 3.5.1: Production Server Pull & Build

```bash
# SSH to production server
ssh -p 51576 root@144.91.114.49

# Navigate to app
cd /opt/chatbot

# Fetch latest code
git fetch origin
git checkout main
git reset --hard origin/main

# Update .env with production values
nano .env  # (or use scp to copy production .env)

# Build and restart containers
docker compose down
docker compose up --build -d

# Run migrations
docker compose exec -T api npx prisma migrate deploy

# Verify all services are healthy
docker compose ps
```

#### Step 3.5.2: Verification

```bash
# Check logs for errors
docker compose logs api | tail -50 | grep -i "error\|fatal"

# Test endpoint
curl -s https://api.tu-dominio.com/health | jq .

# Verify database connection
docker compose exec -T postgres psql -U chatbot -d chatbot -c "SELECT COUNT(*) FROM admin_users;"

# Test JWT validation
curl -s -X GET https://api.tu-dominio.com/device-sessions/admin \
  -H "Authorization: Bearer invalid" | jq .
# Expected: 401 Unauthorized
```

---

## Phase 4: Certification Checklist

### Security Requirements

- [ ] **HTTPS/TLS**: All endpoints use HTTPS with valid certificates
- [ ] **Authentication**: JWT-based auth with 32+ character secrets
- [ ] **Data Encryption**: Database uses encrypted connections (SSL)
- [ ] **Secret Management**: Secrets stored in environment variables, not code
- [ ] **Dependency Audit**: All npm packages scanned (0 high/critical vulnerabilities)
- [ ] **Session Management**: Device tracking and session revocation implemented
- [ ] **MFA Support**: Recovery codes available for emergency access
- [ ] **Rate Limiting**: API endpoints rate-limited to prevent abuse
- [ ] **CORS**: Properly configured for authorized origins only
- [ ] **Logging**: All security events logged with timestamps and audit trails

### Meta/WhatsApp Certification

- [ ] **Webhook Validation**: All requests validated with app secret
- [ ] **HTTPS Endpoint**: Webhook URL uses HTTPS with valid cert
- [ ] **Rate Limiting**: Webhook doesn't get rate-limited during burst
- [ ] **Idempotency**: Duplicate webhooks don't cause duplicate messages
- [ ] **Error Handling**: Webhook responds quickly even if processing fails
- [ ] **Phone Numbers**: Business phone number verified in Meta
- [ ] **Access Token**: Active token with correct scopes (whatsapp_business_messaging, whatsapp_business_account_management)

### Compliance & Operations

- [ ] **Privacy Policy**: Updated to reflect data handling practices
- [ ] **Terms of Service**: Includes security and data retention policies
- [ ] **Backup Procedures**: Automated daily backups tested
- [ ] **Disaster Recovery**: RTO/RPO defined and documented
- [ ] **Monitoring**: Alerts configured for critical events
- [ ] **Support Plan**: Incident response procedures documented
- [ ] **Change Log**: Git history provides complete audit trail
- [ ] **Documentation**: Deployment and operations guides completed

---

## Summary

| Phase | Status | Key Deliverables |
|-------|--------|------------------|
| 1 | ✅ Complete | Secrets generated, config hardened, npm fixed |
| 2 | 🔄 In Progress | Security tests and validation |
| 3 | 🔄 In Progress | Production deployment procedures |
| 4 | ⏳ Pending | Certification review and sign-off |

**Next Steps:**
1. Execute Phase 2 tests to validate security configuration
2. Complete production deployment to staging environment
3. Run full E2E testing suite
4. Deploy to production with monitoring
5. Submit for Meta certification review

