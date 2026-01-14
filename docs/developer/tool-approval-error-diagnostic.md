# Diagnóstico: Error después de aprobar herramienta MCP

## Fecha: 2026-01-13 (RESUELTO)

## Resumen del Problema

Cuando el usuario aprueba una herramienta MCP (ej: `supabase_list_projects`), la herramienta se ejecuta correctamente y devuelve resultados, pero luego el flujo se interrumpe con errores.

### Errores Observados

| Proveedor | Error | Código |
|-----------|-------|--------|
| OpenRouter | `Internal Server Error` | 500 |
| Anthropic Directo | `messages.1.content.1.tool_use.input: Field required` | 400 |

---

## 🔴 CAUSA RAÍZ IDENTIFICADA

El error de Anthropic directo revela la causa raíz real:

```
messages.1.content.1.tool_use.input: Field required
```

**El campo `input` está faltando en el `tool_use`** cuando se envía el mensaje al modelo después de ejecutar la herramienta.

### ¿Qué significa esto?

Anthropic requiere que cada `tool_use` en el historial de mensajes tenga un campo `input` obligatorio. El formato esperado es:

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "supabase_list_projects",
      "input": {}  // ◄── ESTE CAMPO ES OBLIGATORIO
    }
  ]
}
```

Pero el mensaje que se está enviando tiene `input: undefined` o no tiene el campo `input`.

---

## Análisis de los Logs

### Evidencia del Problema

En los logs del tool part, observamos:

```
[AI-SDK] [DEBUG] 🔧 Tool part detected
  messageId: "xRuS0CswIDg3jY0U"
  partType: "tool-supabase_list_projects"
  partState: "output-available"
  allKeys: ["type", "toolCallId", "state", "title", "input", "output", ...]
```

El `input` está en las keys, pero mirando el chunk de tool-result:

```json
{
  "type": "tool-result",
  "toolCallId": "toolu_01Q1Hqvn2QmieLCKZytJExTa",
  "toolName": "supabase_list_projects",
  "output": "[{...}]",
  "dynamic": false
}
```

**Nota: El `input` no aparece explícitamente en el tool-result chunk.** La herramienta `list_projects` no tiene argumentos, por lo que `input` es `undefined` o `{}`.

### Flujo del Problema

```
1. Usuario aprueba herramienta ✓
2. Herramienta se ejecuta con args: undefined ✓
3. Resultado recibido correctamente ✓
4. AI SDK construye mensaje para continuar
5. El mensaje incluye tool_use con input: undefined ◄── PROBLEMA
6. Anthropic rechaza el mensaje (400 Bad Request)
```

---

## Diagnóstico Técnico Detallado

### El Request que Falla

```javascript
requestBodyValues: {
  model: 'claude-haiku-4-5-20251001',
  messages: [
    { /* mensaje usuario */ },
    {
      // mensaje assistant con tool_use
      content: [
        { type: "tool_use", id: "...", name: "...", input: undefined }  // ◄── FALLO
      ]
    },
    { /* mensaje con tool_result */ }
  ],
  tools: [...],
}
```

### Ubicación del Bug

El problema está en cómo se construye el mensaje del historial cuando:

1. Una herramienta con `needsApproval: true` es aprobada
2. La herramienta no tiene argumentos (input vacío)
3. El AI SDK serializa el mensaje con `input: undefined` en lugar de `input: {}`

### Archivos a Investigar

1. **`src/main/services/aiService.ts`**
   - Función que sanitiza/convierte mensajes para el modelo
   - Buscar `convertToModelMessages` o similar
   - Verificar cómo se manejan los tool_use parts

2. **`src/renderer/transports/ElectronChatTransport.ts`**
   - Cómo se reconstruyen los mensajes desde chunks
   - El chunk `tool-approval-request` podría no incluir `input`

3. **AI SDK interno**
   - El SDK podría estar pasando `input: undefined` cuando no hay argumentos

---

## Evidencia Adicional

### Herramienta sin argumentos

La herramienta `list_projects` de Supabase no requiere argumentos:

```
[AI-SDK] [DEBUG] Executing MCP tool
  serverId: "supabase"
  toolName: "list_projects"
  args: undefined  ◄── Sin argumentos
```

Esto es válido para MCP, pero cuando se serializa para Anthropic:
- `input: undefined` → Error
- `input: {}` → Válido

### Por qué OpenRouter da 500 en lugar de 400

OpenRouter probablemente:
1. Intenta procesar el request
2. Lo envía a Anthropic
3. Anthropic rechaza con 400
4. OpenRouter devuelve 500 (error interno) en lugar de propagar el 400

---

## Solución Propuesta

### Fix 1: Sanitizar `input` en tool_use (Recomendado)

En `aiService.ts` o donde se construyan los mensajes:

```typescript
// Antes de enviar mensajes al modelo
function sanitizeToolUseInput(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (msg.role === 'assistant' && msg.content) {
      const content = Array.isArray(msg.content) ? msg.content : [msg.content];
      return {
        ...msg,
        content: content.map(part => {
          if (part.type === 'tool_use' || part.type?.startsWith('tool-')) {
            return {
              ...part,
              input: part.input ?? {}  // Asegurar que input nunca sea undefined
            };
          }
          return part;
        })
      };
    }
    return msg;
  });
}
```

### Fix 2: En el Transport

En `ElectronChatTransport.ts`, asegurar que `tool-approval-request` incluya `input`:

```typescript
yield {
  type: "tool-approval-request",
  toolCallId: chunk.toolApproval.toolCallId,
  toolName: chunk.toolApproval.toolName,
  input: chunk.toolApproval.input ?? {},  // ◄── Nunca undefined
  approvalId: chunk.toolApproval.approvalId,
};
```

### Fix 3: En el mcpToolsAdapter

Al emitir el chunk de tool-approval:

```typescript
yield {
  toolApproval: {
    approvalId: (chunk as any).approvalId,
    toolCallId: (chunk as any).toolCall?.toolCallId,
    toolName: (chunk as any).toolCall?.toolName,
    input: (chunk as any).toolCall?.input ?? {},  // ◄── Nunca undefined
  },
};
```

---

## Pasos para Verificar

1. **Agregar log del request body completo** antes de enviarlo a Anthropic:
   ```typescript
   logger.debug("Request to model", {
     messages: JSON.stringify(messages, null, 2)
   });
   ```

2. **Buscar el valor de `input`** en el tool_use del mensaje assistant

3. **Verificar** si `input` es `undefined`, `null`, o simplemente no existe

---

## Timeline del Bug

```
21:51:45 - Herramienta ejecutada (args: undefined)
21:51:46 - Resultado recibido exitosamente
21:51:46 - Tool result procesado
21:51:54 - Segunda llamada al modelo FALLA
         - OpenRouter: 500 Internal Server Error
         - Anthropic: 400 "input: Field required"
```

---

## Conclusión

El bug está en la **serialización del historial de mensajes** cuando se envía al modelo después de ejecutar una herramienta. El campo `input` del `tool_use` es `undefined` en lugar de `{}`, lo que viola el schema de la API de Anthropic.

**Prioridad**: Alta - Este bug bloquea completamente el flujo de tool approval.

**Esfuerzo estimado**: Bajo - Es un fix de una línea (`input ?? {}`)

**Archivos modificados**:
1. `src/main/services/aiService.ts` - Sanitizar mensajes y fix en tool-approval-request
2. `src/renderer/transports/ElectronChatTransport.ts` - Fix defensivo en transport

---

## Solución Implementada (2026-01-13)

Se implementaron fixes en 3 puntos del flujo:

### 1. aiService.ts - Extracción de input (líneas 1188-1230)
- Tipado del chunk `tool-approval-request`
- Log de diagnóstico con estructura completa del chunk
- Garantía de que `input` nunca sea undefined: `toolInput = approvalChunk.toolCall?.input ?? {}`

### 2. ElectronChatTransport.ts - Conversión de chunks (líneas 297-326)
- Log de diagnóstico del chunk recibido
- Protección defensiva: `safeInput = chunk.toolApproval.input ?? {}`

### 3. sanitizeMessagesForModel - Sanitización de mensajes (líneas 110-117)
- Asegura que TODAS las tool parts tengan `input` definido antes de enviar al modelo
- Última línea de defensa contra `input: undefined`

```typescript
if (part.type?.startsWith('tool-') || part.type === 'tool-invocation') {
  if (part.input === undefined || part.input === null) {
    part = { ...part, input: {} };
  }
}
```
