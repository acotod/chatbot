'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function buildDefaultInternalCalendarConfig() {
  return {
    working_hours: {
      mon: ['09:00', '17:00'],
      tue: ['09:00', '17:00'],
      wed: ['09:00', '17:00'],
      thu: ['09:00', '17:00'],
      fri: ['09:00', '17:00'],
    },
    slot_duration_min: 30,
    advance_days: 14,
    provider: 'internal',
    sync: false,
  };
}

function normalizeCalendarNameBase({ agenteNombre, agenteEmail, agenteId }) {
  const source = String(agenteNombre || '').trim() || String(agenteEmail || '').trim() || `Agente ${agenteId}`;
  const collapsed = source.replace(/\s+/g, ' ').trim();
  return `Agenda ${collapsed.slice(0, 170)}`;
}

async function findAvailableCalendarName(tenantId, baseName) {
  for (let i = 0; i < 500; i += 1) {
    const suffix = i === 0 ? '' : ` (${i + 1})`;
    const candidate = `${baseName}${suffix}`;
    const exists = await prisma.calendar.findFirst({
      where: { tenantId, name: candidate },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    tenantSlug: null,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    if (arg.startsWith('--tenant=')) {
      opts.tenantSlug = arg.slice('--tenant='.length).trim() || null;
      continue;
    }
    if (!opts.tenantSlug) {
      opts.tenantSlug = arg.trim() || null;
    }
  }

  return opts;
}

async function run() {
  const { tenantSlug, dryRun } = parseArgs(process.argv);
  const whereTenants = tenantSlug ? { slug: tenantSlug } : {};

  const tenants = await prisma.tenant.findMany({
    where: whereTenants,
    select: { id: true, slug: true, nombre: true },
    orderBy: { slug: 'asc' },
  });

  if (tenants.length === 0) {
    console.log(tenantSlug ? `No tenant found for slug: ${tenantSlug}` : 'No tenants found.');
    return;
  }

  let created = 0;
  let alreadyAssigned = 0;

  for (const tenant of tenants) {
    const agentes = await prisma.agente.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, nombre: true, email: true },
      orderBy: { id: 'asc' },
    });

    console.log(`\\n[${tenant.slug}] processing ${agentes.length} agentes`);

    for (const agente of agentes) {
      const existing = await prisma.calendar.findFirst({
        where: { tenantId: tenant.id, agenteId: agente.id, activo: true },
        select: { id: true, name: true },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        alreadyAssigned += 1;
        console.log(`- agente ${agente.id} (${agente.email || agente.nombre}): already has calendar ${existing.name}`);
        continue;
      }

      const baseName = normalizeCalendarNameBase({
        agenteNombre: agente.nombre,
        agenteEmail: agente.email,
        agenteId: agente.id,
      });
      const uniqueName = await findAvailableCalendarName(tenant.id, baseName);

      if (dryRun) {
        console.log(`- agente ${agente.id} (${agente.email || agente.nombre}): would create ${uniqueName}`);
        continue;
      }

      await prisma.calendar.create({
        data: {
          tenantId: tenant.id,
          agenteId: agente.id,
          name: uniqueName,
          config: buildDefaultInternalCalendarConfig(),
        },
      });

      created += 1;
      console.log(`- agente ${agente.id} (${agente.email || agente.nombre}): created ${uniqueName}`);
    }
  }

  console.log('\\nDone.');
  console.log(`alreadyAssigned=${alreadyAssigned}`);
  console.log(`created=${dryRun ? 0 : created}`);
  if (dryRun) console.log('dryRun=true (no changes written)');
}

run()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
