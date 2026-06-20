'use strict';

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const db = require('../services/database');
const wa = require('../services/whatsapp');
const { loadFlowDefinition } = require('../engine/flowLoader');
const {
  normalizeFlowAutomationMetadata,
  buildReminderContext,
  renderTemplate,
  hasReminderBeenSent,
  markReminderSent,
  isRuleDue,
  getRecipientTargets,
} = require('../services/outboundFlowService');

const prisma = new PrismaClient();
const DEFAULT_POLL_MS = Number(process.env.OUTBOUND_REMINDER_POLL_MS || 60_000);
const DEFAULT_SCAN_WINDOW_MINUTES = Number(process.env.OUTBOUND_REMINDER_SCAN_WINDOW_MINUTES || 5);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatusFilter(ruleStatuses) {
  const statuses = Array.isArray(ruleStatuses) ? ruleStatuses : [];
  return statuses.length > 0 ? statuses : ['scheduled', 'rescheduled'];
}

async function sendReminderMessage({ tenant, flowName, appointment, rule, recipientKey, recipientPhone }) {
  if (!recipientPhone) {
    logger.info(
      { tenantId: tenant.id, appointmentId: appointment.id, ruleId: rule.id, recipient: recipientKey },
      'outboundReminderWorker: skipping recipient without phone'
    );
    return { sent: false, reason: 'missing_phone' };
  }

  if (hasReminderBeenSent(appointment, rule.id, recipientKey)) {
    return { sent: false, reason: 'already_sent' };
  }

  const waCredentials = await db.getWaCredentials(tenant.id);
  if (!waCredentials?.phoneNumberId || !waCredentials?.accessToken) {
    logger.warn({ tenantId: tenant.id }, 'outboundReminderWorker: missing WhatsApp credentials');
    return { sent: false, reason: 'missing_credentials' };
  }

  const context = buildReminderContext({
    appointment,
    rule,
    flowName,
    tenantName: tenant.nombre,
  });

  const message = renderTemplate(rule.messageTemplate, context);
  if (!String(message || '').trim()) {
    logger.warn(
      { tenantId: tenant.id, appointmentId: appointment.id, ruleId: rule.id, recipient: recipientKey },
      'outboundReminderWorker: empty reminder message after rendering'
    );
    return { sent: false, reason: 'empty_message' };
  }

  await wa.sendTextMessage(waCredentials.phoneNumberId, recipientPhone, message, waCredentials.accessToken);

  const nextMetadata = markReminderSent(appointment, rule.id, recipientKey);
  await prisma.appointment.update({
    where: { id: appointment.id },
    data: { metadata: nextMetadata },
  });

  logger.info(
    {
      tenantId: tenant.id,
      appointmentId: appointment.id,
      ruleId: rule.id,
      recipient: recipientKey,
      recipientPhone,
    },
    'outboundReminderWorker: reminder sent'
  );

  return { sent: true };
}

async function processTenant(tenant) {
  const flow = await prisma.flow.findFirst({
    where: { tenantId: tenant.id, activo: true },
    select: { id: true, nombre: true },
  });

  if (!flow) return;

  const flowDefinition = await loadFlowDefinition(tenant.id);
  if (!flowDefinition) return;

  const automation = normalizeFlowAutomationMetadata(flowDefinition.metadata);
  if (automation.flow_mode !== 'outbound' || automation.outbound_rules.length === 0) return;

  const now = new Date();

  for (const rule of automation.outbound_rules) {
    if (!rule.enabled) continue;

    const scanWindowMinutes = Math.max(1, DEFAULT_SCAN_WINDOW_MINUTES);
    const minutesBefore = Math.max(1, Number(rule.minutesBefore) || 60);
    const lowerBound = new Date(now.getTime() + (minutesBefore - scanWindowMinutes) * 60000);
    const upperBound = new Date(now.getTime() + (minutesBefore + scanWindowMinutes) * 60000);
    const statuses = normalizeStatusFilter(rule.allowedStatuses);

    const appointments = await prisma.appointment.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: statuses },
        startTime: { gte: lowerBound, lte: upperBound },
      },
      include: {
        calendar: {
          include: {
            agente: {
              select: { id: true, nombre: true, whatsapp: true, estado: true },
            },
          },
        },
      },
      orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });

    for (const appointment of appointments) {
      if (!isRuleDue(rule, appointment, now, scanWindowMinutes)) continue;

      const targets = getRecipientTargets(appointment);
      const recipientTargets = [];

      if (rule.recipients.includes('customer')) {
        recipientTargets.push({
          recipientKey: 'customer',
          recipientPhone: targets.customer.phone,
          recipientName: targets.customer.name,
        });
      }

      if (rule.recipients.includes('agent')) {
        recipientTargets.push({
          recipientKey: 'agent',
          recipientPhone: targets.agent.phone,
          recipientName: targets.agent.name,
        });
      }

      for (const recipient of recipientTargets) {
        try {
          await sendReminderMessage({
            tenant,
            flowName: flow.nombre,
            appointment,
            rule,
            recipientKey: recipient.recipientKey,
            recipientPhone: recipient.recipientPhone,
            recipientName: recipient.recipientName,
          });
        } catch (error) {
          logger.error(
            {
              tenantId: tenant.id,
              appointmentId: appointment.id,
              ruleId: rule.id,
              recipient: recipient.recipientKey,
              message: error.message,
            },
            'outboundReminderWorker: failed to send reminder'
          );
        }
      }
    }
  }
}

async function runOnce() {
  const tenants = await prisma.tenant.findMany({
    select: { id: true, nombre: true },
  });

  for (const tenant of tenants) {
    try {
      await processTenant(tenant);
    } catch (error) {
      logger.error({ tenantId: tenant.id, message: error.message }, 'outboundReminderWorker: tenant processing failed');
    }
  }
}

async function start() {
  logger.info(
    {
      pollMs: DEFAULT_POLL_MS,
      scanWindowMinutes: DEFAULT_SCAN_WINDOW_MINUTES,
    },
    'outboundReminderWorker started'
  );

  while (true) {
    try {
      await runOnce();
    } catch (error) {
      logger.error({ message: error.message }, 'outboundReminderWorker loop error');
    }

    await sleep(DEFAULT_POLL_MS);
  }
}

if (require.main === module) {
  start();
}

module.exports = {
  runOnce,
  start,
  processTenant,
  sendReminderMessage,
};