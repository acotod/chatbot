# Acta Final de Certificacion Funcional y Cumplimiento

- Proyecto: Chatbot SaaS WhatsApp
- Fecha: 2026-05-26
- Entorno evaluado: Local + Staging tecnico
- Commit base observado: dc664a8
- Evaluador: GitHub Copilot (GPT-5.3-Codex)

## Fuentes de evidencia

- README.md
- PHASE_1_E2E_TESTING.md
- PHASE_SECURITY_TESTING_DEPLOYMENT.md
- PHASE_2_3_COMPLETION_SUMMARY.md
- diagnostic_full.sh
- diag_horario_staging.sh

## Resultado por Gate

### Gate 1: Salud de plataforma
- Estado: PASS
- Evidencia:
  - docker compose ps: servicios principales arriba (api, admin, postgres, redis, wa-worker)
  - Health API: GET /health responde {"status":"ok"}

### Gate 2: Regresion automatizada
- Estado: PASS
- Evidencia:
  - Smoke: PASS (VERDICT=PASS)
  - Full: PASS (VERDICT=PASS)
  - Resumen full: 16 suites exitosas, 0 fallidas, 149 tests exitosos, 0 fallidos
- Observacion:
  - Se aplicaron correcciones a mocks, expectativas y aislamiento de runner para alinear suites con comportamiento actual de rutas y seguridad

### Gate 3: E2E funcional negocio
- Estado: FAIL
- Evidencia:
  - Ejecucion de diag_horario_staging.sh
  - STAGING_HORARIO_VERDICT=FAIL
  - Casos ID_8, ID_14 y TEXT_8AM terminan en mensaje de validacion de identificacion externa sin completar reserva
- Hallazgo:
  - El flujo en staging queda bloqueado por validacion de identificacion (servicio externo) y no avanza a confirmacion de horario

### Gate 4: Seguridad y despliegue
- Estado: FAIL (condicional)
- Evidencia positiva:
  - docker-compose.yml usa JWT_SECRET desde entorno sin fallback fijo
  - docker-compose.yml usa env_file
  - .env esta ignorado en .gitignore
  - src/app.js incluye helmet y cors
  - src/routes/auth.js incluye rate limiting (windowMs, max)
- Evidencia negativa:
  - npm audit (backend): 6 vulnerabilidades moderadas
  - npm audit (admin): 4 vulnerabilidades (3 moderadas, 1 alta en next)

### Gate 5: Compliance Meta/WhatsApp
- Estado: PENDIENTE / BLOQUEADO
- Observacion:
  - Requiere validacion en Meta App Dashboard (Advanced Access, policy status, account quality)
  - No se certifica localmente sin aprobacion externa de Meta

## Dictamen final

- Resultado global: NO APROBADO
- Motivo:
  - Gate 3 FAIL
  - Gate 4 FAIL (vulnerabilidades abiertas)
  - Gate 5 pendiente externo

## Plan de cierre recomendado

1. Resolver la dependencia de validacion de identificacion en staging (servicio externo o fallback controlado) para destrabar el flujo de horario.
2. Re-ejecutar diag_horario_staging.sh hasta obtener STAGING_HORARIO_VERDICT=PASS en casos ID_8, ID_14 y TEXT_8AM.
3. Resolver vulnerabilidades con npm audit fix y upgrades controlados (incluyendo next).
4. Completar aprobaciones de Meta para compliance final (Advanced Access y estado de policy/account quality).
