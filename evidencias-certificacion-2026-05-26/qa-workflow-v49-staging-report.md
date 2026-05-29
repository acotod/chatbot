# QA Report - Workflow v49 (Staging)

Date: 2026-05-29
Environment: Staging (`admin.pmc-dev.com`)
Scope: Workflow viewer UX + functional flow execution in emulator
Flow: Flujo de WABA
Version validated: v49

## 1. Executive Summary

Status: PASS

The workflow viewer improvements are deployed and visible in staging. Functional simulation completed successfully across all explored routes, with each route reaching an end node.

## 2. Build and Deploy Evidence

- Deployed commit (staging head): `d91fe92`
- Prior UX commit included in deployment: `4363d21`
- Deployment method: remote docker compose rebuild and recreate of `admin`

## 3. Test Coverage

### 3.1 Viewer UX Validation

Checks executed:

1. Open Workflows module and load active flow card.
2. Open Editor view for Flujo de WABA.
3. Confirm version displayed as v49.
4. Confirm new enterprise canvas elements are present:
   - "Flow Workspace"
   - "Visor operacional"
   - KPI cards (Nodos, Conexiones, Activo)
   - Quick action controls (Ajustar al lienzo, Acercar, Alejar, Atajos de teclado)
5. Validate flow integrity using Validate action.

Result: PASS

Observed output: "Valid flow".

### 3.2 Functional Workflow Simulation (Emulator)

Checks executed:

1. Run standard simulation with input sequence.
2. Run AI exploration mode to traverse all paths.
3. Inspect route completion and end-node reachability.

Result: PASS

Observed output:

- "Se exploraron 3 ruta(s) y todas cerraron sin errores."
- "3 ruta(s) completadas"
- "3 ruta(s) alcanzaron un nodo end"

## 4. Routes Verified

### Route 1 (Main path)

`node_1 -> node_8 -> node_3 -> node_4 -> node_5 -> node_12 -> node_7 (end)`

### Route 2 (Alternative branch)

`node_1 -> node_8 -> node_3 -> node_4 (opt_2) -> node_9 (end)`

### Route 3 (Direct branch to end)

`node_1 -> node_8 -> node_3 (opt_2) -> node_7 (end)`

## 5. Evidence Artifacts

Simulation conversation IDs saved by emulator:

1. `baf744f6-1264-4662-8a99-c5ce639c44a2`
2. `77958a5a-6305-439f-9805-79b55f1774db`
3. `f264f0f3-61f0-48be-b5a1-f312cf0d1484`

## 6. Risks and Notes

1. AI reading in emulator reports legacy routing-model warnings (e.g., NODE_G without outgoing edges). This did not block execution and all real paths completed in current flow definition.
2. No blocking defects were detected during the v49 staging run.

## 7. Certification Decision

Decision: APPROVED FOR STAGING QA

Rationale:

1. Viewer UX enhancements are present and operational.
2. Flow validates without structural errors.
3. Emulator confirms all explored routes complete and terminate correctly.
