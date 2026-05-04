# PROMPT ENTERPRISE — GENERADOR DE PLATAFORMA DE FLUJOS WABA

## 📍 Referencia Histórica

**Commit origen**: `f7e0c6d` (May 3, 2026)
- Feat: "intelligent flow workflow - AI generation, WhatsApp preview, E2E test"
- Primer módulo de flujos con generación IA

**Commits relacionados a fase de flujos**:
- `fafbc1a`: Add multi-project AI Brief prompt builder
- `1949b87`: Add guided AI Brief prompt builder in flow generator
- `60634d2`: Interactive prompt assistant in flow builder
- `0ebdabc`: Always show reply textarea in prompt assistant
- `0c2fcc1`: Show AI questions in dedicated highlighted panel
- `932ecb8`: Per-question answer inputs in prompt assistant
- `8b7bd5f`: Redesign prompt assistant panel — chat layout, progress bar, chips
- `b71d2d1`: Auto-retry generate-flow on 503/529 with countdown UX
- `424f774`: Fix prompt-assistant-ui
- `20352f1`: Wire intelligent flow designer UI to orchestrator API
- `94267bc`: (Phase 2) Enrich intelligent flow designer UI with analysis detail panels
- `b27499a`: (Phase 3) Dry-run simulation UI — transcript panel + simulate button
- `5d75ac5`: (Phase 4) Governance approval gate + learning loop UI
- `e8f94d4`: (Phase 5) Historial IA panel + métricas del orquestador

---

## 🎯 Objetivo del Módulo

Crear un **generador inteligente de flujos conversacionales** para WhatsApp Flows (Meta Cloud API) que:

1. **Genere flujos automáticamente** usando IA basada en un "AI Brief" (resumen de proyecto)
2. **Permita edición interactiva** con editor visual (ReactFlow)
3. **Preview en tiempo real** de cómo se vería en WhatsApp
4. **Validación y rescate de errores** en flujos
5. **Simulación y dry-run** de flujos antes de publicar
6. **Governance y aprobación** con loops de aprendizaje
7. **Historial y métricas** del orquestador

---

## 🏗️ Arquitectura del Módulo

### Frontend (Next.js)
**Ubicación**: `admin/app/(app)/flujos/page.tsx`

**Componentes principales**:
- `FlowNode.tsx`: Nodo individual en el canvas ReactFlow
- `NodeEditorPanel.tsx`: Panel de edición de propiedades del nodo
- `WhatsAppPreview.tsx`: Preview renderizado como aparecería en WhatsApp

**Flujo de UX**:
1. **AI Brief Builder**: Questionnaire iterativa para recopilar info del proyecto
2. **Generation**: Llamada a `/llm/generate-flow` (backend)
3. **Editor Visual**: Modificación del flujo con ReactFlow + pannels
4. **Prompt Assistant**: Panel Q&A iterativo para refinar el prompt
5. **Simulation**: Dry-run del flujo con transcripción
6. **Validation & Rescue**: Corrección automática de errores
7. **Publish**: Guardar flujo en BD

### Backend (Node.js)
**Ubicación**: `src/routes/llm.js`

**Endpoints**:
- `POST /llm/generate-flow`: Genera flujo inicial desde brief IA
- `POST /llm/prompt-assistant`: Asistente iterativo para refinar prompts
- `POST /llm/simulate-flow`: Ejecuta dry-run del flujo
- `POST /llm/validate-flow`: Valida estructura del flujo
- `POST /llm/repair-flow`: Intenta reparar flujo con errores

**Modelo de datos**:
```typescript
interface Flow {
  id: number
  tenantId: string
  nombre: string
  version: number
  activo: boolean
  metaJson: MetaFlowJson
  nodes: FlowNode[]
  edges: FlowEdge[]
}

interface MetaFlowJson {
  // Estructura nativa de Meta Cloud API
  flows: FlowDefinition[]
  data_api_version: string
}

interface AiBrief {
  projectType: string
  useCase: string
  industry: string
  targetUser: string
  mainGoal: string
  requiredInputs: string
  businessRules: string
  apiIntegrations: string
  expectedOutputs: string
  tone: string
}
```

---

## 🔌 Integración con APIs Externas

### LLM Provider (Anthropic Claude)
- **Usado para**: Generación de flujos, análisis, reparación
- **Env var**: `ANTHROPIC_API_KEY`
- **Modelo**: claude-3-5-sonnet (configurable)

### Meta Cloud API
- **Usado para**: Publicar flujos finales a WhatsApp Business Account
- **Endpoints**: 
  - `POST /{phone-number-id}/message_templates` (guardar flujos)
  - `GET /{flow-id}` (obtener flujo publicado)

---

## 📊 Fase 5: Características Actuales (May 4, 2026)

✅ **Implementado**:
- AI Brief builder (multi-project support)
- Prompt assistant iterativo
- Flow generation vía LLM
- Visual editor con ReactFlow
- WhatsApp preview
- Node types: text, button, list, image, video, document, location
- Real-time simulation
- Error repair loop
- Audit logging

⏳ **En desarrollo**:
- Governance approval workflows
- Learning loop from user interactions
- Template marketplace
- Multi-language flow generation

---

## 🚀 Deployment

**Development**: `http://localhost:3001/flujos` (after login)
**Production**: `https://admin.pmc-dev.com/flujos`

**Permisos requeridos**:
- `VIEW_FLUJOS`: Ver módulo
- `CREATE_FLUJOS`: Crear flujos
- `EDIT_FLUJOS`: Editar flujos
- `DELETE_FLUJOS`: Eliminar flujos
- `PUBLISH_FLUJOS`: Publicar a WhatsApp

---

## 📚 Referencias

- [Prompt Inicial (SaaS Multitenant)](./prompt-inicial.md)
- [Prompt Frontend (UX/UI)](./prompt-front.md)
- Meta Flows Documentation: https://developers.facebook.com/docs/whatsapp/flows/overview
