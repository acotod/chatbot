'use strict';

const DEFAULT_FLOW_MODE = 'inbound';
const DEFAULT_MESSAGE = 'Recordatorio: tu cita es el {{appointment_start_label}}.';
const DEFAULT_DAILY_SUMMARY_MESSAGE = 'Resumen de citas de hoy ({{summary_date}})\nTotal: {{appointments_count}}\n{{appointments_list}}';
const DEFAULT_DAILY_SUMMARY_TIME = '07:00';
const WEEKDAY_INDEX = Object.freeze({
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFlowMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'outbound' ? 'outbound' : DEFAULT_FLOW_MODE;
}

function normalizeTriggerType(value) {
  return String(value ?? '').trim().toLowerCase() === 'daily_agent_summary'
    ? 'daily_agent_summary'
    : 'appointment_reminder';
}

function normalizeTimeString(value) {
  const raw = String(value ?? '').trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(raw) ? raw : '';
}

function normalizeRecipientList(value) {
  const recipients = asArray(value)
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((item) => item === 'customer' || item === 'agent');

  return Array.from(new Set(recipients));
}

function normalizeStatusList(value) {
  const statuses = asArray(value)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);

  return Array.from(new Set(statuses.length > 0 ? statuses : ['scheduled', 'rescheduled']));
}

function normalizeWeekdayList(value) {
  return asArray(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
}

function normalizeOutboundRule(raw, index = 0) {
  const record = asObject(raw);
  const ruleId = String(record.id ?? record.rule_id ?? `rule_${index + 1}`).trim() || `rule_${index + 1}`;
  const minutesBefore = Math.max(1, Math.trunc(Number(record.minutesBefore ?? record.minutes_before ?? 60) || 60));
  const triggerType = normalizeTriggerType(record.triggerType ?? record.trigger_type);
  const normalizedRecipients = normalizeRecipientList(record.recipients);
  const recipients = triggerType === 'daily_agent_summary'
    ? ['agent']
    : normalizedRecipients;
  const fallbackMessage = triggerType === 'daily_agent_summary' ? DEFAULT_DAILY_SUMMARY_MESSAGE : DEFAULT_MESSAGE;

  return {
    id: ruleId,
    label: String(record.label ?? `Recordatorio ${index + 1}`).trim() || `Recordatorio ${index + 1}`,
    enabled: record.enabled === undefined ? true : Boolean(record.enabled),
    triggerType,
    minutesBefore,
    summaryTime: normalizeTimeString(record.summaryTime ?? record.summary_time) || DEFAULT_DAILY_SUMMARY_TIME,
    recipients,
    allowedStatuses: normalizeStatusList(record.allowedStatuses ?? record.allowed_statuses),
    daysOfWeek: normalizeWeekdayList(record.daysOfWeek ?? record.days_of_week),
    timeWindowStart: normalizeTimeString(record.timeWindowStart ?? record.time_window_start),
    timeWindowEnd: normalizeTimeString(record.timeWindowEnd ?? record.time_window_end),
    timezone: String(record.timezone ?? '').trim(),
    messageTemplate: String(record.messageTemplate ?? record.message_template ?? '').trim() || fallbackMessage,
  };
}

function normalizeOutboundRules(value) {
  return asArray(value)
    .map((rule, index) => normalizeOutboundRule(rule, index))
    .filter((rule) => Boolean(rule.id));
}

function normalizeFlowAutomationMetadata(metadata) {
  const record = asObject(metadata);
  return {
    flow_mode: normalizeFlowMode(record.flow_mode ?? record.direction),
    outbound_rules: normalizeOutboundRules(record.outbound_rules),
    reminder_timezone: String(record.reminder_timezone ?? '').trim(),
  };
}

function normalizePhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^\d+]/g, '').replace(/^\+/, '');
}

function pickFirstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function getZonedParts(dateValue, timeZone) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdayKey = String(parts.weekday ?? '').trim().slice(0, 3).toLowerCase();

  return {
    weekday: WEEKDAY_INDEX[weekdayKey] ?? date.getUTCDay(),
    hour: Number(parts.hour ?? 0),
    minute: Number(parts.minute ?? 0),
    day: Number(parts.day ?? 0),
    month: Number(parts.month ?? 0),
    year: Number(parts.year ?? 0),
    label: formatter.format(date),
  };
}

function formatDateLabel(dateValue, timeZone) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: timeZone || undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function timeStringToMinutes(value) {
  const normalized = normalizeTimeString(value);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map((item) => Number(item));
  return hour * 60 + minute;
}

function getDateKeyInTimeZone(dateValue, timeZone) {
  const parts = getZonedParts(dateValue, timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getTimeZoneOffsetMinutes(dateValue, timeZone) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year || 0),
    Number(parts.month || 1) - 1,
    Number(parts.day || 1),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

function zonedDateTimeToUtc(parts, timeZone) {
  const utcGuess = Date.UTC(parts.year, (parts.month || 1) - 1, parts.day || 1, parts.hour || 0, parts.minute || 0, parts.second || 0);
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offsetMinutes * 60000);
}

function getUtcDayRangeForTimeZone(dateValue, timeZone) {
  const parts = getZonedParts(dateValue, timeZone);
  const start = zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  }, timeZone);
  const end = zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 23,
    minute: 59,
    second: 59,
  }, timeZone);

  return { start, end };
}

function isDailySummaryDue(rule, now = new Date(), scanWindowMinutes = 5) {
  if (!rule || !rule.enabled || normalizeTriggerType(rule.triggerType) !== 'daily_agent_summary') {
    return false;
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const parts = getZonedParts(nowDate, rule.timezone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const sendMinutes = timeStringToMinutes(rule.summaryTime || DEFAULT_DAILY_SUMMARY_TIME);
  if (sendMinutes === null) return false;

  if (Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(parts.weekday)) {
    return false;
  }

  const windowSize = Math.max(1, Number(scanWindowMinutes) || 5);
  return nowMinutes >= sendMinutes && nowMinutes <= sendMinutes + windowSize;
}

function buildReminderContext({ appointment, rule, flowName, tenantName }) {
  const appointmentStart = appointment?.startTime instanceof Date ? appointment.startTime : new Date(appointment?.startTime);
  const appointmentEnd = appointment?.endTime instanceof Date ? appointment.endTime : new Date(appointment?.endTime);
  const timezone = String(rule?.timezone || appointment?.calendar?.timezone || '').trim() || null;
  const startLabel = formatDateLabel(appointmentStart, timezone);
  const endLabel = formatDateLabel(appointmentEnd, timezone);

  const customerName = pickFirstNonEmpty(
    appointment?.metadata?.user_name,
    appointment?.metadata?.nombre,
    appointment?.metadata?.customer_name,
    appointment?.metadata?.cliente_nombre,
  );
  const agentName = pickFirstNonEmpty(
    appointment?.calendar?.agente?.nombre,
    appointment?.metadata?.agent_name,
    appointment?.metadata?.agente_nombre,
  );

  return {
    appointment_id: String(appointment?.id ?? ''),
    appointment_start: appointmentStart.toISOString(),
    appointment_end: appointmentEnd.toISOString(),
    appointment_start_label: startLabel,
    appointment_end_label: endLabel,
    appointment_timezone: timezone ?? '',
    appointment_status: String(appointment?.status ?? ''),
    calendar_name: String(appointment?.calendar?.name ?? ''),
    customer_name: customerName,
    agent_name: agentName,
    flow_name: String(flowName ?? '').trim(),
    tenant_name: String(tenantName ?? '').trim(),
    minutes_before: String(rule?.minutesBefore ?? ''),
    rule_label: String(rule?.label ?? '').trim(),
  };
}

function normalizeTemplateKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function renderTemplate(template, context) {
  const lookup = Object.entries(context || {}).reduce((acc, [key, value]) => {
    acc[normalizeTemplateKey(key)] = value;
    return acc;
  }, {});

  return String(template ?? DEFAULT_MESSAGE).replace(/{{\s*([^}]+)\s*}}/g, (_match, rawKey) => {
    const key = normalizeTemplateKey(rawKey);
    const value = lookup[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function getAppointmentReminderMetadata(appointment) {
  const metadata = asObject(appointment?.metadata);
  const outboundReminders = asObject(metadata.outbound_reminders);
  return { metadata, outboundReminders };
}

function hasReminderBeenSent(appointment, ruleId, recipient) {
  const { outboundReminders } = getAppointmentReminderMetadata(appointment);
  return Boolean(outboundReminders?.[ruleId]?.[recipient]?.sent_at);
}

function markReminderSent(appointment, ruleId, recipient, sentAt = new Date()) {
  const { metadata, outboundReminders } = getAppointmentReminderMetadata(appointment);
  const nextMetadata = {
    ...metadata,
    outbound_reminders: {
      ...outboundReminders,
      [ruleId]: {
        ...asObject(outboundReminders[ruleId]),
        [recipient]: {
          sent_at: sentAt instanceof Date ? sentAt.toISOString() : new Date(sentAt).toISOString(),
        },
      },
    },
  };

  return nextMetadata;
}

function isRuleDue(rule, appointment, now = new Date(), scanWindowMinutes = 5) {
  if (!rule || !rule.enabled) return false;

  const appointmentStartValue = appointment?.startTime ?? appointment?.start_time ?? null;
  const appointmentStart = appointmentStartValue instanceof Date ? appointmentStartValue : new Date(appointmentStartValue);
  if (Number.isNaN(appointmentStart.getTime())) return false;

  const allowedStatuses = Array.isArray(rule.allowedStatuses) && rule.allowedStatuses.length > 0
    ? rule.allowedStatuses.map((status) => String(status ?? '').trim().toLowerCase()).filter(Boolean)
    : ['scheduled', 'rescheduled'];

  const nowDate = now instanceof Date ? now : new Date(now);
  const minutesBefore = Math.max(1, Number(rule.minutesBefore) || 60);
  const dueAt = new Date(appointmentStart.getTime() - minutesBefore * 60000);
  const windowEnd = new Date(dueAt.getTime() + Math.max(1, scanWindowMinutes) * 60000);

  if (nowDate < dueAt || nowDate > windowEnd) return false;

  if (Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0) {
    const parts = getZonedParts(appointmentStart, rule.timezone);
    if (!rule.daysOfWeek.includes(parts.weekday)) return false;
  }

  const startMinutes = timeStringToMinutes(rule.timeWindowStart);
  const endMinutes = timeStringToMinutes(rule.timeWindowEnd);
  if (startMinutes !== null || endMinutes !== null) {
    const parts = getZonedParts(appointmentStart, rule.timezone);
    const currentMinutes = parts.hour * 60 + parts.minute;
    if (startMinutes !== null && currentMinutes < startMinutes) return false;
    if (endMinutes !== null && currentMinutes > endMinutes) return false;
  }

  const appointmentStatus = String(appointment?.status ?? '').trim().toLowerCase();
  if (appointmentStatus && !allowedStatuses.includes(appointmentStatus)) {
    return false;
  }

  return true;
}

function getRecipientTargets(appointment) {
  const metadata = asObject(appointment?.metadata);
  const customerPhone = normalizePhone(
    pickFirstNonEmpty(
      appointment?.userKey,
      metadata.user_phone,
      metadata.telefono,
      metadata.customer_phone,
    ),
  );
  const agentPhone = normalizePhone(appointment?.calendar?.agente?.whatsapp);

  return {
    customer: {
      phone: customerPhone,
      name: pickFirstNonEmpty(metadata.user_name, metadata.nombre, metadata.customer_name, metadata.cliente_nombre),
    },
    agent: {
      phone: agentPhone,
      name: pickFirstNonEmpty(appointment?.calendar?.agente?.nombre, metadata.agent_name, metadata.agente_nombre),
    },
  };
}

module.exports = {
  DEFAULT_FLOW_MODE,
  DEFAULT_MESSAGE,
  DEFAULT_DAILY_SUMMARY_MESSAGE,
  DEFAULT_DAILY_SUMMARY_TIME,
  normalizeFlowMode,
  normalizeTriggerType,
  normalizeTimeString,
  normalizeRecipientList,
  normalizeStatusList,
  normalizeWeekdayList,
  normalizeOutboundRule,
  normalizeOutboundRules,
  normalizeFlowAutomationMetadata,
  getZonedParts,
  formatDateLabel,
  timeStringToMinutes,
  getDateKeyInTimeZone,
  getUtcDayRangeForTimeZone,
  buildReminderContext,
  renderTemplate,
  getAppointmentReminderMetadata,
  hasReminderBeenSent,
  markReminderSent,
  isRuleDue,
  isDailySummaryDue,
  getRecipientTargets,
  normalizePhone,
};