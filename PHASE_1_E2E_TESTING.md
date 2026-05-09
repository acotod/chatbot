# Phase 1 End-to-End Testing Guide

## Overview
This guide validates the Phase 1 WhatsApp CRM bidirectional messaging implementation through manual E2E testing.

## Prerequisites
- Running containers: `docker compose ps` shows api, admin, postgres, redis all healthy
- Database: Sample tenant and user data seeded
- WhatsApp Meta business account: With valid `Configuracion.phoneNumberId` and `accessToken`

## Test Scenario 1: Admin Message Send Flow

### Setup
1. Log into admin panel: `http://localhost:3001`
2. Navigate to Solicitudes
3. Open any existing solicitud (or create one with customer phone)
4. Click "Mensajes WhatsApp" tab

### Test Steps
1. **Verify tab loads**: Messages tab should show empty or existing messages
   - Expected: Timeline loads, composer appears at bottom

2. **Send test message from admin**:
   - Type: "Hola desde administrador"
   - Press Enter or click "Enviar"
   - Expected: 
     - Message appears in timeline with 🔴 indicator
     - "Enviando..." state shows briefly
     - Success message displays
     - Message sent to customer's WhatsApp within 2-3 seconds

3. **Verify delivery status**:
   - Wait 5-10 seconds for Meta webhook callback
   - Expected: Message status changes to ✓ (delivered)

4. **Check audit trail**:
   - Database: Query `SELECT * FROM AuditLog WHERE accion = 'SEND_SOLICITUD_MESSAGE'`
   - Expected: Entry with actor: admin, solicitudId, timestamp

### Success Criteria
- ✓ Message sent via Meta API
- ✓ Message stored in database (Mensaje table)
- ✓ Socket event emitted (visible in browser console if socket logging enabled)
- ✓ Audit log created
- ✓ Delivery status updated from pending to delivered

---

## Test Scenario 2: Agent Message Send Flow

### Setup
1. Log out of admin
2. Log into agent portal: `http://localhost:3001/agente/login` (or navigate to `/agente/dashboard`)
3. View assigned solicitudes
4. Open an assigned solicitud
5. Click "Mensajes WhatsApp" tab

### Test Steps
1. **Verify agent can see messages**:
   - Should see only messages for this solicitud
   - Agent cannot see other agents' solicitudes (ownership enforced)

2. **Send reply from agent**:
   - Type: "Este es mi respuesta como agente"
   - Press Enter
   - Expected:
     - Message appears with 🔴 indicator
     - Message sent to customer's WhatsApp
     - Source logged as "agent_solicitud"

3. **Verify ownership protection**:
   - Try accessing different agent's solicitud directly: `/auth/agent/solicitudes/999/messages`
   - Expected: 403 Forbidden or graceful error

4. **Check audit metadata**:
   - Database: `SELECT metadata FROM AuditLog WHERE accion = 'SEND_SOLICITUD_MESSAGE' ORDER BY createdAt DESC LIMIT 1`
   - Expected: `{ "agenteId": <agent_id> }`

### Success Criteria
- ✓ Agent sees assigned solicitudes only
- ✓ Cannot access unassigned solicitudes (403)
- ✓ Message sent with agent attribution
- ✓ Audit trail includes agenteId

---

## Test Scenario 3: Bidirectional Communication

### Setup
- Have admin, agent, and customer WhatsApp client ready
- Solicitud assigned to specific agent

### Test Steps
1. **Customer sends initial message**:
   - Customer sends WhatsApp to chatbot number
   - Message triggers handoff → creates Solicitud → assigns Agente
   
2. **Admin responds**:
   - In admin panel, view new Solicitud
   - Open Messages tab
   - Send: "Hola cliente, somos el equipo de soporte"
   - Verify customer receives on WhatsApp

3. **Customer replies**:
   - Customer replies to admin's message
   - Message appears in Solicitud → Conversaciones tab (existing functionality)

4. **Agent joins conversation**:
   - Agent logs in to portal
   - Views assigned Solicitud
   - Opens Messages tab (should see conversation history)
   - Sends: "Hola soy tu agente asignado"
   - Verify customer receives

5. **Real-time status updates**:
   - Both admin and agent should see delivery status updates in real-time
   - Messages show ✓ when delivered, ✓✓ when read

### Success Criteria
- ✓ Messages flow bidirectionally
- ✓ Both admin and agent can respond
- ✓ Customer sees all responses from same number
- ✓ Real-time updates visible in both portals
- ✓ Full conversation history available

---

## Test Scenario 4: Error Handling

### Test Empty Message
1. In admin Messages tab, try sending empty text or only whitespace
2. Expected: Error message, message not sent

### Test Missing Phone
1. Create/open solicitud with no customer phone
2. Try sending message
3. Expected: Error message about missing contact info

### Test WhatsApp API Failure
1. Temporarily invalidate accessToken in database
2. Try sending message from admin
3. Expected: Error message, user notified, message not stored

### Test Ownership Violations
1. As Agent A, try accessing Agent B's solicitud via URL manipulation
2. Expected: 403 Forbidden or redirect to own solicitudes

### Success Criteria
- ✓ All error cases handled gracefully
- ✓ User feedback is clear and actionable
- ✓ No silent failures
- ✓ Security boundaries enforced

---

## Test Scenario 5: Real-Time Socket Updates

### Setup
- Open admin and agent portals in two browser windows
- Have both signed in

### Test Steps
1. **Admin sends message**:
   - In admin window, send message from Solicitud
   - In agent window, should see message appear in real-time (no refresh needed)
   - Expected: SOLICITUD_MESSAGE_SENT event triggers UI update

2. **Agent responds**:
   - In agent window, send reply
   - In admin window, should see reply appear in real-time
   - Expected: Both portals stay in sync

3. **Delivery status updates**:
   - After Meta webhook fires (5-10 seconds)
   - Both windows should show updated status (✓ delivered)
   - Expected: SOLICITUD_MESSAGE_STATUS_UPDATED event triggers UI update

### Success Criteria
- ✓ Real-time sync between admin and agent portals
- ✓ No page refresh required for updates
- ✓ Socket events properly broadcast to both sessions

---

## Database Verification Queries

### Verify Message Creation
```sql
SELECT id, solicitudId, direccion, tipo, contenido, leido, createdAt 
FROM Mensaje 
WHERE solicitudId = <test_solicitud_id>
ORDER BY createdAt DESC 
LIMIT 10;
```

Expected: Messages appear with correct solicitudId, direction, content

### Verify Audit Trail
```sql
SELECT id, accion, actorType, metadata, createdAt 
FROM AuditLog 
WHERE accion = 'SEND_SOLICITUD_MESSAGE' 
ORDER BY createdAt DESC 
LIMIT 5;
```

Expected: Entries with actorType: 'admin' or agent metadata with agenteId

### Verify Ownership Association
```sql
SELECT s.id, s.titulo, s.agenteId, COUNT(m.id) as message_count
FROM Solicitud s
LEFT JOIN Mensaje m ON s.id = m.solicitudId
WHERE s.agenteId IS NOT NULL
GROUP BY s.id;
```

Expected: Shows agent assignment and message counts per solicitud

---

## API Endpoint Testing (curl commands)

### Admin: Get Messages
```bash
curl -X GET \
  'http://localhost:3200/admin/tenants/test-slug/solicitudes/123/messages?page=1&limit=50' \
  -H 'Authorization: Bearer <admin_jwt_token>' \
  -H 'Content-Type: application/json'
```

Expected Response:
```json
{
  "solicitud": { "id": 123, ... },
  "data": [ { "id": 1, "direccion": "entrada", ... } ],
  "total": 5,
  "page": 1,
  "limit": 50
}
```

### Admin: Send Message
```bash
curl -X POST \
  'http://localhost:3200/admin/tenants/test-slug/solicitudes/123/messages' \
  -H 'Authorization: Bearer <admin_jwt_token>' \
  -H 'Content-Type: application/json' \
  -d '{ "text": "Test message" }'
```

Expected Response:
```json
{
  "ok": true,
  "solicitudId": 123,
  "mensaje": { "id": 999, "direccion": "salida", ... },
  "waResponse": { "messages": [...] }
}
```

### Agent: Get Messages
```bash
curl -X GET \
  'http://localhost:3200/auth/agent/solicitudes/123/messages' \
  -H 'Authorization: Bearer <agent_jwt_token>' \
  -H 'Content-Type: application/json'
```

Expected: Same response as admin (if agent owns solicitud)

### Agent: Ownership Check
Try accessing unowned solicitud:
```bash
curl -X GET \
  'http://localhost:3200/auth/agent/solicitudes/999/messages' \
  -H 'Authorization: Bearer <agent_jwt_token>' \
  -H 'Content-Type: application/json'
```

Expected Response: 403 Forbidden or validation error

---

## Browser Console Validation

### Check Socket Events
Open browser DevTools → Console and run:
```javascript
// Listen for socket events
if (window.io) {
  window.socket.on('SOLICITUD_MESSAGE_SENT', (data) => {
    console.log('Message sent event:', data);
  });
  window.socket.on('SOLICITUD_MESSAGE_STATUS_UPDATED', (data) => {
    console.log('Status updated event:', data);
  });
}
```

Send a message and verify events log to console

### Verify React Query Cache
```javascript
console.log(window.__REACT_QUERY_DEVTOOLS__);
// Or check the request/response in Network tab
```

---

## Checklist: Phase 1 Complete

- [ ] Admin can view messages for any solicitud
- [ ] Admin can send messages to customer (via WhatsApp)
- [ ] Agent can view messages only for assigned solicitudes
- [ ] Agent cannot access other agents' messages (403)
- [ ] Agent can send messages to customer
- [ ] All message sends logged in audit trail
- [ ] Admin sends show actorType: 'admin'
- [ ] Agent sends show agenteId in metadata
- [ ] Delivery status updates from Meta webhook
- [ ] Socket events broadcast real-time updates
- [ ] Both admin and agent see live updates
- [ ] Empty/invalid messages rejected
- [ ] Missing phone number handled gracefully
- [ ] WhatsApp API errors handled gracefully
- [ ] Ownership boundaries enforced (agents can't cross-access)
- [ ] Full E2E flow works: customer → solicitud → admin/agent → customer

---

## Troubleshooting

### Messages not sending
- Check: `docker compose logs api | grep SEND_SOLICITUD_MESSAGE`
- Verify: Tenant has valid `phoneNumberId` and `accessToken` in `Configuracion`
- Verify: Customer has valid phone number in Solicitud

### No real-time updates
- Check: Socket.io connected in browser Network tab
- Verify: Redis running: `docker compose logs redis`
- Check: `REDIS_URL` environment variable in api container

### Agent access denied
- Verify: Solicitud.agenteId matches Agent.id
- Check: Agent JWT token valid and not expired
- Verify: Agent middleware properly validates ownership

### Delivery status not updating
- Check: Meta webhook endpoint accessible
- Verify: Webhook signature validation enabled
- Check: `docker compose logs api | grep webhook`
- Verify: `Configuracion.webappUrl` matches webhook URL

---

## Success Indicators
- All 4 test scenarios pass
- All checklist items verified
- No errors in docker logs
- All database queries return expected results
- Real-time updates working in browser
- Audit trail complete and accurate
