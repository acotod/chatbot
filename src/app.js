require('dotenv').config();
const express = require('express');
const webhookRouter = require('./routes/webhook');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());

app.use('/webhook', webhookRouter);

app.use(errorHandler);

module.exports = app;
