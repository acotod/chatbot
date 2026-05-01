const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { getRedisClient } = require('../services/redis');

/**
 * Creates a per-tenant rate limiter.
 * Uses Redis store when available; falls back to in-memory.
 * Key is the tenant UUID so each tenant has its own independent bucket.
 */
function createRateLimiter() {
    const options = {
        windowMs: 60 * 1000, // 1 minute
        max: parseInt(process.env.RATE_LIMIT_PER_TENANT || '100', 10),
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => (req.tenant ? req.tenant.id : ipKeyGenerator(req)),
        handler: (_req, res) =>
            res.status(429).json({ error: 'Too many requests, please try again later.' }),
    };

    // Attach Redis store if Redis is configured
    const redis = getRedisClient();
    if (redis) {
        try {
            // rate-limit-redis v4 compatible sendCommand adapter
            options.store = {
                init() { },
                async increment(key) {
                    const results = await redis
                        .multi()
                        .incr(key)
                        .pexpire(key, options.windowMs)
                        .exec();
                    const count = results[0][1];
                    return { totalHits: count, resetTime: new Date(Date.now() + options.windowMs) };
                },
                async decrement(key) {
                    await redis.decr(key);
                },
                async resetKey(key) {
                    await redis.del(key);
                },
            };
        } catch {
            // Fall through to in-memory store
        }
    }

    return rateLimit(options);
}

module.exports = createRateLimiter;
