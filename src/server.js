require('dotenv').config();
const http = require('http');
const app = require('./app');
const socketService = require('./services/socketService');
const logger = require('./utils/logger');

// ── Startup security checks ───────────────────────────────────────────────────
const jwtSecret = process.env.JWT_SECRET || '';
if (!jwtSecret || jwtSecret.length < 32) {
  logger.error('FATAL: JWT_SECRET must be at least 32 characters long. Aborting.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer(app);
socketService.init(httpServer);

httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
