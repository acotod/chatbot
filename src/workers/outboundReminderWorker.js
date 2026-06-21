'use strict';

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const db = require('../services/database');
const wa = require('../services/whatsapp');
const { getRedisClient } = require('../services/redis');
const { loadFlowDefinition } = require('../engine/flowLoader');
const {
  normalizeFlowAutomationMetadata,
  buildReminderContext,
  renderTemplate,
  hasReminderBeenSent,
  markReminderSent,
  isRuleDue,
  isDailySummaryDue,
  getDateKeyInTimeZone,
  getUtcDayRangeForTimeZone,
  formatDateLabel,
  getRecipientTargets,
} = require('../services/outboundFlowService');

const prisma = new PrismaClient();
const DEFAULT_POLL_MS = Number(process.env.OUTBOUND_REMINDER_POLL_MS || 60_000);
const DEFAULT_SCAN_WINDOW_MINUTES = Number(process.env.OUTBOUND_REMINDER_SCAN_WINDOW_MINUTES || 5);
const DAILY_SUMMARY_LOCK_TTL_SECONDS = Number(process.env.OUTBOUND_DAILY_SUMMARY_LOCK_TTL_SECONDS || 172800);

const inMemoryDailySummaryLock = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStatusFilter(ruleStatuses) {
  const statuses = Array.isArray(ruleStatuses) ? ruleStatuses : [];
  return statuses.length > 0 ? statuses : ['scheduled', 'rescheduled'];
}

function cleanupExpiredMemoryLocks(nowMs = Date.now()) {
  for (const [key, expiresAt] of inMemoryDailySummaryLock.entries()) {
    if (expiresAt <= nowMs) {
      inMemoryDailySummaryLock.delete(key);
    }
  }
}

async function acquireDailySummaryLock(lockKey, ttlSeconds = DAILY_SUMMARY_LOCK_TTL_SECONDS) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await redis.set(lockKey, '1', 'EX', Math.max(60, ttlSeconds), 'NX');
      return result === 'OK';
    } catch (error) {
      logger.warn({ lockKey, message: error.message }, 'outboundReminderWorker: daily summary redis lock failed');
    }
  }

  const nowMs = Date.now();
  cleanupExpiredMemoryLocks(nowMs);
  const existing = inMemoryDailySummaryLock.get(lockKey);
  if (existing && existing > nowMs) {
    return false;
  }

  inMemoryDailySummaryLock.set(lockKey, nowMs + Math.max(60, ttlSeconds) * 1000);
  return true;
}

function pickCustomerName(appointment) {
  return String(
    appointment?.metadata?.user_name
    || appointment?.metadata?.nombre
    || appointment?.metadata?.customer_name
    || appointment?.metadata?.cliente_nombre
    || appointment?.userKey
    || 'Paciente'
  ).trim();
}

function buildDailySummaryMessage({ tenantName, flowName, rule, appointments, timezone, agentName }) {
  const lines = appointments.map((appointment, index) => {
    const hour = new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone || undefined,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(appointment.startTime);
    const customer = pickCustomerName(appointment);
    const calendarName = String(appointment?.calendar?.name || '').trim();
    const suffix = calendarName ? ` - ${calendarName}` : '';
    return `${index + 1}. ${hour} ${customer}${suffix}`;
  });

  const summaryDate = formatDateLabel(appointments[0]?.startTime || new Date(), timezone);
  const context = {
    summary_date: summaryDate,
    appointments_count: String(appointments.length),
    appointments_list: lines.join('\n'),
    agent_name: String(agentName || '').trim(),
    tenant_name: String(tenantName || '').trim(),
    flow_name: String(flowName || '').trim(),
    rule_label: String(rule?.label || '').trim(),
    timezone: String(timezone || '').trim(),
  };

  return renderTemplate(rule.messageTemplate, context);
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
  const waCredentials = await db.getWaCredentials(tenant.id);
  if (!waCredentials?.phoneNumberId || !waCredentials?.accessToken) {
    logger.warn({ tenantId: tenant.id }, 'outboundReminderWorker: missing WhatsApp credentials');
    return;
  }

  for (const rule of automation.outbound_rules) {
    if (!rule.enabled) continue;

    if (rule.triggerType === 'daily_agent_summary') {
      const scanWindowMinutes = Math.max(1, DEFAULT_SCAN_WINDOW_MINUTES);
      if (!isDailySummaryDue(rule, now, scanWindowMinutes)) continue;

      const timezone = String(rule.timezone || '').trim() || 'UTC';
      const dateKey = getDateKeyInTimeZone(now, timezone);
      const statuses = normalizeStatusFilter(rule.allowedStatuses);
      const { start, end } = getUtcDayRangeForTimeZone(now, timezone);
      const appointments = await prisma.appointment.findMany({
        where: {
          tenantId: tenant.id,
          status: { in: statuses },
          startTime: { gte: start, lte: end },
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
        take: 400,
      });

      const appointmentsByAgent = new Map();

      for (const appointment of appointments) {
        const targets = getRecipientTargets(appointment);
        const agentPhone = targets.agent.phone;
        if (!agentPhone) continue;
        const agentName = targets.agent.name || appointment?.calendar?.agente?.nombre || 'Agente';
        const key = String(appointment?.calendar?.agente?.id || agentPhone);
        const current = appointmentsByAgent.get(key) || { agentPhone, agentName, appointments: [] };
        current.appointments.push(appointment);
        appointmentsByAgent.set(key, current);
      }

      for (const group of appointmentsByAgent.values()) {
        const lockKey = `outbound:daily_summary:${tenant.id}:${rule.id}:${dateKey}:${group.agentPhone}`;
        const lockAcquired = await acquireDailySummaryLock(lockKey);
        if (!lockAcquired) continue;

        const message = buildDailySummaryMessage({
          tenantName: tenant.nombre,
          flowName: flow.nombre,
          rule,
          appointments: group.appointments,
          timezone,
          agentName: group.agentName,
        });

        if (!String(message || '').trim()) continue;

        try {
          await wa.sendTextMessage(waCredentials.phoneNumberId, group.agentPhone, message, waCredentials.accessToken);
          logger.info(
            {
              tenantId: tenant.id,
              ruleId: rule.id,
              triggerType: rule.triggerType,
              recipient: 'agent',
              recipientPhone: group.agentPhone,
              appointmentsCount: group.appointments.length,
            },
            'outboundReminderWorker: daily summary sent'
          );
        } catch (error) {
          logger.error(
            {
              tenantId: tenant.id,
              ruleId: rule.id,
              triggerType: rule.triggerType,
              recipient: 'agent',
              recipientPhone: group.agentPhone,
              message: error.message,
            },
            'outboundReminderWorker: failed to send daily summary'
          );
        }
      }

      continue;
    }

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