Desarrollar una plataforma SaaS multitenant para gestión de flujos conversacionales en WhatsApp (Meta Cloud API), orientada a casos de uso conversacionales en distintos sectores, con backend robusto, seguridad por tenant, almacenamiento en PostgreSQL, experiencia de usuario profesional y despliegue en infraestructura propia con dominio y HTTPS.

---

## 🎯 OBJETIVO

Construir un sistema SaaS que permita a múltiples empresas (tenants):

* Operar chatbots en WhatsApp usando Flows (`data_exchange`)
* Gestionar solicitudes de usuarios
* Configurar flujos personalizados
* Asignar agentes humanos
* Visualizar métricas y operar desde un panel administrativo

---

## 🏗️ ARQUITECTURA GENERAL

* Backend: Node.js (Express o NestJS)
* ORM: Prisma
* Base de datos: PostgreSQL
* Cache / colas: Redis
* Frontend: Next.js (Admin Panel)
* Infraestructura: VPS + Nginx + HTTPS (Let's Encrypt)
* Dominio:

  * api.zentrabot.com → backend
  * zentrabot.com → landing
  * admin.zentrabot.com → panel

---

## 🧩 MODELO MULTITENANT

Estrategia:

* Single database
* Shared schema
* Aislamiento por `tenant_id`

---

## 🗄️ MODELO DE BASE DE DATOS

### tenants

* id (UUID)
* nombre
* api_key
* activo
* plan
* created_at

### users

* id
* tenant_id
* phone
* created_at

### solicitudes

* id
* tenant_id
* user_id
* nombre
* telefono_contacto
* horario
* estado
* created_at

### eventos_flujo

* id
* tenant_id
* user_id
* screen
* data (JSONB)
* created_at

### agentes

* id
* tenant_id
* nombre
* email
* estado

### configuraciones

* id
* tenant_id
* clave
* valor (JSONB)

---

## 🔐 SEGURIDAD MULTITENANT

* Middleware obligatorio para validar tenant
* Identificación por:

  * x-api-key
* Validar tenant activo
* Todas las queries deben incluir tenant_id
* JWT para panel admin
* Rate limiting por tenant
* Sanitización de inputs

---

## 🔗 ENDPOINT PRINCIPAL

POST /webhook

Debe:

1. Validar tenant
2. Recibir:

   * screen
   * data
3. Ejecutar lógica del flujo
4. Guardar evento en DB
5. Retornar:

{
"screen": "SIGUIENTE_PANTALLA"
}

---

## 🧠 FLOW ENGINE (DINÁMICO)

NO hardcodear lógica.

Debe permitir:

* routing configurable por tenant
* fallback a flujo default

Ejemplo:

INICIO:

* hablar_alguien → HABLAR_ALGUIEN
* estres → ESTRES
* informacion → INFORMACION
* urgencia → URGENCIA

---

## 💾 PERSISTENCIA

* Guardar cada evento en eventos_flujo
* Crear usuario si no existe
* En SOLICITUD_ESPACIO:

  * guardar nombre
  * teléfono
  * horario
  * estado = pendiente

---

## ⚡ REDIS (USOS)

* cache
* rate limiting
* colas de eventos
* sesiones temporales

---

## 🔄 WORKERS / JOBS

Procesos async:

* notificaciones internas
* manejo de urgencias
* integraciones externas
* envío de emails

---

## 🖥️ PANEL ADMIN (UX PRO)

### Dashboard

* solicitudes
* urgencias
* métricas

### Operación

* ver solicitudes
* asignar agentes
* cambiar estado

### Configuración

* flujos
* horarios
* textos
* branding

---

## 🎨 UX PROFESIONAL (WHATSAPP)

Principios:

* lenguaje humano
* decisiones simples
* máximo 3 opciones
* feedback inmediato
* tono empático

---

## 🔒 INFRAESTRUCTURA (CRÍTICO)

Servidor VPS

Configurar:

### Nginx reverse proxy

server {
server_name api.zentrabot.com;

```
location / {
    proxy_pass http://localhost:51576;
}
```

}

---

### SSL

Usar Let's Encrypt:

certbot --nginx -d api.zentrabot.com

---

### Seguridad servidor

* NO usar root
* usar usuario app
* firewall activo
* puertos abiertos: 80, 443

---

## 🚀 DESPLIEGUE

* Backend corriendo en puerto interno (ej: 51576)
* Nginx expone HTTPS
* URL final:

https://api.zentrabot.com/webhook

---

## 💳 BILLING (PREPARADO)

* planes por tenant
* límites de uso
* integración futura con Stripe

---

## 📊 OBSERVABILIDAD

* logs estructurados
* monitoreo
* alertas

---

## 📦 ENTREGABLES

* Backend funcional
* DB PostgreSQL
* Middleware multitenant
* Flow engine dinámico
* API documentada
* Panel admin base
* Infraestructura lista con HTTPS

---

## ⚠️ REGLAS CLAVE

* Nunca exponer HTTP
* Nunca usar IP directa
* Siempre aislar por tenant
* No hardcodear flujos
* Validar seguridad desde inicio

---

## 🎯 RESULTADO FINAL

Plataforma SaaS multitenant robusta, segura y escalable, que permite a múltiples organizaciones operar flujos conversacionales en WhatsApp con almacenamiento estructurado, experiencia de usuario profesional y despliegue listo para producción.
