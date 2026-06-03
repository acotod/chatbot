# Arquitectura Actual - Chatbot SaaS

Fecha de referencia: 2026-06-03
Estado: Activa en produccion/staging con despliegue en Docker Compose

## 1) Objetivo de la solucion

La plataforma provee atencion conversacional por WhatsApp para multiples tenants, con:

- Motor de flujo conversacional y reglas de negocio
- Gestion de conversaciones y solicitudes
- Agenda y citas
- Panel administrativo web
- Seguridad (JWT, RBAC, auditoria, rate limiting)
- Integraciones y procesamiento asincrono

## 2) Vista general por capas

### Capa de canal

- WhatsApp Cloud API (entrada/salida de mensajes)
- Webhooks para eventos de mensajes
- Endpoint de verificacion para Meta

### Capa API (Express)

Aplicacion principal en `src/app.js` y bootstrap en `src/server.js`.

Responsabilidades:

- Exponer endpoints REST y webhook
- Resolver tenant por API key
- Aplicar seguridad y middlewares transversales
- Orquestar servicios de negocio

### Capa de servicios de negocio

Servicios en `src/services/` para:

- Motor conversacional (`chatbotRouter.js`, `flowEngine.js`, `flowNavigation.js`)
- WhatsApp (`whatsapp.js`)
- Calendario y citas (`calendarService.js`)
- CRM/solicitudes (`database.js`, `crmSync.js`, `solicitudesWebhooks.js`)
- Eventos (`eventGateway.js`, `eventNormalizer.js`)
- Seguridad y acceso (`lockoutPolicy.js`, `portalAccess.js`)

### Capa de procesamiento asincrono

Workers en `src/workers/`:

- `waSendWorker.js`: consume cola de envio de WhatsApp
- `urgenciaWorker.js`: procesamiento de tareas urgentes

### Capa de datos

- PostgreSQL (modelo principal con Prisma)
- Redis (colas, cache y soporte a procesos de alta concurrencia)
- Volumen persistente para archivos en `uploads/`

### Capa de administracion

- Aplicacion Next.js en `admin/`
- Consumidor de la API backend para operacion de conversaciones, agenda, flujos, seguridad y configuracion

## 3) Topologia de despliegue actual (Docker Compose)

Archivo: `docker-compose.yml`

Servicios activos:

1. `postgres`
- Imagen: `postgres:16-alpine`
- Base por defecto: `chatbot_staging`
- Volumen: `postgres_data`

2. `redis`
- Imagen: `redis:7-alpine`
- Volumen: `redis_data`

3. `api`
- Backend Node.js/Express
- Puerto host por defecto: `3200 -> 3000`
- Dependencias: `postgres`, `redis`
- Monta `uploads_data` y `./data:/app/data:ro`

4. `wa-worker`
- Ejecuta `node src/workers/waSendWorker.js`
- Dependencias: `postgres`, `redis`

5. `admin`
- Frontend Next.js
- Puerto: `3001 -> 3000`
- Depende de `api`

6. `migrate` (perfil manual)
- Perfil: `migrations`
- Se usa para ejecutar migraciones cuando corresponde

## 4) Seguridad y controles transversales

Implementados principalmente en `src/app.js` y `src/server.js`:

- Validacion de `JWT_SECRET` minimo 32 caracteres al arranque
- `helmet` habilitado con politica para assets publicos cross-origin
- CORS controlado por lista blanca y validacion de dominios hermanos
- Correlation ID en requests para trazabilidad
- Rate limiter por tenant en webhook y eventos
- Separacion de endpoints publicos vs protegidos

Capacidades de control de acceso:

- JWT para rutas administrativas
- RBAC (`/rbac`)
- Auditoria (`/audit`)
- Gestion de sesiones y MFA (`/device-sessions`)

## 5) Mapa funcional de endpoints (alto nivel)

Rutas principales en `src/routes/`:

- `auth.js`: autenticacion y emision/refresh de tokens
- `webhook.js`: ingreso de eventos por tenant
- `whatsapp.js`: verificacion Meta, mensajes entrantes y envio
- `events.js`: gateway canonico de eventos
- `conversations.js`: event sourcing y gestion conversacional
- `calendar.js`: agenda y citas
- `flows.js`, `variables.js`, `waba-flows.js`: flujos y variables
- `crm.js`: contactos/deals/tareas y funciones CRM
- `admin.js`: operaciones administrativas
- `rbac.js`, `auditLogs.js`: seguridad y trazabilidad
- `integrations.js`, `sandbox.js`: integraciones y pruebas
- `portal.js`: acceso cliente por token (sin JWT admin)

## 6) Modelo de datos funcional (Prisma/PostgreSQL)

Esquema en `prisma/schema.prisma`.

Entidades clave:

- Tenant y configuracion multi-tenant
- User y Conversation
- Mensaje y contextos de conversacion
- Solicitud, SLA, historial y comentarios
- Agenda, Calendar y Appointment
- Flow, FlowVersion, FlowExecution y variables
- Integraciones
- EventLog y DeadLetterQueue para resiliencia
- Cola de envio WhatsApp (`WaSendQueue`)

Patrones relevantes:

- Idempotencia por `eventId` y `idempotencyKey`
- Trazabilidad temporal (`createdAt`, `updatedAt`, `processedAt`)
- Indices por tenant para escalar consultas operativas

## 7) Flujos operativos principales

### 7.1 Inbound WhatsApp

1. Meta envia evento a webhook
2. API valida tenant, seguridad y rate limit
3. Evento se normaliza y persiste (event log)
4. Motor conversacional resuelve siguiente accion
5. Si requiere respuesta, se encola envio WA
6. Worker procesa cola y despacha mensaje

### 7.2 Gestion de solicitudes

1. Conversacion o regla crea/actualiza solicitud
2. Se aplica politica SLA y reglas de asignacion
3. Cambios quedan en historial/comentarios
4. Admin da seguimiento desde panel

### 7.3 Agenda y citas

1. API registra/actualiza cita
2. Estado de cita se sincroniza con metadatos
3. Panel muestra agenda para seguimiento operativo

## 8) Operacion y mantenimiento

Capacidades actuales:

- Health check en `/health`
- Logs de API y workers para diagnostico
- Reinicio controlado via `docker compose up -d --build`
- Migraciones separadas por perfil (`migrate`)

Practicas recomendadas de operacion:

- Mantener backups de Postgres y volumenes
- Versionar cambios de esquema con migraciones
- Monitorear cola de envio y dead letter queue
- Auditar cambios de roles/permisos periodicamente

## 9) Dependencias criticas

- Meta/WhatsApp Cloud API
- PostgreSQL
- Redis
- Variables de entorno de seguridad e integraciones

Variables especialmente sensibles:

- `JWT_SECRET`
- `DATABASE_URL`
- `REDIS_URL`
- `WA_VERIFY_TOKEN`
- `ADMIN_API_KEY`

## 10) Estado actual y conclusion

La arquitectura actual ya es de nivel SaaS operacional: multi-tenant, con separacion API/worker/admin, trazabilidad de eventos, controles de seguridad y despliegue contenorizado.

No es solo un bot; es una plataforma transaccional de atencion y operacion con base para evolucionar a un CRM conversacional mas profundo segun demanda del negocio.
