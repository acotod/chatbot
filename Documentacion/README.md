# 📚 Índice de Documentación — PMC Chatbot Platform

## 🎯 Propósito

Centro de referencia para toda la documentación técnica del proyecto PMC Chatbot — plataforma SaaS multitenant para gestión de flujos conversacionales en WhatsApp.

---

## 📋 Documentos Disponibles

### 1. **Prompt Inicial — SaaS Multitenant**
📄 [prompt-inicial.md](./prompt-inicial.md)

Especificación fundacional de la plataforma:
- Arquitectura SaaS multitenant
- Modelo de base de datos (tenants, users, solicitudes, agentes, flows)
- Seguridad multitenant
- Dominio y deploy infrastructure

**Uso**: Referencia para arquitectura general, modelo de datos, seguridad.

---

### 2. **Prompt Frontend — UX/UI Professional**
📄 [prompt-front.md](./prompt-front.md)

Especificación de experiencia de usuario y diseño:
- Principios de diseño (claridad, velocidad, contexto)
- Arquitectura de UI (layout, sidebar, header)
- Módulos principales (Dashboard, Conversaciones, Solicitudes, Agenda, Agentes, Flujos, Configuración, Facturación)
- Componentes por módulo
- Guías de UX

**Uso**: Referencia para componentes, patrones de UI, flujos de usuario.

---

### 3. **Prompt Enterprise — Generador de Flujos WABA**
📄 [prompt-enterprise-flows.md](./prompt-enterprise-flows.md)

Especificación del módulo inteligente de flujos:
- 5 fases de evolución (AI Brief → Phase 5: Métricas)
- Arquitectura frontend (ReactFlow, AI Brief builder, Prompt Assistant)
- Arquitectura backend (/llm/* endpoints)
- Integración Meta Cloud API
- Modelo de datos (Flow, FlowNode, FlowEdge, FlowSession)
- Permisos y deployment

**Uso**: Referencia para módulo de flujos, endpoints LLM, generación IA, simulación.

---

## 🏗️ Relación entre Documentos

```
┌─────────────────────────────────────────────────────┐
│  Prompt Inicial (SaaS + Multitenant)                │
│  - Arquitectura general                             │
│  - Modelo de BD (tenants, users, solicitudes)       │
│  - Seguridad multitenant                            │
└────────────────┬──────────────────────────────────────┘
                 │
        ┌────────▼──────────┐
        │                   │
    ┌───▼──────┐        ┌──▼────────┐
    │ Frontend │        │ Enterprise│
    │ (UX/UI)  │        │  (Flujos) │
    └──────────┘        │           │
       ├ Dashboard      │ - Flow    │
       ├ Conversaciones │   Builder │
       ├ Solicitudes    │ - AI Brief│
       ├ Agenda         │ - Prompt  │
       ├ Agentes        │   Asst    │
       ├ Flujos◄────────►- Simulat. │
       ├ Configuración  │ - Rescue  │
       └ Facturación    └───────────┘
```

---

## 🔍 Cómo Navegar

### Por Objetivo

**"Quiero entender la arquitectura general"**
→ Lee [prompt-inicial.md](./prompt-inicial.md)

**"Necesito implementar un componente UI nuevo"**
→ Consulta [prompt-front.md](./prompt-front.md)

**"Voy a trabajar con el módulo de flujos"**
→ Lee [prompt-enterprise-flows.md](./prompt-enterprise-flows.md)

### Por Repositorio

**Backend** (`/chatbot/src`)
- Referencia: [prompt-inicial.md](./prompt-inicial.md) (arquitectura, seguridad)
- Referencia: [prompt-enterprise-flows.md](./prompt-enterprise-flows.md) (endpoints /llm/*)

**Frontend** (`/admin/app`)
- Referencia: [prompt-front.md](./prompt-front.md) (componentes, UX)
- Referencia: [prompt-enterprise-flows.md](./prompt-enterprise-flows.md) (módulo flujos)

**Database** (`/chatbot/prisma`)
- Referencia: [prompt-inicial.md](./prompt-inicial.md) (schema inicial)
- Referencia: [prompt-enterprise-flows.md](./prompt-enterprise-flows.md) (flows, flow_sessions)

---

## 📊 Evolución del Proyecto

| Fase | Componente | Estado | Ref |
|------|-----------|--------|-----|
| **0** | SaaS multitenant | ✅ Core | prompt-inicial.md |
| **1** | Frontend profesional | ✅ Implementado | prompt-front.md |
| **2-5** | Flujos inteligentes con IA | ✅ Fase 5 completa | prompt-enterprise-flows.md |
| **Future** | Governance, Learning loops | 🔄 En desarrollo | prompt-enterprise-flows.md |

---

## 🛠️ Mantenimiento de Documentación

### Cuándo Actualizar

- **prompt-inicial.md**: Cambios en arquitectura, BD, seguridad multitenant
- **prompt-front.md**: Nuevos módulos, cambios en UX, nuevos componentes
- **prompt-enterprise-flows.md**: Nuevas fases, endpoints LLM, cambios en flujos

### Cómo Actualizar

1. Edita el archivo `.md` correspondiente
2. Ejecuta: `git add Documentacion/*.md && git commit -m "docs: update [nombre] documentation"`
3. Pushea: `git push origin main`
4. Valida que los cambios aparezcan en GitHub

---

## 📞 Referencias Externas

- **Meta Cloud API**: https://developers.facebook.com/docs/whatsapp/flows/overview
- **Next.js**: https://nextjs.org/docs
- **Prisma ORM**: https://www.prisma.io/docs/
- **Anthropic Claude**: https://docs.anthropic.com/

---

## 📝 Metadata

- **Última actualización**: May 4, 2026
- **Rama principal**: `main`
- **Commits relacionados**: 67e21c4, 6ff8907
- **Documentadores**: Andres Coto (@acotod)

---

## ✅ Checklist de Documentación

- [x] Especificación SaaS multitenant (prompt-inicial.md)
- [x] Especificación frontend profesional (prompt-front.md)
- [x] Especificación módulo de flujos IA (prompt-enterprise-flows.md)
- [x] Índice maestro de documentación (README.md) ← Eres aquí
- [ ] Guía de contribución (CONTRIBUTING.md)
- [ ] Troubleshooting guide (TROUBLESHOOTING.md)
- [ ] Architecture decision records (ADR/)
