# Análisis completo del flujo con OpenRouter — Logs del 24-02-2026

> Traza de 4 streams completos para ejecutar `supabase_list_projects` y `supabase_list_tables`.
> Herramienta: `sanitizeMessagesForModel` → `convertToModelMessages` → OpenRouter → AI SDK multi-step.

---

## Stream 2 — `supabase_list_projects` (primera tool aprobada)

### Log 1 — `14:46:35` · `sanitizeMessagesForModel` · `aiService.ts:139`

```json
{
  "partType": "tool-supabase_list_projects",
  "partState": "approval-responded",
  "approvalApproved": true,
  "wasDenied": false,
  "toolCallId": "toolu_vrtx_01T3hTJ6x454mxZC9zZHpqYG"
}
```

**Código ejecutándose:**

```typescript
// aiService.ts líneas 139–162
if (part.state === 'approval-responded') {
  const wasDenied = part.approval?.approved === false; // → false
  if (wasDenied) { /* no entra */ }
  // ← EL BUG: el part sale sin cambios, con state: 'approval-responded' y sin output
}
```

El usuario aprobó la tool. `wasDenied = false`. El bloque `if (wasDenied)` no se ejecuta. El part sale de `sanitize` exactamente igual que entró: `state: 'approval-responded'`, sin campo `output`.

---

### Log 2 — `14:46:35` · `sanitizeMessagesForModel` · `aiService.ts:160`

```
WARN: approval-responded part is APPROVED but NOT converted — will send to convertToModelMessages as-is
```

**Código ejecutándose:**

```typescript
// aiService.ts línea 160
} else {
  logger.aiSdk.warn('[APPROVAL-DEBUG] approval-responded part is APPROVED but NOT converted...');
}
```

Confirmación explícita del bug en el log: el part aprobado pasa a `convertToModelMessages` sin haberse convertido a `output-available`.

---

### Log 3 — `14:46:35` · justo antes de `convertToModelMessages` · `aiService.ts:1235`

```json
{
  "messageId": "zO4doWHvppGlcbVr",
  "toolParts": [{
    "type": "tool-supabase_list_projects",
    "state": "approval-responded",
    "hasOutput": false,
    "approvalApproved": true
  }]
}
```

**Código ejecutándose:**

```typescript
// aiService.ts líneas 1234–1252
const sanitizedMessages = sanitizeMessagesForModel(messagesWithFileParts);
sanitizedMessages.forEach((msg) => {
  // → El log muestra el estado JUSTO ANTES de llamar a convertToModelMessages
});

const result = streamText({
  messages: await convertToModelMessages(sanitizedMessages), // ← envía el payload incorrecto
  ...
});
```

`convertToModelMessages` recibe el part con `state: 'approval-responded'` y **sin `output`**. Por eso genera un bloque `tool_use` en el assistant message pero **ningún `tool_result`** en el mensaje siguiente. El payload enviado a OpenRouter es:

```
[user_msg, assistant(tool_use)]  ← sin tool_result
```

---

### Log 4 — `14:46:37` · `case "finish-step"` · `aiService.ts:1334`

```json
{ "finishReason": "stop" }
```

**Código ejecutándose:**

```typescript
// aiService.ts — dentro del for await (chunk of result.fullStream)
case "finish-step":
  this.logger.aiSdk.info('[APPROVAL-DEBUG] finish-step received', {
    finishReason: chunk.finishReason, // → "stop"
    ...
  });
```

OpenRouter recibió `[user_msg, assistant(tool_use)]` sin `tool_result`. En lugar de rechazarlo con error (como haría Anthropic), **re-generó la llamada a la tool internamente**. El AI SDK, dentro del mismo `streamText`, recibió esa re-petición de tool, **ejecutó `supabase_list_projects` para obtener el resultado real**, y el modelo generó su respuesta de texto. El stream terminó con `"stop"` sin error.

---

### Log 5 — `14:46:37` · después del `for await` · `aiService.ts:1578`

```json
{
  "messageCount": 2,
  "messages": [
    { "role": "tool",      "contentTypes": ["tool-result"] },
    { "role": "assistant", "contentTypes": ["text"] }
  ]
}
```

**Código ejecutándose:**

```typescript
// aiService.ts — nuevo log añadido tras el for await
const responseData = await result.response;
// responseData.messages → lo que el AI SDK generó DENTRO del stream
```

Estos son los mensajes que el AI SDK generó internamente durante el stream:
1. `tool: [tool-result]` → el AI SDK ejecutó `supabase_list_projects` y obtuvo el resultado.
2. `assistant: [text]` → el modelo respondió con texto usando ese resultado.

El estado de `supabase_list_projects` en el renderer se actualiza a `output-available`. `sendAutomaticallyWhen` detecta que `supabase_list_tables` sigue `approval-responded` con `approved: true` → **lanza Stream 3**.

---

## Stream 3 — El modelo llama a `supabase_list_tables`

### Log 6 — `14:46:38` · justo antes de `convertToModelMessages`

```json
{
  "messageId": "zO4doWHvppGlcbVr",
  "toolParts": [{
    "type": "tool-supabase_list_projects",
    "state": "output-available",
    "hasOutput": true
  }]
}
```

`supabase_list_projects` ya está en `output-available` (ejecutada en Stream 2). El payload para este assistant message es **válido**: `convertToModelMessages` generará `tool_use` + `tool_result` correctamente.

---

### Log 7 — `14:46:39` · `case "finish-step"`

```json
{ "finishReason": "tool-calls" }
```

El modelo vio el resultado de `supabase_list_projects` y decidió llamar a `supabase_list_tables`. `finishReason: "tool-calls"` significa que el AI SDK emite un evento `tool-approval-request` para `supabase_list_tables`. El renderer muestra el popup de aprobación al usuario.

---

### Log 8 — `14:46:39` · después del `for await`

```json
{
  "messageCount": 1,
  "messages": [
    { "role": "assistant", "contentTypes": ["tool-call", "tool-approval-request"] }
  ]
}
```

El único mensaje de respuesta es el assistant pidiendo `supabase_list_tables`. La tool no se ejecutó todavía (está en `tool-approval-request`). El usuario aprueba → `sendAutomaticallyWhen` devuelve `true` → **lanza Stream 4**.

---

## Stream 4 — `supabase_list_tables` (segunda tool aprobada)

### Log 9 — `14:46:41` · `sanitizeMessagesForModel` · `aiService.ts:139`

```json
{
  "partType": "tool-supabase_list_tables",
  "partState": "approval-responded",
  "approvalApproved": true,
  "wasDenied": false,
  "toolCallId": "toolu_01JbtcYyJTp9mGrWUJexQuxU"
}
```

**El mismo bug ocurre de nuevo** para `supabase_list_tables`. Mismo código, mismo camino.

---

### Log 10 — `14:46:41` · `sanitizeMessagesForModel` · `aiService.ts:160`

```
WARN: approval-responded part is APPROVED but NOT converted
```

---

### Log 11 — `14:46:41` · justo antes de `convertToModelMessages` · mensaje `zO4doWHvppGlcbVr`

```json
{
  "messageId": "zO4doWHvppGlcbVr",
  "toolParts": [{
    "type": "tool-supabase_list_projects",
    "state": "output-available",
    "hasOutput": true
  }]
}
```

Primer assistant message (de Stream 1): `supabase_list_projects` correctamente en `output-available`. Este mensaje genera un payload válido.

---

### Log 12 — `14:46:41` · justo antes de `convertToModelMessages` · mensaje `egrMLIOVUJokz67N`

```json
{
  "messageId": "egrMLIOVUJokz67N",
  "toolParts": [{
    "type": "tool-supabase_list_tables",
    "state": "approval-responded",
    "hasOutput": false
  }]
}
```

Segundo assistant message (de Stream 3): `supabase_list_tables` sigue en `approval-responded`. **El bug se repite**. OpenRouter recibirá de nuevo `tool_use` sin `tool_result` para esta tool.

---

### Log 13 — `14:46:44` · `case "finish-step"`

```json
{ "finishReason": "stop" }
```

OpenRouter vuelve a aceptar el payload incompleto, re-genera la llamada a `supabase_list_tables`, el AI SDK la ejecuta, el modelo responde. Stream 4 termina correctamente.

---

### Log 14 — `14:46:44` · después del `for await`

```json
{
  "messageCount": 2,
  "messages": [
    { "role": "tool",      "contentTypes": ["tool-result"] },
    { "role": "assistant", "contentTypes": ["text"] }
  ]
}
```

`supabase_list_tables` ejecutada. El modelo tiene ambos resultados y genera la respuesta final. El flujo completa con éxito.

---

## Resumen del flujo completo

```
Stream 2: approval-responded(supabase_list_projects) → sanitize NO convierte → convertToModelMessages genera tool_use sin tool_result
          → OpenRouter acepta (permisivo) → re-genera tool_call → AI SDK ejecuta → supabase_list_projects pasa a output-available
          → sendAutomaticallyWhen detecta supabase_list_tables pendiente → Stream 3

Stream 3: supabase_list_projects(output-available) → payload válido → modelo ve resultado → pide supabase_list_tables
          → AI SDK emite tool-approval-request → usuario aprueba → sendAutomaticallyWhen → Stream 4

Stream 4: approval-responded(supabase_list_tables) → mismo bug → convertToModelMessages genera tool_use sin tool_result
          → OpenRouter acepta → re-genera tool_call → AI SDK ejecuta → respuesta final ✅
```

---

## El bug — Localización exacta

**Archivo:** `src/main/services/aiService.ts`
**Función:** `sanitizeMessagesForModel`
**Líneas:** 139–162

```typescript
if (part.state === 'approval-responded') {
  const wasDenied = part.approval?.approved === false;
  if (wasDenied) {
    // ✅ Caso denegado: convierte correctamente
    part = { ...part, state: 'output-available', output: 'Tool execution was denied by the user.' };
  }
  // ❌ BUG: Caso aprobado → no hace nada
  // El part sale con state: 'approval-responded' y sin output
  // → convertToModelMessages genera tool_use sin tool_result
  // → OpenRouter: acepta (permisivo, pero desperdicia un round-trip extra)
  // → Anthropic: rechaza con 400 (validación estricta) → ERROR FATAL
}
```

**Por qué con OpenRouter funciona (mal):** OpenRouter ignora la ausencia de `tool_result` y re-genera la `tool_call`. El AI SDK la ejecuta en la siguiente ronda del mismo stream. Funciona, pero hace **un round-trip extra innecesario** por cada tool aprobada.

**Por qué con Anthropic falla:** Anthropic valida el payload antes de procesarlo. Detecta `tool_use` sin `tool_result` y devuelve 400 inmediatamente. El stream ni siquiera comienza.

---

## Cómo debería quedar (la corrección)

El flujo correcto requiere que cuando `sanitizeMessagesForModel` encuentra un part en `approval-responded` con `approved: true`, ese part **ya tenga un resultado** antes de llegar a `convertToModelMessages`.

Hay dos opciones:

### Opción A — Ejecutar la tool antes de `convertToModelMessages` (corrección arquitectónica completa)

En `streamChat`, antes de llamar a `streamText`, detectar los parts `approval-responded` (approved=true), ejecutar las tools directamente contra el servidor MCP, y actualizar los parts a `output-available` con el resultado real:

```typescript
// En streamChat, ANTES de llamar streamText:
const sanitizedMessages = sanitizeMessagesForModel(messagesWithFileParts);

// Ejecutar tools aprobadas pendientes
for (const msg of sanitizedMessages) {
  if (msg.role !== 'assistant') continue;
  for (const part of msg.parts ?? []) {
    if (part.state === 'approval-responded' && part.approval?.approved === true) {
      const result = await executeMCPTool(part.toolName, part.input); // llamada real al servidor MCP
      part.state = 'output-available';
      part.output = result;
    }
  }
}

// Ahora convertToModelMessages recibe todos los parts en output-available → payload válido
const result = streamText({
  messages: await convertToModelMessages(sanitizedMessages),
  ...
});
```

Ventaja: Anthropic recibe un payload válido desde el primer intento. Sin round-trips extra.
Desventaja: requiere acceso al cliente MCP desde `sanitizeMessagesForModel` o desde `streamChat` antes de `streamText`.

### Opción B — Excluir la tool_call del contexto si no tiene resultado (degradación controlada)

Si el part está en `approval-responded` (approved=true) sin output, eliminar ese tool part del assistant message. El modelo "olvida" que llamó a esa tool, pero el stream no falla:

```typescript
if (part.state === 'approval-responded' && part.approval?.approved === true) {
  return null; // filtrar este part del array
}
// Después filtrar nulls del array de parts
```

Ventaja: implementación simple, elimina el error de Anthropic.
Desventaja: el contexto del modelo pierde la información de qué tool se iba a ejecutar. El modelo tendrá que "recordarlo" de otro modo (texto previo).

---

*Generado: 2026-02-24*
