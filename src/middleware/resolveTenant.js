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

module.exports = resolveTenant;
