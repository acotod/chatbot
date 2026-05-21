#!/usr/bin/env bash
set -euo pipefail

HOST="${STAGING_HOST:-144.91.114.49}"
PORT="${STAGING_PORT:-51576}"
USER="${STAGING_USER:-root}"
PASS="${STAGING_PASS:-FacturaPMC2026}"
REMOTE_PATH="${STAGING_PATH:-/opt/chatbot}"

TMP_JS="$(mktemp /tmp/stg_horario_diag.XXXXXX.js)"
trap 'rm -f "$TMP_JS"' EXIT

cat > "$TMP_JS" <<'NODE'
const db = require('./src/services/database');
const flowEngine = require('./src/services/flowEngine');
const { PrismaClient } = require('@prisma/client');

function idsFrom(content) {
  const ids = [];
  if (Array.isArray(content?.buttons)) {
    for (const b of content.buttons) if (b?.id) ids.push(String(b.id));
  }
  if (Array.isArray(content?.sections)) {
    for (const s of content.sections) {
      for (const r of (s?.rows || [])) if (r?.id) ids.push(String(r.id));
    }
  }
  return ids;
}

function preview(t) {
  return String(t || '').replace(/\s+/g, ' ').slice(0, 90);
}

(async () => {
  const prisma = new PrismaClient();
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: 'global-med' } }) || await prisma.tenant.findFirst();
    if (!tenant) throw new Error('No tenant found');

    const cases = [
      { label: 'ID_8', input: '8', phone: '+34600003981' },
      { label: 'ID_14', input: '14', phone: '+34600003982' },
      { label: 'TEXT_8AM', input: '8:00 a.m.', phone: '+34600003983' },
    ];

    const results = [];

    for (const c of cases) {
      const user = await db.findOrCreateUser(c.phone, tenant.id);
      await prisma.conversationContext.deleteMany({ where: { tenantId: tenant.id, userId: user.id } }).catch(() => {});

      let r = await flowEngine.executeStep({ tenantId: tenant.id, currentNodeId: null, input: null, userId: user.id, sessionKey: c.phone });
      let sentCase = false;
      let finalText = String(r?.content?.text || '');
      let finalType = r?.content?.type || null;
      const trace = [];

      for (let i = 0; i < 15; i++) {
        const ids = idsFrom(r?.content || {});
        trace.push({ i, type: r?.content?.type || null, text: preview(r?.content?.text), ids });

        const isHorarioMenu = ids.includes('opt_10') || ids.includes('opt_11') || ids.includes('opt_12') || ids.includes('opt_13') || ids.filter(x => /^opt_\d+$/i.test(x)).length >= 6;

        let nextInput = null;
        if (!sentCase && isHorarioMenu) {
          nextInput = c.input;
          sentCase = true;
        } else if (ids.includes('opt_1')) {
          nextInput = 'opt_1';
        } else if (ids.length > 0) {
          nextInput = ids[0];
        } else if (!sentCase) {
          nextInput = 'continuar';
        } else {
          break;
        }

        r = await flowEngine.executeStep({ tenantId: tenant.id, currentNodeId: null, input: nextInput, userId: user.id, sessionKey: c.phone });
        finalText = String(r?.content?.text || '');
        finalType = r?.content?.type || null;

        if (sentCase && /(reservad|agendad|confirm|solicitud|espacio|gracias)/i.test(finalText)) {
          break;
        }
      }

      const pass = /(reservad|agendad|confirm|solicitud|espacio|gracias)/i.test(finalText);
      results.push({ case: c.label, input: c.input, pass, finalType, finalTextPreview: preview(finalText) });
      console.log('TRACE_' + c.label + '=' + JSON.stringify(trace));
    }

    console.log('STAGING_HORARIO_RESULTS=' + JSON.stringify(results));
    console.log('STAGING_HORARIO_VERDICT=' + (results.every(x => x.pass) ? 'PASS' : 'FAIL'));
    await prisma.$disconnect();
  } catch (e) {
    console.log('STAGING_HORARIO_ERROR=' + (e && e.message ? e.message : String(e)));
    try { await prisma.$disconnect(); } catch {}
    process.exit(1);
  }
})();
NODE

export SSHPASS="$PASS"
sshpass -e ssh -o StrictHostKeyChecking=no -p "$PORT" "$USER@$HOST" "cd $REMOTE_PATH && echo REMOTE_HEAD=$(git rev-parse --short HEAD) && docker compose ps api && docker compose exec -T api node -" < "$TMP_JS"
