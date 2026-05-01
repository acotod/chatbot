require('dotenv').config();
const http = require('http');
const app = require('./app');
const socketService = require('./services/socketService');
const logger = require('./utils/logger');

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer(app);
socketService.init(httpServer);

httpServer.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
