cd /opt/chatbot
echo "REMOTE_HEAD=$(git rev-parse --short HEAD)"
WA_APP_SECRET_LEN=$(docker compose exec -T api sh -lc 'echo ${#WA_APP_SECRET}')
echo "WA_APP_SECRET_LEN=$WA_APP_SECRET_LEN"
docker compose exec -T api sh -lc 'grep -n "resolveMetaAppSecret" src/routes/whatsapp.js | head -1'
docker compose exec -T api node - <<'NODE'
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const secrets = await p.configuracion.findMany({ where: { clave: "wa_app_secret" }, select: { tenantId: true }});
  const creds = await p.configuracion.findMany({ where: { clave: "wa_credentials" }, select: { tenantId: true, valor: true }});
  const summary = {
    waAppSecretRows: secrets.length,
    waCredentialsRows: creds.length,
    phoneNumberIdsConfigured: creds.map(c => {
        try {
            const v = typeof c.valor === "string" ? JSON.parse(c.valor) : c.valor;
            return String(v?.phoneNumberId || "").trim();
        } catch(e) { return ""; }
    }).filter(Boolean).length,
    uniqueTenantIdsWithSecret: [...new Set(secrets.map(s => s.tenantId))].length,
  };
  console.log(JSON.stringify(summary));
  await p.$disconnect();
})().catch(async e => { console.error(e.message); await p.$disconnect(); process.exit(1); });
NODE
