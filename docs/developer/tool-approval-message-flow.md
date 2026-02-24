# Flujo de mensajes en el sistema de aprobación de tools

> Trazabilidad completa con JSONs reales basados en los logs del 24-02-2026.
> Herramientas involucradas: `supabase_list_projects` y `supabase_list_tables`.

---

## ¿Qué es `convertToModelMessages`?

El AI SDK maneja los mensajes en **dos formatos distintos**:

| Formato | Dónde se usa | Para qué |
|---------|-------------|----------|
| **UIMessage** | React (`useChat`), renderer, base de datos | Renderizar la UI, trackear estados de approval, streaming |
| **ModelMessage** (CoreMessage) | Llamadas a la API de Anthropic/OpenAI | Lo que el modelo entiende: texto, tool_use, tool_result |

**`convertToModelMessages`** es la función del AI SDK que transforma el array de `UIMessage[]` en `ModelMessage[]` justo antes de enviarlo al proveedor.

El problema es que `UIMessage` tiene estados internos ricos (`approval-requested`, `approval-responded`, `output-available`) que **el modelo nunca ve**. `convertToModelMessages` tiene que traducirlos al protocolo binario que entiende Anthropic: cada `tool_use` del assistant **debe** tener su `tool_result` en el siguiente mensaje de usuario.

---

## Stream 1 — Primera llamada al modelo

### 1.1 `ElectronChatTransport.sendMessages`

El usuario escribe "Lista mis proyectos y tablas de Supabase". El transport envía los mensajes via IPC al main process.

```json
[
  {
    "id": "usr-001",
    "role": "user",
    "parts": [{ "type": "text", "text": "Lista mis proyectos y tablas de Supabase" }]
  }
]
```

---

### 1.2 `sanitizeMessagesForModel`

No hay parts de tools todavía. La función devuelve los mensajes sin cambios.

```json
[
  {
    "id": "usr-001",
    "role": "user",
    "parts": [{ "type": "text", "text": "Lista mis proyectos y tablas de Supabase" }]
  }
]
```

---

### 1.3 `convertToModelMessages`

Convierte a formato Anthropic. Un mensaje de usuario simple.

```json
[
  {
    "role": "user",
    "content": [{ "type": "text", "text": "Lista mis proyectos y tablas de Supabase" }]
  }
]
```

---

### 1.4 `streamText` → Anthropic API

Anthropic recibe el mensaje y responde con **dos `tool_use` simultáneos** (la IA decide usar ambas herramientas a la vez).

**Respuesta de Anthropic:**
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "Voy a listar tus proyectos y tablas de Supabase."
    },
    {
      "type": "tool_use",
      "id": "toolu_017smziC3kjugPbhH6EUzuvE",
      "name": "supabase_list_projects",
      "input": {}
    },
    {
      "type": "tool_use",
      "id": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
      "name": "supabase_list_tables",
      "input": { "project_id": "abc123" }
    }
  ]
}
```

---

### 1.5 AI SDK intercepta — `needsApproval: true`

El AI SDK detecta que ambas tools tienen `needsApproval: true`. **No las ejecuta.** En su lugar emite dos eventos `tool-approval-request`.

`streamChat` convierte cada evento en un chunk `toolApproval` y lo envía al renderer via IPC.

---

### 1.6 Renderer — UIMessage resultante

El AI SDK del renderer procesa los chunks de approval y crea el assistant message con los parts en estado `approval-requested`:

```json
{
  "id": "OtWLDv2rVQhVW2k1",
  "role": "assistant",
  "parts": [
    {
      "type": "text",
      "text": "Voy a listar tus proyectos y tablas de Supabase."
    },
    {
      "type": "tool-supabase_list_projects",
      "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
      "toolName": "supabase_list_projects",
      "state": "approval-requested",
      "input": {},
      "approval": { "id": "aitxt-aaa111" }
    },
    {
      "type": "tool-supabase_list_tables",
      "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
      "toolName": "supabase_list_tables",
      "state": "approval-requested",
      "input": { "project_id": "abc123" },
      "approval": { "id": "aitxt-k5jJjkeQx41Rh89qwXeHLClS" }
    }
  ]
}
```

La UI muestra dos popups de aprobación. El Stream 1 termina aquí.

---

### 1.7 Usuario aprueba ambas tools

```
addToolApprovalResponse({ id: "aitxt-aaa111",               approved: true })
addToolApprovalResponse({ id: "aitxt-k5jJjkeQx41Rh89qwXeHLClS", approved: true })
```

Los parts pasan a `approval-responded`:

```json
{
  "type": "tool-supabase_list_projects",
  "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
  "state": "approval-responded",
  "approval": { "id": "aitxt-aaa111", "approved": true }
},
{
  "type": "tool-supabase_list_tables",
  "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
  "state": "approval-responded",
  "approval": { "id": "aitxt-k5jJjkeQx41Rh89qwXeHLClS", "approved": true }
}
```

`sendAutomaticallyWhen` evalúa: todos los parts `approval-responded` tienen `approved: true` → devuelve `true` → **el AI SDK dispara automáticamente el Stream 2.**

---

## Stream 2 — Segunda llamada al modelo (donde ocurre el error)

### 2.1 `ElectronChatTransport.sendMessages`

El AI SDK llama automáticamente al transport con el estado actual de los mensajes. Llegan al main process los UIMessages incluyendo el assistant message con los parts en `approval-responded`.

> **Nota**: En los logs, `supabase_list_projects` ya aparece como `output-available` en este punto, lo que indica que esa tool fue ejecutada en un stream intermedio. Lo relevante para el error es `supabase_list_tables`, que sigue en `approval-responded`.

```json
[
  {
    "id": "usr-001",
    "role": "user",
    "parts": [{ "type": "text", "text": "Lista mis proyectos y tablas de Supabase" }]
  },
  {
    "id": "OtWLDv2rVQhVW2k1",
    "role": "assistant",
    "parts": [
      {
        "type": "text",
        "text": "Voy a listar tus proyectos y tablas de Supabase."
      },
      {
        "type": "tool-supabase_list_projects",
        "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
        "state": "output-available",
        "input": {},
        "output": "[{ \"id\": \"abc123\", \"name\": \"mi-proyecto\" }]",
        "approval": { "id": "aitxt-aaa111", "approved": true }
      },
      {
        "type": "tool-supabase_list_tables",
        "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
        "state": "approval-responded",
        "input": { "project_id": "abc123" },
        "approval": { "id": "aitxt-k5jJjkeQx41Rh89qwXeHLClS", "approved": true }
      }
    ]
  }
]
```

---

### 2.2 `sanitizeMessagesForModel` — **aquí está el bug**

La función itera los parts del assistant message. Encuentra el part de `supabase_list_tables` en `approval-responded`.

**Lo que ocurre (real, confirmado por logs):**

```
part.state === 'approval-responded'  → entra en el bloque ✓
wasDenied = (true === false)         → false
if (wasDenied) { ... }               → NO se ejecuta ✗

→ El part sale de sanitize SIN CAMBIOS, todavía en 'approval-responded'
```

**Log que confirma esto:**
```
[APPROVAL-DEBUG] Found approval-responded part in sanitize
  approvalApproved: true
  wasDenied: false
  → WARNING: approval-responded part is APPROVED but NOT converted
```

**Salida de `sanitizeMessagesForModel` (igual a la entrada — sin cambios en el part problemático):**

```json
[
  { "id": "usr-001", "role": "user", "parts": [{ "type": "text", "text": "Lista..." }] },
  {
    "id": "OtWLDv2rVQhVW2k1",
    "role": "assistant",
    "parts": [
      { "type": "text", "text": "Voy a listar..." },
      {
        "type": "tool-supabase_list_projects",
        "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
        "state": "output-available",
        "output": "[{ \"id\": \"abc123\" }]"
      },
      {
        "type": "tool-supabase_list_tables",
        "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
        "state": "approval-responded",
        "approval": { "approved": true }
      }
    ]
  }
]
```

---

### 2.3 `convertToModelMessages` — genera el payload inválido

La función recibe los UIMessages sanitizados y los convierte al formato Anthropic.

**Para el assistant message, genera dos `tool-call` blocks** (uno por cada tool part, independientemente del estado).

**Para los tool_results, solo genera resultado para el part con `state: output-available`**. El part con `state: approval-responded` no tiene `output`, así que no genera `tool_result` para él.

**Resultado real (payload inválido que se envía a Anthropic):**

```json
[
  {
    "role": "user",
    "content": [{ "type": "text", "text": "Lista mis proyectos y tablas de Supabase" }]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Voy a listar tus proyectos y tablas de Supabase." },
      {
        "type": "tool-call",
        "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
        "toolName": "supabase_list_projects",
        "input": {}
      },
      {
        "type": "tool-call",
        "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
        "toolName": "supabase_list_tables",
        "input": { "project_id": "abc123" }
      }
    ]
  },
  {
    "role": "tool",
    "content": [
      {
        "type": "tool-result",
        "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
        "toolName": "supabase_list_projects",
        "output": { "type": "text", "value": "[{ \"id\": \"abc123\" }]" }
      }
      ← FALTA tool_result para toolu_01KwTzpfgjRj5wMSsvnMR5x1
    ]
  }
]
```

---

### 2.4 `streamText` → Anthropic API — **ERROR**

Anthropic valida el payload y detecta que hay dos `tool-call` en el assistant message pero solo un `tool_result` en el siguiente mensaje.

```
Error: messages.1: `tool_use` ids were found without `tool_result` blocks immediately after:
  toolu_017smziC3kjugPbhH6EUzuvE, toolu_01KwTzpfgjRj5wMSsvnMR5x1.
Each `tool_use` block must have a corresponding `tool_result` block in the next message.
```

---

## ¿Cuál sería el payload correcto?

Para que Anthropic acepte el payload del Stream 2, `convertToModelMessages` debería recibir **ambos tools en `output-available`** y generar:

```json
[
  {
    "role": "user",
    "content": [{ "type": "text", "text": "Lista mis proyectos y tablas de Supabase" }]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Voy a listar tus proyectos y tablas de Supabase." },
      {
        "type": "tool-call",
        "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
        "toolName": "supabase_list_projects",
        "input": {}
      },
      {
        "type": "tool-call",
        "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
        "toolName": "supabase_list_tables",
        "input": { "project_id": "abc123" }
      }
    ]
  },
  {
    "role": "tool",
    "content": [
      {
        "type": "tool-result",
        "toolCallId": "toolu_017smziC3kjugPbhH6EUzuvE",
        "toolName": "supabase_list_projects",
        "output": { "type": "text", "value": "[{ \"id\": \"abc123\" }]" }
      },
      {
        "type": "tool-result",
        "toolCallId": "toolu_01KwTzpfgjRj5wMSsvnMR5x1",
        "toolName": "supabase_list_tables",
        "output": { "type": "text", "value": "..." }
      }
    ]
  }
]
```

Para llegar a ese estado, `sanitizeMessagesForModel` necesita convertir el part de `supabase_list_tables` de `approval-responded` a `output-available` — pero para eso necesita el **resultado real de ejecutar la tool**, no un placeholder.

---

## Resumen del bug

```
Stream 2 — sanitizeMessagesForModel:

  tool-supabase_list_projects → state: output-available  → tool_result ✅ generado
  tool-supabase_list_tables   → state: approval-responded → tool_result ❌ no generado
                                         ↑
                                   wasDenied = false
                                   → sin conversión
                                   → el part llega a convertToModelMessages
                                     sin output
                                   → Anthropic: ERROR
```

*Generado: 2026-02-24*
