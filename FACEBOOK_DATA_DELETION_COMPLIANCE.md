# Facebook Login - Data Deletion Request Compliance

**Status:** ✅ Fully Implemented  
**Compliance Date:** May 12, 2026  
**App Name:** Zentra Bot (Admin Panel)  

---

## Requirement

> "Las apps que acceden a datos de los usuarios deben proporcionarles una manera de solicitar que se eliminen sus datos. Para cumplir con este requerimiento, tu app debe proporcionar una devolución de llamada de la solicitud de eliminación de datos o bien instrucciones para informar a las personas cómo pueden eliminar sus datos desde tu app o sitio web."

*Source: Meta Developer Docs - Facebook Login Data Deletion*

---

## Implementation Summary

We provide **BOTH** mechanisms required by Meta:

### ✅ Option 1: Data Deletion Request Callback (Automatic)

**Endpoint:** `POST /auth/facebook/data-deletion`

**Implementation Details:**
- **Location:** [src/routes/auth.js (lines 427-550)](src/routes/auth.js#L427)
- **Authentication:** HMAC-SHA256 signature verification
- **Request Format:** 
  ```
  Content-Type: application/x-www-form-urlencoded
  signed_request=<base64url_sig>.<base64url_payload>
  ```
- **Payload Processing:**
  1. Verifies HMAC-SHA256 signature using `FACEBOOK_APP_SECRET`
  2. Extracts `user_id` from Meta's signed payload
  3. Locates admin users authenticated via Facebook (`facebookId` in audit logs)
  4. Anonymizes matched accounts (email, name, password hash nullified)
  5. Revokes all refresh tokens for affected users
  6. Generates unique confirmation code
  
- **Response Format (Meta Compliant):**
  ```json
  {
    "url": "https://admin.pmc-dev.com/facebook/data-deletion?confirmation_code=...",
    "confirmation_code": "..."
  }
  ```

**Data Anonymization Details:**
- Email: `deleted-fb-{facebookUserId}-{adminUserId}@removed.invalid`
- Name: `[Deleted]`
- Password: Non-usable 32-byte random hash
- Refresh Tokens: All revoked
- Audit Trail: Logs deletion request processing

**Security:** 
- ✓ Cryptographic signature verification prevents unauthorized deletions
- ✓ Timing-safe comparison prevents timing attacks
- ✓ Transaction-based atomic updates ensure consistency

---

### ✅ Option 2: Public Data Deletion Instructions (User-Initiated)

**URL:** `https://admin.pmc-dev.com/facebook/data-deletion`

**Implementation Details:**
- **Location:** [admin/app/facebook/data-deletion/page.tsx](admin/app/facebook/data-deletion/page.tsx)
- **Access:** Publicly accessible without authentication
- **Session Guard:** Bypassed via `isPublicPage()` check in SessionSecurityGuard
- **Metadata:**
  - Title: "Eliminacion de datos de usuario"
  - Description: "Instrucciones para solicitar eliminacion de datos de usuario vinculados con Facebook Login."

**Page Contents:**

1. **Header Section:**
   - Clear title: "Eliminacion de datos de usuario"
   - Explanation of the purpose

2. **Three-Step Instructions:**
   - Step 1: Open Facebook Settings & Privacy
   - Step 2: Navigate to Apps & Websites, select this app, click Delete
   - Step 3: Facebook sends the deletion request and we show confirmation

3. **Data Deletion Details:**
   - Account delinking from Facebook
   - Session/token revocation
   - PII anonymization for authentication data

4. **Confirmation Display:**
   - Shows `confirmation_code` query parameter if provided by Meta
   - Confirms receipt of deletion request

**Accessibility:**
- ✓ No login required
- ✓ Works on all devices (responsive design)
- ✓ Clear, actionable instructions in Spanish
- ✓ Direct link provided in Facebook app settings

---

## Verification

### Backend Endpoint Verification

```bash
# Test signature verification (would need valid Meta signature)
POST /auth/facebook/data-deletion
Content-Type: application/x-www-form-urlencoded

signed_request=<meta_signed_request>
```

**Response:** HTTP 200 with `{ url: "...", confirmation_code: "..." }`

### Frontend URL Verification

```bash
curl -s https://admin.pmc-dev.com/facebook/data-deletion
# Returns: HTML page with deletion instructions (HTTP 200)

curl -s https://admin.pmc-dev.com/facebook/data-deletion?confirmation_code=abc123
# Returns: HTML page with confirmation code displayed
```

---

## Configuration

Required environment variables in `.env`:

```env
FACEBOOK_APP_SECRET=<your_facebook_app_secret>
ADMIN_BASE_URL=https://admin.pmc-dev.com
API_BASE_URL=https://api.pmc-dev.com
```

---

## Compliance Checklist

- ✅ Data deletion request callback endpoint implemented
- ✅ HMAC-SHA256 signature verification
- ✅ User identification from Facebook signed_request
- ✅ Data anonymization (not hard deletion)
- ✅ Confirmation code generation & tracking
- ✅ Response format matches Meta specification
- ✅ Public data deletion instructions page
- ✅ Clear steps for user-initiated deletion
- ✅ Accessible without authentication
- ✅ Metadata for SEO/discovery
- ✅ Security audit logging
- ✅ Transaction-based atomic operations

---

## Data Retention Policy

**For Administrative Accounts (affected by Facebook Login):**
- We **anonymize** rather than hard-delete to preserve:
  - Audit trail integrity (logs reference anonymized users)
  - Foreign key referential integrity
  - Conversation history attribution
  
**Timeline:** Immediate upon receiving Facebook's deletion request

---

## Support & Contact

For data deletion inquiries:
- **Email:** support@zentrabot.com
- **Tenant Admin Portal:** https://admin.pmc-dev.com

---

**Last Updated:** May 12, 2026  
**Status:** Production Deployment  
**Deployment Environment:** Staging (pmc-dev.com) & Production
