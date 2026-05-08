'use strict';

const { PrismaClient } = require('@prisma/client');
const socketService = require('./socketService');

const prisma = new PrismaClient();

function serializeNotification(item) {
  return {
    id: item.id,
    tenantId: item.tenantId,
    adminUserId: item.adminUserId,
    type: item.type,
    title: item.title,
    message: item.message,
    data: item.data ?? null,
    readAt: item.readAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function createAdminNotification({
  tenantId,
  adminUserId,
  type,
  title,
  message,
  data,
}) {
  if (!tenantId || !adminUserId || !type || !title || !message) return null;

  const created = await prisma.adminNotification.create({
    data: {
      tenantId,
      adminUserId: Number(adminUserId),
      type: String(type).trim(),
      title: String(title).trim(),
      message: String(message).trim(),
      data: data ?? undefined,
    },
  });

  const payload = serializeNotification(created);
  socketService.emitToAdmin(tenantId, adminUserId, 'notification:new', payload);
  return payload;
}

module.exports = {
  createAdminNotification,
  serializeNotification,
};
