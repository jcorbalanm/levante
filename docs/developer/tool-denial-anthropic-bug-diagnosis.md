# Diagnóstico: Error `tool_use` sin `tool_result` en Anthropic en el flujo de aprobación de tools

> **Error reproducido**: `messages.1: tool_use ids were found without tool_result blocks immediately after: toolu_01Ty8BX4pwBXJspjjNYkMQik. Each tool_use block must have a corresponding tool_result block in the next message.`
>
> **Proveedor afectado**: Anthropic (directamente y via OpenRouter con modelos Claude)
>
> **Cuándo ocurre**: En el flujo de aprobación de tools, **tanto si el usuario aprueba como si deniega** la ejecución.

---

## 1. Qué significa el error

La API de Anthropic tiene una restricción estricta en su formato de mensajes:

> Después de un mensaje `assistant` que contiene uno o más bloques `tool_use`, el **siguiente mensaje** (rol `user`) **DEBE** contener exactamente un bloque `tool_result` por cada `tool_use`.

El error indica que Anthropic está recibiendo una secuencia como esta:

```
messages[0] = { role: "user", content: "mensaje del usuario" }
messages[1] = { role: "assistant", content: [{ type: "tool_use", id: "toolu_01Ty8BX..." }] }
             ← ERROR AQUÍ: falta tool_result inmediatamente después
messages[2] = { role: "user", content: "siguiente mensaje" }
             ← debería contener tool_result pero no lo tiene
```

OpenAI y otros proveedores son más permisivos con este requisito. Anthropic lo valida estrictamente.

---

## 2. Por qué el flujo de aprobación rompe la estructura de mensajes

### 2.1 Flujo normal (sin aprobación)

En un flujo sin aprobación (`needsApproval: false`), todo ocurre dentro de **un único `streamText`**:

```
streamText → Anthropic responde con tool_use
           → AI SDK ejecuta la tool (execute())
           → AI SDK genera tool_result
           → Anthropic recibe: assistant(tool_use) + user(tool_result) ← CORRECTO
```

La estructura de mensajes nunca queda en estado intermedio porque la ejecución es síncrona dentro del mismo stream.

### 2.2 Flujo con aprobación (causa del problema)

Con `needsApproval: true`, el flujo se **parte en dos streams separados**:

**Stream 1** (primera llamada del usuario):
```
transport.sendMessages → streamChat → streamText
  → Anthropic responde con tool_use
  → AI SDK detecta needsApproval: true → NO ejecuta la tool
  → AI SDK emite: tool-approval-request
  → streamChat yielda chunk toolApproval al renderer
  → renderer: part.state = 'approval-requested'
  → [EL STREAM TERMINA AQUÍ - la tool NO se ejecutó, NO hay tool_result]
```

**Stream 2** (triggered automáticamente por `sendAutomaticallyWhen` si se aprueba, o manualmente por el usuario si se deniega):
```
transport.sendMessages → streamChat → streamText
  → messages AHORA INCLUYEN el assistant message con la tool en estado 'approval-responded'
  → sanitizeMessagesForModel() → [ver sección 3]
  → convertToModelMessages() → genera tool_use en el assistant message
                             → NO genera tool_result (ver sección 3)
  → streamText llama a Anthropic con: assistant(tool_use) SIN tool_result
  → Anthropic: ERROR 400
```

El error ocurre porque entre el Stream 1 y el Stream 2 los mensajes quedan en un estado intermedio (`approval-responded`) que no tiene representación válida en el formato que Anthropic espera.

---

## 3. El bug concreto: `sanitizeMessagesForModel` solo maneja el caso de denegación

**Archivo**: `src/main/services/aiService.ts` (líneas 135–148)

```typescript
// FIX: Handle denied tool approvals
if (part.state === 'approval-responded') {
  const wasDenied = part.approval?.approved === false;
  if (wasDenied) {                           // ← Solo actúa si es denegación
    part = {
      ...part,
      state: 'output-available',
      output: 'Tool execution was denied by the user.',
    };
  }
  // Si approved === true → NO hace nada ← AQUÍ ESTÁ EL BUG para el caso de aprobación
}
```

### Caso DENEGACIÓN (parcialmente manejado)

El código intenta convertir el part denegado a `output-available` para que `convertToModelMessages` pueda generar un `tool_result` con el mensaje de denegación. Esta corrección **podría funcionar** si:
1. `part.approval?.approved === false` es alcanzable (ver sección 4)
2. `convertToModelMessages` reconoce el part convertido correctamente

### Caso APROBACIÓN (completamente sin manejar)

Cuando `sendAutomaticallyWhen` devuelve `true` y el AI SDK lanza el Stream 2:

- El part tiene `state: 'approval-responded'` con `approval.approved = true`
- `sanitizeMessagesForModel` entra en el bloque `if (part.state === 'approval-responded')` pero `wasDenied` es `false`
- **No se hace ninguna conversión**
- El part permanece en estado `approval-responded` (aprobado)
- `convertToModelMessages` genera el bloque `tool_use` del mensaje assistant, pero **no puede generar un `tool_result`** porque el part no está en `output-available`
- Anthropic recibe `tool_use` sin `tool_result` → **ERROR**

---

## 4. El problema estructural: la arquitectura de dos streams

### 4.1 Por qué existe la partición en dos streams

El AI SDK v5 con `needsApproval: true` fue diseñado para transportes HTTP stateful donde el mismo stream puede recibir de vuelta la respuesta de aprobación. Con el transporte Electron IPC (`ElectronChatTransport`), la aprobación no puede volver al stream original porque:

- El Stream 1 termina cuando el renderer recibe el chunk `toolApproval`
- La aprobación del usuario llega vía `addToolApprovalResponse` en el renderer
- `sendAutomaticallyWhen` devuelve `true` → el AI SDK crea un Stream 2 completamente nuevo
- El Stream 2 recibe como entrada los UIMessages con la tool en estado `approval-responded`

### 4.2 Lo que necesitaría ocurrir en el Stream 2

Para que Anthropic acepte los mensajes del Stream 2, la conversación debe llegar en uno de estos formatos válidos:

**Opción A** (tool ejecutada antes del stream 2):
```
messages → convertToModelMessages:
  user: "mensaje inicial"
  assistant: [tool_use: toolu_01...]
  user: [tool_result: toolu_01... → "resultado de la tool"]
  ← Anthropic acepta y genera respuesta
```

**Opción B** (tool no incluida en los mensajes al reanudar):
```
messages → convertToModelMessages:
  user: "mensaje inicial"
  assistant: [texto previo a la tool, SIN tool_use]
  ← Anthropic responde sin saber que había una tool (tool call perdida)
```

Lo que ocurre actualmente (incorrecto):
```
messages → convertToModelMessages:
  user: "mensaje inicial"
  assistant: [tool_use: toolu_01...]   ← viene del contenido del assistant message
  ← NO hay tool_result porque el part está en 'approval-responded', no 'output-available'
  → Anthropic: ERROR 400
```

---

## 5. Secuencia temporal completa del error (caso aprobación)

```
t=0  Usuario: "usa la herramienta X"
     → transport.sendMessages (Stream 1)
     → streamText → Anthropic: assistant con tool_use
     → AI SDK: needsApproval=true → NO ejecuta la tool
     → streamChat yields toolApproval chunk
     → renderer: part.state = 'approval-requested'

t=1  UI muestra popup de aprobación
     Usuario hace clic en "Approve"
     → addToolApprovalResponse({ id: approvalId, approved: true })
     → AI SDK: part.state = 'approval-responded', part.approval.approved = true
     → sendAutomaticallyWhen evalúa → true (todos approved)
     → AI SDK lanza automáticamente transport.sendMessages (Stream 2)

t=2  Stream 2: transport.sendMessages recibe messages con:
     {
       role: "assistant",
       parts: [
         { type: "text", text: "Voy a usar la herramienta..." },
         { type: "tool-???", state: "approval-responded", approval: { approved: true } }
       ]
     }

t=3  streamChat → sanitizeMessagesForModel(messages)
     → part.state === 'approval-responded' → entra en el bloque
     → wasDenied = (true === false) = false
     → NO hace ninguna conversión ← EL BUG
     → part sigue en estado 'approval-responded' (aprobado)

t=4  convertToModelMessages(sanitizedMessages)
     → Genera el assistant message con tool_use (del contenido del part)
     → NO genera tool_result (el part no está en 'output-available')
     → Resultado: [user_msg, assistant(tool_use)]  ← sin tool_result

t=5  streamText llama a Anthropic API con esa secuencia de mensajes
     → Anthropic valida: assistant(tool_use) sin tool_result en el siguiente mensaje
     → ERROR 400: "tool_use ids were found without tool_result blocks"
```

---

## 6. Secuencia temporal completa del error (caso denegación)

```
t=0  [igual que arriba hasta la UI de aprobación]

t=1  Usuario hace clic en "Deny"
     → addToolApprovalResponse({ id: approvalId, approved: false })
     → AI SDK: part.state = 'approval-responded', part.approval.approved = false
     → sendAutomaticallyWhen evalúa → false (hay denegaciones)
     → NO se lanza Stream 2 automáticamente
     → Usuario debe enviar manualmente un nuevo mensaje

t=2  Usuario escribe: "¿qué ibas a hacer?"
     → sendMessage("¿qué ibas a hacer?")
     → AI SDK: añade new user message, llama transport.sendMessages (Stream 2)

t=3  Stream 2: transport.sendMessages recibe messages con:
     {
       role: "assistant",
       parts: [
         { type: "text", text: "Voy a usar la herramienta..." },
         { type: "tool-???", state: "approval-responded", approval: { approved: false } }
       ]
     }

t=4  streamChat → sanitizeMessagesForModel(messages)
     → part.state === 'approval-responded' → entra en el bloque
     → wasDenied = (false === false) = true
     → Convierte a: { state: 'output-available', output: 'Tool execution was denied...' }
     ← Esta conversión DEBERÍA funcionar... si:
        a) part.approval?.approved devuelve exactamente false (no undefined)
        b) convertToModelMessages reconoce el part convertido correctamente

t=5  convertToModelMessages(sanitizedMessages)
     → Si la conversión funcionó: genera assistant(tool_use) + user(tool_result con denial)
        → Anthropic acepta ← OK
     → Si la conversión falló (a o b arriba): igual que el caso aprobación
        → Anthropic: ERROR 400
```

---

## 7. Resumen de los dos fallos

| Caso | `sanitizeMessagesForModel` | Resultado |
|------|---------------------------|-----------|
| **Aprobado** | **No hace nada** (wasDenied = false) | Part queda en `approval-responded` → `convertToModelMessages` genera `tool_use` sin `tool_result` → **ERROR Anthropic** siempre |
| **Denegado** | Intenta convertir a `output-available` | Puede funcionar si la estructura es correcta, o fallar silenciosamente si `part.approval?.approved` no es exactamente `false` → **ERROR Anthropic** intermitente |

El **caso aprobado es el más grave** porque es un bug garantizado (100% de reproducibilidad). El caso denegado tiene una corrección implementada que puede o no funcionar dependiendo de detalles internos del AI SDK v5.

---

## 8. Por qué Anthropic y no otros proveedores

OpenAI, Groq, xAI y otros proveedores no están afectados porque:
1. Están listados en `providersWithoutToolApproval` en `src/types/preferences.ts:154` → el flujo de aprobación está desactivado para ellos (tools se ejecutan sin confirmación)
2. OpenRouter con modelos no-Anthropic es más permisivo con `tool_use` sin `tool_result`

```typescript
// src/types/preferences.ts:154
providersWithoutToolApproval: ["vercel-gateway", "local", "google", "groq", "xai", "huggingface"],
// "anthropic" y "openai" NO están en la lista → flujo de aprobación activo
```

Anthropic (directamente) activa el flujo de aprobación y tiene la validación más estricta del formato de mensajes.

---

## 9. Archivos clave

| Archivo | Línea(s) | Problema |
|---------|----------|---------|
| `src/main/services/aiService.ts` | 139–148 | `sanitizeMessagesForModel`: solo maneja denegación, no aprobación |
| `src/renderer/pages/ChatPage.tsx` | 309–332 | `sendAutomaticallyWhen`: lanza el Stream 2 con parts en estado `approval-responded` no sanitizado |
| `src/renderer/transports/ElectronChatTransport.ts` | 313–334 | Emite `tool-approval-request` con `as any`; la estructura exacta del part resultante en el AI SDK no está garantizada |
| `src/types/preferences.ts` | 154 | `anthropic` no está en `providersWithoutToolApproval` → flujo de aprobación activo |

---

## 10. Verificación rápida recomendada

Añadir logging antes de `convertToModelMessages` para confirmar el estado de los parts en el Stream 2:

```typescript
// En aiService.ts, justo antes de la llamada a streamText:
const messagesForModel = sanitizeMessagesForModel(messagesWithFileParts);
messagesForModel.forEach((msg: any) => {
  if (msg.role === 'assistant') {
    msg.parts?.forEach((p: any) => {
      if (p.type?.startsWith('tool-')) {
        console.log('[DIAGNOSE] Assistant tool part before convertToModelMessages:', {
          type: p.type,
          state: p.state,
          approvalApproved: p.approval?.approved,
          hasOutput: !!p.output,
        });
      }
    });
  }
});
```

Si en el caso de aprobación se ve `state: 'approval-responded'` (no `output-available`), se confirma el bug de la sección 3.

---

## 11. Workaround inmediato disponible

Añadir `"anthropic"` a `providersWithoutToolApproval` en `src/types/preferences.ts:154` desactiva el flujo de aprobación para modelos Anthropic directos. Esto elimina el error pero también elimina la funcionalidad de aprobación de tools para ese proveedor.

> ⚠️ **NO es la solución correcta**. Es una degradación de funcionalidad, no una corrección.

---

*Diagnóstico actualizado: 2026-02-24*
*Corrección: el error ocurre tanto para aprobación como para denegación, con causas distintas en cada caso.*
