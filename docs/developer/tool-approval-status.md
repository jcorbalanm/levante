# Estado Actual: Sistema de Aprobación de Herramientas MCP

## Fecha: 2026-01-13

---

## Resumen del Problema

El sistema de aprobación de herramientas MCP **no muestra la UI de aprobación**. La herramienta aparece en estado "Ejecutando..." en lugar de mostrar los botones de "Approve" / "Deny".

---

## Lo que Implementamos

### Archivos Modificados

| Archivo | Cambio |
|---------|--------|
| `src/main/services/ai/mcpToolsAdapter.ts` | Agregamos `needsApproval: true` a todas las herramientas MCP |
| `src/renderer/components/ai-elements/tool-approval.tsx` | **Nuevo**: Componente UI con botones Approve/Deny |
| `src/renderer/components/chat/ChatMessageItem.tsx` | Detecta `part.state === 'approval-requested'` para mostrar la UI |
| `src/renderer/pages/ChatPage.tsx` | Configuramos `sendAutomaticallyWhen` y pasamos `addToolApprovalResponse` |
| `src/main/services/aiService.ts` | Agregamos manejo de `tool-approval-request` |
| `src/renderer/transports/ElectronChatTransport.ts` | Agregamos conversión de chunks de aprobación |
| `src/preload/types/index.ts` | Agregamos tipo `toolApproval` |

---

## El Error Encontrado

### Síntoma
```
partState: "input-available"   ← Lo que llega al frontend
```

Cuando debería ser:
```
partState: "approval-requested"   ← Lo que esperamos
```

### Causa Raíz

El AI SDK emite **dos chunks separados** cuando una herramienta requiere aprobación:

```
Orden de chunks del AI SDK:
1. tool-call              → "Aquí está la llamada a la herramienta"
2. tool-approval-request  → "Esta herramienta necesita aprobación"
```

**El problema**: Nuestro código procesa AMBOS chunks por separado:

1. Cuando llega `tool-call`:
   - Backend emite: `{ toolCall: { status: "running" } }`
   - Transporte emite: `tool-input-available`
   - Frontend establece: `part.state = "input-available"` ✅

2. Cuando llega `tool-approval-request` (justo después):
   - Backend emite: `{ toolApproval: {...} }`
   - Transporte emite: `tool-approval-request`
   - Frontend... **no actualiza el estado** porque ya es "input-available" ❌

### Diagrama del Flujo Actual (Incorrecto)

```
AI SDK                    Backend (aiService)              Frontend
   │                            │                              │
   │ ──tool-call──────────────► │                              │
   │                            │ ─────toolCall────────────────►│
   │                            │                              │ state = "input-available"
   │                            │                              │
   │ ──tool-approval-request──► │                              │
   │                            │ ─────toolApproval────────────►│
   │                            │                              │ state = ??? (no cambia)
   │                            │                              │
   │                            │                              │ 🔴 UI muestra "Ejecutando..."
```

### ¿Por qué no cambia el estado?

El hook `useChat` del AI SDK procesa los chunks en orden. Cuando recibe `tool-input-available`, crea el part con `state: "input-available"`.

Luego, cuando recibe `tool-approval-request`, **debería** actualizar el estado a `approval-requested`, pero:
- O el chunk no tiene el formato correcto
- O useChat no está procesando la actualización correctamente
- O hay un conflicto porque el `tool-input-start` ya se emitió dos veces

---

## Lo que Dice la Documentación del AI SDK

Según la documentación oficial:

> "When a tool requires approval, the tool part state is `approval-requested`"

El flujo esperado es:
1. El servidor usa `streamText` con herramientas que tienen `needsApproval: true`
2. El servidor devuelve el stream usando `result.toUIMessageStreamResponse()`
3. El cliente usa `useChat` que procesa el stream
4. Cuando hay una herramienta con aprobación, `part.state` es automáticamente `approval-requested`

**Problema de nuestra arquitectura**: No usamos `toUIMessageStreamResponse()`. Usamos un transporte IPC custom (`ElectronChatTransport`) que convierte manualmente los chunks.

---

## Opciones de Solución

### Opción A: Bufferear tool-calls (Complejidad: Media)

**Idea**: No emitir `toolCall` inmediatamente. Esperar a ver si llega `tool-approval-request`.

```
AI SDK                    Backend (aiService)              Frontend
   │                            │                              │
   │ ──tool-call──────────────► │                              │
   │                            │ (guarda en buffer, no emite) │
   │                            │                              │
   │ ──tool-approval-request──► │                              │
   │                            │ ─────toolApproval────────────►│
   │                            │                              │ state = "approval-requested"
   │                            │                              │
   │                            │                              │ 🟢 UI muestra Approve/Deny
```

**Cambios necesarios**:
1. En `aiService.ts`: Crear un Map para bufferear `tool-call` chunks
2. En `aiService.ts`: Cuando llega `tool-approval-request`, emitir SOLO `toolApproval`
3. En `aiService.ts`: Cuando llega `tool-result` sin approval previo, emitir `toolCall` + `toolResult`

**Pros**: Solución limpia, sigue el flujo del AI SDK
**Contras**: Añade complejidad al backend

---

### Opción B: Usar toUIMessageStreamResponse() (Complejidad: Alta)

**Idea**: Cambiar la arquitectura para usar el streaming HTTP nativo del AI SDK en lugar de IPC.

**Cambios necesarios**:
1. Crear un servidor HTTP local en el main process
2. Usar `result.toUIMessageStreamResponse()` para el streaming
3. Modificar `ElectronChatTransport` para hacer fetch HTTP en lugar de IPC

**Pros**: Usamos el flujo oficial del AI SDK
**Contras**: Cambio arquitectónico grande, introduce complejidad de servidor HTTP

---

### Opción C: Forzar el estado en el frontend (Complejidad: Baja)

**Idea**: Cuando el transporte recibe `toolApproval`, forzar una actualización del estado del part.

**Cambios necesarios**:
1. En `ElectronChatTransport`: Emitir un chunk especial que fuerce el estado
2. Posiblemente modificar cómo useChat procesa nuestros chunks

**Pros**: Cambio mínimo
**Contras**: Puede no funcionar si useChat no soporta esta actualización

---

## Recomendación

**Opción A (Bufferear tool-calls)** es la más apropiada porque:
- No cambia la arquitectura general
- Resuelve el problema en la raíz (no emitir chunks conflictivos)
- Es relativamente simple de implementar

---

## Próximos Pasos

1. **Implementar buffering en aiService.ts**:
   - Crear Map para pendingToolCalls
   - Modificar caso `tool-call`: guardar en buffer, NO emitir
   - Modificar caso `tool-approval-request`: emitir SOLO toolApproval
   - Modificar caso `tool-result`: emitir toolCall (si no hubo approval) + toolResult

2. **Probar el flujo**:
   - Verificar que `partState` sea `approval-requested`
   - Verificar que la UI de aprobación aparezca
   - Verificar que Approve/Deny funcionen correctamente

3. **Limpiar logs de diagnóstico** (después de que funcione)

---

## Logs de Diagnóstico Actuales

Los logs que agregamos muestran claramente el problema:

```
[AI-SDK] 📡 AI SDK Stream Chunk
  chunkType: "tool-call"
  ...

[AI-SDK] 📡 AI SDK Stream Chunk
  chunkType: "tool-approval-request"
  approvalId: "aitxt-VWw2HcgVzQJXCsN8M2lUk42T"
  ...

[AI-SDK] 🔧 Tool part detected
  partState: "input-available"    ← INCORRECTO, debería ser "approval-requested"
  hasApproval: false              ← INCORRECTO, debería tener approval info
```

Esto confirma que:
- ✅ El AI SDK SÍ emite `tool-approval-request`
- ✅ El backend SÍ lo recibe
- ❌ Pero el frontend recibe el estado incorrecto porque `tool-call` se procesó primero
