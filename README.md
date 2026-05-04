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

## Flujos genéricos stateful (JSON)

El backend incluye ejecución de flujos genéricos por sesiones persistidas en JSON.

Endpoints principales:

- `POST /flows/:id/execute-generic`
- `GET /flows/:id/sessions`
- `GET /flows/:id/sessions/:sessionKey`
- `GET /flows/:id/whatsapp-simulation`

### Request de ejecución (Postman)

```http
POST /flows/1/execute-generic
Authorization: Bearer <JWT_ADMIN>
Content-Type: application/json
```

```json
{
	"sessionKey": "cliente-549112223334",
	"input": "Necesito soporte",
	"businessContextJson": {
		"business_line": "soporte",
		"sla_tier": "gold",
		"customer_id": "CUST-1001"
	}
}
```

Respuesta esperada (ejemplo):

```json
{
	"sessionKey": "cliente-549112223334",
	"status": "active",
	"currentScreenId": "screen_2_decision",
	"screen": {
		"id": "screen_2_decision",
		"type": "decision",
		"title": "Validacion",
		"content": "Te ayudo con el siguiente paso",
		"actions": []
	},
	"terminal": false,
	"variables": {
		"intent": "support",
		"business": {
			"business_line": "soporte",
			"sla_tier": "gold",
			"customer_id": "CUST-1001"
		}
	}
}
```

### Consultar sesiones del flujo

```http
GET /flows/1/sessions?limit=20&status=active
Authorization: Bearer <JWT_ADMIN>
```

### Consultar detalle de una sesión

```http
GET /flows/1/sessions/cliente-549112223334?includeAudit=true
Authorization: Bearer <JWT_ADMIN>
```

Notas:

- `stateJson` almacena variables runtime.
- `businessContextJson` permite adaptar la lógica por negocio sin hardcode.
- `auditEventsJson` guarda trazabilidad de transiciones y webhooks por sesión.

### Simulacion WhatsApp por pantalla

`GET /flows/:id/whatsapp-simulation` devuelve una vista orientada al usuario final con:

- Burbujas de texto por pantalla (como vista tipo chat)
- Menus/opciones disponibles
- Acciones por condicion
- Donde se ejecuta webhook
- Que debe responder el webhook (status, tipo y ejemplo de JSON esperado)

## Login con Facebook (SDK JavaScript)

Este backend ahora expone `POST /auth/facebook` para intercambiar el `accessToken` de Facebook por los tokens JWT internos del panel admin.

Variables de entorno requeridas en la API:

- `FACEBOOK_APP_ID`
- `FACEBOOK_APP_SECRET`
- `FACEBOOK_GRAPH_VERSION` (opcional, default: `v25.0`)
- `FACEBOOK_GRAPH_URL` (opcional, default: `https://graph.facebook.com`)

Snippet frontend (SDK asíncrono):

```html
<script>
	window.fbAsyncInit = function () {
		FB.init({
			appId: '4224350961162585',
			cookie: true,
			xfbml: true,
			version: 'v25.0'
		});
	};
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/es_LA/sdk.js"></script>
```

Ejemplo de intercambio de token con la API:

```js
FB.login(async function (response) {
	if (!response.authResponse?.accessToken) return;

	const r = await fetch('http://localhost:3200/auth/facebook', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ accessToken: response.authResponse.accessToken })
	});

	const data = await r.json();
	// data.accessToken + data.refreshToken => sesión interna del admin
}, { scope: 'email,public_profile' });
```

Notas:

- El usuario de Facebook debe tener email disponible y debe existir un `adminUser` con ese mismo email.
- El `app secret` nunca debe enviarse al frontend.

### Mantenimiento en UI (recomendado)

Para mantener el frontend fácil de evolucionar, encapsula Facebook Login en un servicio único (por ejemplo `authService.loginWithFacebook()`) y evita llamadas directas a `FB.login` repartidas en múltiples vistas.

Contrato sugerido para UI:

- Request: `POST /auth/facebook` con `{ "accessToken": "..." }`
- Success (`200`): `{ accessToken, refreshToken, expiresIn, superAdmin }`
- Errores esperados:
	- `400`: token ausente o cuenta de Facebook sin email
	- `401`: token inválido / app mismatch
	- `403`: email no vinculado a un admin
	- `423`: cuenta temporalmente bloqueada
	- `503`: backend sin configuración Facebook

Buenas prácticas para UI:

- Mostrar mensaje de error por código HTTP, no por texto literal.
- Guardar `accessToken` en memoria y `refreshToken` con política segura según tu frontend.
- Implementar refresh automático con `POST /auth/refresh` antes de expirar sesión.
