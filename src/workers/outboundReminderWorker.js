'use strict';

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');
const db = require('../services/database');
const wa = require('../services/whatsapp');
const { enqueueEmail } = require('../services/emailService');
const { createAppointmentReminderEmail } = require('../services/emailTemplates');
const calendarService = require('../services/calendarService');
const { getRedisClient } = require('../services/redis');
const { loadFlowDefinitionForFlow } = require('../engine/flowLoader');
const {
  normalizeFlowAutomationMetadata,
  buildReminderContext,
  renderTemplate,
  hasReminderDeliveryBeenHandled,
  hasReminderBeenSent,
  markReminderQueued,
  markReminderFailed,
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
const EMAIL_REMINDER_LOCK_TTL_SECONDS = 7 * 24 * 60 * 60;

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

async function sendReminderMessage({ tenant, flowName, flowId, flowVersionId, appointment, rule, recipientKey, recipientPhone }) {
  if (!recipientPhone) {
    logger.info(
      { tenantId: tenant.id, flowId, flowVersionId, appointmentId: appointment.id, ruleId: rule.id, recipient: recipientKey, channel: 'whatsapp', reason: 'missing_phone' },
      'outboundReminderWorker: skipping recipient without phone'
    );
    return { sent: false, reason: 'missing_phone' };
  }

  if (
    hasReminderBeenSent(appointment, rule.id, recipientKey)
    || (recipientKey === 'agent_whatsapp' && hasReminderBeenSent(appointment, rule.id, 'agent'))
  ) {
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
  appointment.metadata = nextMetadata;

  logger.info(
    {
      tenantId: tenant.id,
      flowId,
      flowVersionId,
      appointmentId: appointment.id,
      ruleId: rule.id,
      recipient: recipientKey,
      channel: 'whatsapp',
    },
    'outboundReminderWorker: reminder sent'
  );

  return { sent: true };
}

async function sendReminderEmail({ tenant, flow, flowDefinition, appointment, rule, recipientEmail, message }) {
  if (!recipientEmail) {
    logger.warn(
      { tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, recipient: 'agent', channel: 'email', reason: 'missing_agent_email' },
      'outboundReminderWorker: skipping email reminder without agent email'
    );
    return { queued: false, reason: 'missing_agent_email' };
  }

  const previousEmailState = appointment.metadata?.outbound_reminders?.[rule.id]?.agent_email;
  if (previousEmailState?.status === 'queued' && previousEmailState.email_log_id) {
    let emailLog;
    try {
      emailLog = await db.getEmailLogStatus(previousEmailState.email_log_id);
    } catch (error) {
      logger.warn(
        { tenantId: tenant.id, appointmentId: appointment.id, ruleId: rule.id, emailLogId: previousEmailState.email_log_id, message: error.message },
        'outboundReminderWorker: unable to inspect queued email reminder status'
      );
      return { queued: false, reason: 'email_status_unavailable' };
    }

    if (!emailLog) {
      const nextMetadata = markReminderFailed(appointment, rule.id, 'agent_email', previousEmailState.email_log_id);
      await prisma.appointment.update({ where: { id: appointment.id }, data: { metadata: nextMetadata } });
      appointment.metadata = nextMetadata;
      logger.error(
        { tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, emailLogId: previousEmailState.email_log_id, channel: 'email', reason: 'email_log_missing' },
        'outboundReminderWorker: queued email reminder lost its delivery record'
      );
      return { queued: false, reason: 'email_log_missing' };
    }

    if (emailLog.status === 'pending' || emailLog.status === 'retrying') {
      return { queued: false, reason: 'already_queued' };
    }

    const nextMetadata = emailLog.status === 'sent'
      ? markReminderSent(appointment, rule.id, 'agent_email', emailLog.updatedAt)
      : markReminderFailed(appointment, rule.id, 'agent_email', emailLog.id, emailLog.updatedAt);
    await prisma.appointment.update({ where: { id: appointment.id }, data: { metadata: nextMetadata } });
    appointment.metadata = nextMetadata;
    if (emailLog.status === 'sent') return { queued: false, reason: 'already_sent' };

    logger.error(
      { tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, emailLogId: emailLog.id, channel: 'email' },
      'outboundReminderWorker: email reminder exhausted retries'
    );
    return { queued: false, reason: 'delivery_failed' };
  }

  if (hasReminderDeliveryBeenHandled(appointment, rule.id, 'agent_email')) {
    return { queued: false, reason: 'already_handled' };
  }

  const redis = getRedisClient();
  const lockKey = `outbound:reminder_email:${tenant.id}:${appointment.id}:${rule.id}:agent`;
  let lockAcquired = false;
  if (redis) {
    try {
      lockAcquired = (await redis.set(lockKey, '1', 'EX', EMAIL_REMINDER_LOCK_TTL_SECONDS, 'NX')) === 'OK';
      if (!lockAcquired) return { queued: false, reason: 'already_queued' };
    } catch (error) {
      logger.warn(
        { tenantId: tenant.id, appointmentId: appointment.id, ruleId: rule.id, message: error.message },
        'outboundReminderWorker: email reminder lock unavailable'
      );
    }
  }

  let queueAccepted = false;
  try {
    const emailContent = createAppointmentReminderEmail({ message });
    const result = await enqueueEmail({
      to: recipientEmail,
      ...emailContent,
      tenantId: tenant.id,
      metadata: {
        event: 'appointment.reminder',
        flowId: flow.id,
        flowVersionId: flowDefinition.versionId,
        appointmentId: appointment.id,
        ruleId: rule.id,
        recipientRole: 'agent',
        channel: 'email',
      },
    });
    queueAccepted = Boolean(result?.ok);
    if (!queueAccepted) throw new Error('Email service did not accept the reminder');

    const nextMetadata = result.queued
      ? markReminderQueued(appointment, rule.id, 'agent_email', result.emailLogId)
      : markReminderSent(appointment, rule.id, 'agent_email');
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { metadata: nextMetadata },
    });
    appointment.metadata = nextMetadata;

    logger.info(
      {
        tenantId: tenant.id,
        flowId: flow.id,
        flowVersionId: flowDefinition.versionId,
        appointmentId: appointment.id,
        ruleId: rule.id,
        recipient: 'agent',
        channel: 'email',
        delivery: result.queued ? 'queued' : 'sent',
        emailLogId: result.emailLogId ?? null,
      },
      'outboundReminderWorker: email reminder accepted'
    );
    return { queued: true, emailLogId: result.emailLogId ?? null };
  } catch (error) {
    if (redis && lockAcquired && !queueAccepted) {
      await redis.del(lockKey).catch(() => {});
    }
    logger.error(
      { tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, recipient: 'agent', channel: 'email', message: error.message },
      'outboundReminderWorker: failed to queue email reminder'
    );
    return { queued: false, reason: 'queue_failed' };
  }
}

async function processTenant(tenant) {
  const flowConfig = await db.getConfig(tenant.id, 'outbound_reminder_flow_id');
  const configuredFlowId = Number(flowConfig?.valor?.flowId);
  if (!Number.isInteger(configuredFlowId) || configuredFlowId <= 0) {
    logger.warn({ tenantId: tenant.id }, 'outboundReminderWorker: no designated reminder flow');
    return;
  }

  const flow = await prisma.flow.findFirst({
    where: { id: configuredFlowId, tenantId: tenant.id, activo: true },
    select: { id: true, nombre: true },
  });
  if (!flow) {
    logger.warn({ tenantId: tenant.id, flowId: configuredFlowId }, 'outboundReminderWorker: designated flow is missing or inactive');
    return;
  }

  const flowDefinition = await loadFlowDefinitionForFlow(tenant.id, flow.id);
  if (!flowDefinition) {
    logger.warn({ tenantId: tenant.id, flowId: flow.id }, 'outboundReminderWorker: designated flow has no published version');
    return;
  }

  const automation = normalizeFlowAutomationMetadata(flowDefinition.metadata);
  if (automation.flow_mode !== 'outbound') {
    logger.warn({ tenantId: tenant.id, flowId: flow.id, flowVersionId: flowDefinition.versionId }, 'outboundReminderWorker: designated flow is not outbound');
    return;
  }
  if (!automation.outbound_rules.some((rule) => rule.enabled && rule.recipients.length > 0)) {
    logger.warn({ tenantId: tenant.id, flowId: flow.id, flowVersionId: flowDefinition.versionId }, 'outboundReminderWorker: no enabled outbound rules have recipients');
    return;
  }
  if (!automation.outbound_rules.some((rule) => rule.enabled && rule.triggerType === 'appointment_reminder' && rule.recipients.includes('agent'))) {
    logger.warn({ tenantId: tenant.id, flowId: flow.id, flowVersionId: flowDefinition.versionId }, 'outboundReminderWorker: no enabled appointment reminder targets the agent');
  }

  const now = new Date();

  for (const rule of automation.outbound_rules) {
    if (!rule.enabled) continue;

    if (rule.triggerType === 'daily_agent_summary') {
      const scanWindowMinutes = Math.max(1, DEFAULT_SCAN_WINDOW_MINUTES);
      if (!isDailySummaryDue(rule, now, scanWindowMinutes)) continue;
      const waCredentials = await db.getWaCredentials(tenant.id);
      if (!waCredentials?.phoneNumberId || !waCredentials?.accessToken) {
        logger.warn({ tenantId: tenant.id, flowId: flow.id, ruleId: rule.id, channel: 'whatsapp' }, 'outboundReminderWorker: missing WhatsApp credentials');
        continue;
      }

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
                select: { id: true, nombre: true, whatsapp: true, email: true, estado: true },
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
        const current = appointmentsByAgent.get(key) || { agentKey: key, agentPhone, agentName, appointments: [] };
        current.appointments.push(appointment);
        appointmentsByAgent.set(key, current);
      }

      for (const group of appointmentsByAgent.values()) {
        const lockKey = `outbound:daily_summary:${tenant.id}:${rule.id}:${dateKey}:${group.agentKey}`;
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
              flowId: flow.id,
              flowVersionId: flowDefinition.versionId,
              ruleId: rule.id,
              triggerType: rule.triggerType,
              recipient: 'agent',
              channel: 'whatsapp',
              appointmentsCount: group.appointments.length,
            },
            'outboundReminderWorker: daily summary sent'
          );
        } catch (error) {
          logger.error(
            {
              tenantId: tenant.id,
              flowId: flow.id,
              flowVersionId: flowDefinition.versionId,
              ruleId: rule.id,
              triggerType: rule.triggerType,
              recipient: 'agent',
              channel: 'whatsapp',
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
              select: { id: true, nombre: true, whatsapp: true, email: true, estado: true },
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
      if (rule.recipients.includes('customer')) {
        try {
          await sendReminderMessage({
            tenant,
            flowName: flow.nombre,
            flowId: flow.id,
            flowVersionId: flowDefinition.versionId,
            appointment,
            rule,
            recipientKey: 'customer',
            recipientPhone: targets.customer.phone,
          });
        } catch (error) {
          logger.error({ tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, recipient: 'customer', channel: 'whatsapp', message: error.message }, 'outboundReminderWorker: failed to send reminder');
        }
      }

      if (rule.recipients.includes('agent')) {
        let message = '';
        try {
          const context = buildReminderContext({ appointment, rule, flowName: flow.nombre, tenantName: tenant.nombre });
          message = renderTemplate(rule.messageTemplate, context);
          await sendReminderMessage({
            tenant,
            flowName: flow.nombre,
            flowId: flow.id,
            flowVersionId: flowDefinition.versionId,
            appointment,
            rule,
            recipientKey: 'agent_whatsapp',
            recipientPhone: targets.agent.phone,
          });
        } catch (error) {
          logger.error({ tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, recipient: 'agent', channel: 'whatsapp', message: error.message }, 'outboundReminderWorker: failed to send reminder');
        }

        try {
          if (!message) {
            const context = buildReminderContext({ appointment, rule, flowName: flow.nombre, tenantName: tenant.nombre });
            message = renderTemplate(rule.messageTemplate, context);
          }
          await sendReminderEmail({
            tenant,
            flow,
            flowDefinition,
            appointment,
            rule,
            recipientEmail: targets.agent.email,
            message,
          });
        } catch (error) {
          logger.error({ tenantId: tenant.id, flowId: flow.id, appointmentId: appointment.id, ruleId: rule.id, recipient: 'agent', channel: 'email', message: error.message }, 'outboundReminderWorker: failed to send reminder');
        }
      }
    }
  }
}

async function runOnce() {
  try {
    const { scanned, reconciled } = await calendarService.reconcileOrphanedGoogleEvents();
    if (reconciled > 0) {
      logger.info({ scanned, reconciled }, 'outboundReminderWorker: reconciled orphaned Google Calendar events');
    }
  } catch (error) {
    logger.error({ message: error.message }, 'outboundReminderWorker: google reconciliation failed');
  }

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
  sendReminderEmail,
};