# Chatbot SaaS

Backend multitenant para chatbots de WhatsApp con panel administrativo, Prisma/PostgreSQL, Redis y despliegue con Docker Compose.

## Estado actual

La implementación de backend solicitada quedó completada y desplegada.

- Fase 0: hardening de seguridad completado
- Fase 1: esquema Prisma y migración de estado conversacional completados
- Fase 2: webhook robusto, idempotencia, correlation ID y retry completados
- Fase 3: presencia de agentes y eventos en tiempo real completados
- Fase 4: motor de chatbot conectado a WhatsApp completado
- Fase 5: endpoint oficial de Meta Flows completado
- Fase 6: auditoría, RBAC y control de accesos completados
- Fase 7: tests, migración y despliegue completados

## Componentes principales

- API Express en `src/`
- Prisma schema en `prisma/schema.prisma`
- Worker de urgencias en `src/workers/urgenciaWorker.js`
- Worker de reintentos WA en `src/workers/waSendWorker.js`
- Webhook y Meta Flows en `src/routes/whatsapp.js`
- Panel admin servido por Docker Compose en `http://localhost:3001`

## Verificación rápida

- API: `http://localhost:3200`
- Admin: `http://localhost:3001`
- Ejecutar tests: `npm test`
- Ver contenedores: `docker compose ps`
