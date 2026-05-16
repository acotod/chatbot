const db = require('../services/database');

/**
 * Resolves the tenant from the x-api-key request header.
 * Attaches `req.tenant` on success.
 */
async function resolveTenant(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ error: 'Missing x-api-key header' });
    }

    const tenant = await db.findTenantByApiKey(apiKey);

    if (!tenant) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

    if (!tenant.activo) {
        return res.status(403).json({ error: 'Tenant is inactive' });
    }

    req.tenant = tenant;
    next();
}

/**
 * Resolves the tenant from either:
 *   1. x-api-key header (existing behaviour)
 *   2. `key` query-string parameter (used by Meta Flows / external webhooks
 *      where the caller cannot set custom headers)
 *
 * Webhook URL format: https://api.example.com/webhook?key=<tenant-api-key>
 */
async function resolveTenantByKey(req, res, next) {
    const apiKey = req.headers['x-api-key'] || req.query.key;

    if (!apiKey) {
        return res.status(401).json({ error: 'Missing x-api-key header' });
    }

    try {
        const tenant = await db.findTenantByApiKey(apiKey);

        if (!tenant) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        if (!tenant.activo) {
            return res.status(403).json({ error: 'Tenant is inactive' });
        }

        req.tenant = tenant;
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = resolveTenant;
module.exports.resolveTenantByKey = resolveTenantByKey;
