# Meta Facebook Login Compliance - Go Live Evidence

Date: 2026-05-29
Scope: Facebook Login data deletion compliance
Environment: Production URLs (admin.pmc-dev.com / api.pmc-dev.com)

## Automated Validation Results

1. Public instructions page URL
- URL: https://admin.pmc-dev.com/facebook/data-deletion
- Result: HTTP 200
- Content-Type: text/html; charset=utf-8
- Evidence: Page title and deletion instructions rendered.

2. Instructions page with confirmation code
- URL: https://admin.pmc-dev.com/facebook/data-deletion?confirmation_code=abc123XYZ
- Result: confirmation code rendered in HTML response
- Evidence markers: `CONF_CODE_RENDERED=YES`, `STATUS_SECTION=YES`

3. Data deletion callback without signed_request
- URL: POST https://api.pmc-dev.com/auth/facebook/data-deletion
- Result: HTTP 400
- Body: {"error":"signed_request is required"}
- Interpretation: Required parameter enforcement is active.

4. Data deletion callback with malformed signed_request
- URL: POST https://api.pmc-dev.com/auth/facebook/data-deletion
- Payload: signed_request=abc.def
- Result: HTTP 400
- Body: {"error":"Input buffers must have the same byte length"}
- Interpretation: Invalid signatures are rejected.

## Manual Steps Pending in Meta Dashboard

1. Open: developers.facebook.com/apps -> your app
2. Go to Facebook Login -> Settings
3. Confirm Valid OAuth Redirect URIs
4. Go to App Settings -> Basic
5. Set Data Deletion Instructions URL:
   - https://admin.pmc-dev.com/facebook/data-deletion
6. Set User Data Deletion Callback URL (if field is present):
   - https://api.pmc-dev.com/auth/facebook/data-deletion
7. Confirm Privacy Policy URL is public and HTTPS
8. Save changes and capture screenshots

## Required Screenshots for Audit

1. App Settings -> Basic (showing Data Deletion Instructions URL)
2. Facebook Login -> Settings (OAuth redirect and related settings)
3. If available, callback URL field populated
4. Public deletion instructions page open in browser

## Pass/Fail Summary

- Automated technical checks: PASS (public URL reachable, callback validation active)
- Dashboard configuration: PENDING (requires app admin session in Meta)

## Notes

- The malformed signed_request error message currently exposes a low-level crypto message. Consider returning a generic error such as `invalid signed_request` while keeping detailed logs server-side.
