# Informe Ejecutivo — Mejoras en Asignación de Citas y Calendario

**Fecha:** 9 de octubre de 2026
**Estado:** ✅ Desplegado en producción
**Pull Request:** [#2 — Fix appointment/calendar assignment GAP (G1-G9)](https://github.com/acotod/chatbot/pull/2)

---

## 1. Contexto

Se realizó una auditoría del módulo de agendamiento de citas (el sistema que asigna clientes a agentes/psicólogos vía WhatsApp y que el equipo administra desde el panel). Se identificaron **9 puntos de riesgo** que podían afectar la operación diaria: desde dobles reservas hasta inconsistencias al desactivar temporalmente a un agente.

## 2. Problemas encontrados y resueltos

| # | Problema de negocio | Riesgo si no se corregía | Solución aplicada |
|---|---|---|---|
| 1 | Un agente podía quedar **doblemente agendado** (una cita de cliente y una reunión interna al mismo tiempo) sin ninguna alerta. | Citas perdidas, mala experiencia del cliente, reuniones internas interrumpidas. | El sistema ahora **detecta el conflicto automáticamente** y lo bloquea; un administrador puede forzar la asignación solo de forma explícita, y esa decisión queda **registrada en auditoría**. |
| 2 | La estrategia de reparto de citas entre agentes de un mismo puesto ("por turnos", "al azar") **no tenía efecto real** en el escenario más común de uso. | El reparto de carga de trabajo configurado por el administrador no se aplicaba como se esperaba. | Se corrigió el mecanismo de asignación para que la estrategia elegida sí determine quién recibe la cita. |
| 3 | No existía forma de **marcar carga de trabajo** al repartir citas (solo azar o turnos fijos). | Un agente podía terminar con muchas más citas que otro. | Se agregó una estrategia **"menos ocupado"**, que reparte citas según quién tiene menos agenda en los próximos días. |
| 4 | El reparto por turnos ("round robin") se **desordenaba** si se agregaba o quitaba un agente del puesto. | Reparto injusto o errático tras cambios de personal. | El mecanismo ahora es estable ante altas/bajas de personal. |
| 5 | Para poner a un agente "de vacaciones" sin que reciba nuevas citas, **había que desactivar toda su cuenta** (perdía acceso, se quitaba de todo lo demás). | Fricción operativa innecesaria; o el agente seguía recibiendo citas si no se desactivaba del todo. | Se agregó un **interruptor independiente** ("Disponible para citas") en la ficha del agente — puede estar activo en el sistema pero temporalmente fuera de la agenda, con fecha de regreso automática opcional. |
| 6 | No había forma de registrar si un cliente **no asistió** a la cita o si esta se completó. | Imposible medir inasistencias ni cerrar el ciclo de la cita. | Se agregaron botones **"Marcar completada"** / **"No asistió"** en la agenda del administrador. |
| 7 | Si la sincronización con Google Calendar fallaba a mitad de camino, podían quedar **eventos huérfanos** en el calendario del agente. | Confusión visual en el calendario del agente, eventos fantasma. | Se agregó un proceso automático que **detecta y repara** estos casos sin generar duplicados. |
| 8 | Parches menores de seguridad y consistencia encontrados durante la revisión (ej. un interruptor de "forzar" que podía malinterpretarse si llegaba como texto en vez de verdadero/falso). | Riesgo bajo pero real de bypass accidental de las nuevas protecciones. | Corregidos y verificados. |

## 3. Validación realizada

- **Revisión de código línea por línea** de todos los cambios, con corrección de bugs encontrados antes de llegar a producción.
- **Pruebas automatizadas**: 198 pruebas, todas exitosas.
- **Pruebas funcionales en vivo**: se simularon escenarios reales (dos agentes, citas, conflictos, vacaciones, turnos) contra una copia de la base de datos, confirmando que cada corrección funciona de punta a punta antes de tocar producción.

## 4. Despliegue

- Cambios integrados mediante un **Pull Request formal** (revisión de código) antes de salir a producción.
- Se detectó que el servidor de producción tenía una **configuración de seguridad de red** (puertos de base de datos/caché no expuestos a internet) que no estaba respaldada en el control de versiones — se formalizó para que no se pierda en futuros despliegues.
- Se aplicó la actualización de base de datos necesaria sin tiempo de inactividad.
- **Confirmado en producción**: todos los servicios reiniciados correctamente, sin errores, sin interrupciones para los usuarios.

## 5. Pendientes (no urgentes, documentados para decisión futura)

- Selector de fecha específica para "regreso de vacaciones" del agente (hoy es un interruptor simple on/off).
- Evaluar si la opción de "forzar" una cita en conflicto debe limitarse a un rol más alto que el actual (se revisó y no se considera urgente).

---

**Resumen en una línea:** se cerraron los 9 huecos identificados en la asignación de citas, se validó exhaustivamente antes y después del despliegue, y el cambio ya está en producción funcionando sin incidentes.
