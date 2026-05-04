# 🐛 Debugging Errores en Loop — Guía de Uso

Los errores en la consola del navegador desaparecen rápido, pero ahora hemos implementado un **sistema global de logging** que captura y persiste todos los errores. Aquí te muestro cómo usarlo.

---

## 1. **Debug Panel Visual** (Lo más fácil)

Cuando abres la página de login, en la esquina inferior derecha verás un botón:

```
🐛 Debug (X)
```

**Cómo usarlo:**
1. Haz clic en el botón para abrir el panel
2. Verás TODOS los errores, advertencias e info logs con timestamps
3. Cada error muestra:
   - **Level**: ERROR | WARN | INFO
   - **Source**: network | promise | console | custom
   - **Message**: descripción del error
   - **Details**: JSON expandible con más detalles
   - **Timestamp**: hora exacta

**Características:**
- ✅ Se actualiza cada 500ms automáticamente
- ✅ Botón "Clear" para limpiar todos los logs
- ✅ Contador de errores (E:) y warnings (W:)
- ✅ Los logs NO se pierden al recargar
- ✅ Está visible sobre toda la interfaz (z-index: 50)

---

## 2. **Consola del Navegador** (F12)

Además del Debug Panel, todos los errores se logean en la consola de DevTools con color:

- 🔴 **[ERROR]** - rojo
- 🟠 **[WARN]** - naranja
- 🔵 **[INFO]** - azul
- 🟣 **[NETWORK]** - errores HTTP

**Salida ejemplo:**
```
[NETWORK] HTTP 401: /admin/tenants GET
  {status: 401, method: "GET", url: "/admin/tenants", responseError: "Unauthorized"}

[PROMISE] Unhandled Promise Rejection
  {reason: "Connect failed", type: "Error"}
```

---

## 3. **Habilitar "Preserve Logs" en DevTools** (No se borran al recargar)

Si prefieres ver los logs en la consola tradicional sin desaparecer:

1. Abre DevTools (F12)
2. Pestaña **Console**
3. Esquina superior derecha: ⚙️ **Settings**
4. Marca: ✅ **"Preserve log"**
5. Marca: ✅ **"Log XMLHttpRequests"** (opcional)

Ahora los logs se quedarán aunque recargues la página.

---

## 4. **Leer Logs Programáticamente**

Si necesitas ver los logs en la consola sin abrir el panel:

```javascript
// Abre la consola (F12) y copia-pega esto:

// Ver todos los logs en tabla
console.table(getLiveErrors?.())

// Ver logs como JSON
console.log(getLiveErrors?.())

// Limpiar logs
clearLogs?.()
```

Si no reconoce las funciones, necesitas importarlas en la página actual. Esto es más para desarrollo.

---

## 5. **¿Qué Buscar?**

Ahora que los errores quedan capturados, revisa:

1. **Errores de Red** (Network errors):
   - ¿Qué endpoints fallan? (`/auth/login`, `/admin/tenants`, etc.)
   - ¿Qué código HTTP? (400, 401, 403, 500, etc.)
   - ¿Qué es el error? (`Unauthorized`, `Not Found`, etc.)

2. **Errores de Promise** (Unhandled rejections):
   - ¿En qué función? (login, fetch de tenants, Google/Facebook auth)
   - ¿Qué error específico?

3. **Patrones en Loop**:
   - ¿El mismo error se repite? ¿Cada cuántos ms?
   - ¿Es una cascada de errores dependientes?

---

## 6. **Próximos Pasos de Debugging**

1. **Abre login** → observa el Debug Panel
2. **Describe qué ves**: ¿Qué errores aparecen? ¿Cuántos? ¿En qué orden?
3. **Comparte screenshot** del Debug Panel o la consola
4. Investigaremos el problema específico

---

## 7. **Cambios Implementados**

✅ **lib/errorLogger.ts**
- Sistema global que captura TODOS los errores
- Persiste en sessionStorage (max 50 logs)
- Interfaz clara y debuggeable

✅ **components/DebugPanel.tsx**
- Panel visual flotante en esquina inferior derecha
- Muestra errores en tiempo real
- Botón para limpiar logs

✅ **lib/api.ts** (mejorado)
- Captura errores HTTP y logea con detalles
- Información: status, método, URL, error response

✅ **app/login/page.tsx** (mejorado)
- Inicializa error logger al cargar
- Loguea intentos de login
- Mejor manejo de timeouts en tenantApi.list()
- Más logging en Google/Facebook auth

✅ **lib/googleAuth.ts** (arreglado)
- Eliminó anti-pattern de `async` en Promise executor
- Mejor manejo de errores en cascade

---

## Mande Screenshots

Una vez que ejecutes `docker compose up --build -d`, abre http://localhost:3200/login y:

1. **Captura screenshot** del Debug Panel con los errores visibles
2. **O copia el contenido** de la consola (F12 → Console → Select All)

Con eso, podremos identificar exactamente qué está fallando y dónde está el loop infinito.

¡Ahora los errores no pueden escapar! 🎯
