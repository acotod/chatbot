const Redis = require('ioredis');
const logger = require('../utils/logger');

let client = null;

function getRedisClient() {
    if (client) return client;

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return null;

    try {
        client = new Redis(redisUrl, {
            lazyConnect: true,
            enableReadyCheck: false,
            maxRetriesPerRequest: 1,
        });

        client.on('error', (err) => {
            logger.warn('Redis connection error', { message: err.message });
        });
    } catch (err) {
        logger.warn('Failed to create Redis client', { message: err.message });
        client = null;
    }

    return client;
}

module.exports = { getRedisClient };
