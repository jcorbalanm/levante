# Guía Completa: Flujo de Tool Approval en Levante

## Índice
1. [Introducción](#introducción)
2. [Arquitectura General](#arquitectura-general)
3. [El Flujo Paso a Paso](#el-flujo-paso-a-paso)
4. [El Problema Actual](#el-problema-actual)
5. [Análisis de los Logs](#análisis-de-los-logs)
6. [Glosario de Términos](#glosario-de-términos)

---

## Introducción

### ¿Qué es Tool Approval?

Cuando una IA usa herramientas (tools) para hacer cosas como ejecutar comandos, modificar archivos, o acceder a APIs externas, a veces queremos **pedir permiso al usuario antes de ejecutar** esas herramientas.

Por ejemplo:
- El usuario dice: "Lista mis proyectos de Supabase"
- La IA quiere usar la herramienta `supabase_list_projects`
- En lugar de ejecutarla automáticamente, mostramos un botón "Aprobar" al usuario
- Solo después de que el usuario apruebe, la herramienta se ejecuta

### ¿Por qué es necesario?

Algunas herramientas son "peligrosas":
- Ejecutar comandos en terminal
- Modificar bases de datos
- Enviar emails
- Hacer pagos

Queremos que el usuario tenga control sobre estas acciones.

---

## Arquitectura General

Levante tiene 3 capas principales que participan en este flujo:

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React)                          │
│   ChatMessageItem.tsx - Muestra la UI de aprobación              │
│   ChatPage.tsx - Maneja el estado del chat                       │
│   ElectronChatTransport.ts - Convierte chunks para el AI SDK     │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ IPC (Inter-Process Communication)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        BACKEND (Node.js)                         │
│   aiService.ts - Procesa el stream del AI SDK                    │
│   mcpToolsAdapter.ts - Conecta herramientas MCP con AI SDK       │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP/HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AI SDK + Proveedor de IA                     │
│   Vercel AI SDK - Librería que maneja la comunicación            │
│   OpenRouter/Anthropic - El servicio de IA real                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## El Flujo Paso a Paso

### Paso 1: El Usuario Envía un Mensaje

```
Usuario: "Lista mis proyectos de Supabase"
```

Este mensaje viaja:
1. ChatPage.tsx → ElectronChatTransport.ts → IPC → aiService.ts

### Paso 2: aiService.ts Prepara las Herramientas

En `aiService.ts`, configuramos las herramientas MCP con `needsApproval: true`:

```typescript
// Archivo: src/main/services/ai/mcpToolsAdapter.ts
const tool = {
  description: "Lista todos los proyectos de Supabase",
  parameters: z.object({}),
  needsApproval: true,  // ← ESTO ES CLAVE
  execute: async (args) => {
    // Código que ejecuta la herramienta
  }
};
```

### Paso 3: El AI SDK Genera Chunks

Cuando el modelo decide usar una herramienta con `needsApproval: true`, el AI SDK genera estos chunks en secuencia:

```
Chunk 1: { type: "tool-call", toolCallId: "abc123", toolName: "supabase_list_projects", input: {} }
Chunk 2: { type: "tool-approval-request", approvalId: "xyz789", toolCall: { toolCallId: "abc123", ... } }
```

**¿Qué significa cada chunk?**

- `tool-call`: "El modelo quiere usar esta herramienta con estos argumentos"
- `tool-approval-request`: "Esta herramienta necesita aprobación antes de ejecutarse"

### Paso 4: aiService.ts Procesa los Chunks

```typescript
// Archivo: src/main/services/aiService.ts

case "tool-call":
  // Log [FLOW-1]: Recibimos el chunk del AI SDK
  // Extraemos los argumentos (input)
  const toolCallArguments = chunk.input || chunk.arguments || {};

  // Log [FLOW-2]: Enviamos al frontend
  yield {
    toolCall: {
      id: chunk.toolCallId,
      name: chunk.toolName,
      arguments: toolCallArguments,
    }
  };
  break;

case "tool-approval-request":
  // Log [FLOW-3]: Recibimos el chunk de aprobación
  const toolInput = chunk.toolCall?.input ?? {};

  // Log [FLOW-4]: Enviamos al frontend
  yield {
    toolApproval: {
      approvalId: chunk.approvalId,
      toolCallId: chunk.toolCall?.toolCallId,
      toolName: chunk.toolCall?.toolName,
      input: toolInput,
    }
  };
  break;
```

### Paso 5: ElectronChatTransport.ts Convierte para el AI SDK React

El frontend usa el hook `useChat` del AI SDK, que espera un formato específico de chunks llamados `UIMessageChunk`.

```typescript
// Archivo: src/renderer/transports/ElectronChatTransport.ts

// Cuando recibimos toolApproval del backend:
if (chunk.toolApproval) {
  // Log [FLOW-7]: Chunk recibido del backend

  // Emitimos tool-input-start para "iniciar" el part de la herramienta
  yield {
    type: "tool-input-start",
    toolCallId: chunk.toolApproval.toolCallId,
    toolName: chunk.toolApproval.toolName,
  };

  // Log [FLOW-8]: Emitimos tool-approval-request
  yield {
    type: "tool-approval-request",
    toolCallId: chunk.toolApproval.toolCallId,
    toolName: chunk.toolApproval.toolName,
    input: chunk.toolApproval.input,  // ← Enviamos el input aquí
    approvalId: chunk.toolApproval.approvalId,
  };
}
```

### Paso 6: useChat Actualiza el Estado

El hook `useChat` del AI SDK procesa los chunks y actualiza el estado del mensaje:

```typescript
// Internamente en el AI SDK (simplificado):
message.parts = [
  { type: "text", text: "Voy a listar tus proyectos..." },
  {
    type: "tool-supabase_list_projects",  // El tipo incluye el nombre
    toolCallId: "abc123",
    state: "approval-requested",          // ← Estado especial
    input: ???,                            // ← AQUÍ ESTÁ EL PROBLEMA
    approval: { id: "xyz789" }
  }
];
```

### Paso 7: ChatMessageItem.tsx Renderiza la UI

```typescript
// Archivo: src/renderer/components/chat/ChatMessageItem.tsx

// Iteramos sobre las partes del mensaje
for (const part of message.parts) {
  // Si es una herramienta esperando aprobación...
  if (part.state === 'approval-requested') {
    // Log [FLOW-13]: Mostramos UI de aprobación
    return (
      <ToolApprovalInline
        toolName={part.toolName}
        input={part.input}        // ← Usamos part.input
        approvalId={part.approval?.id}
        onApprove={() => ...}
        onDeny={() => ...}
      />
    );
  }
}
```

---

## El Problema Actual

### ¿Qué está pasando?

Los logs muestran:

```
[FLOW-8] Transport: Yielding tool-approval-request
  input: {}                    ← Enviamos input correctamente
  inputKeys: Array(0)          ← Está vacío pero es un objeto válido

[FLOW-13] ChatMessageItem: Showing approval UI
  partInput: undefined         ← ¡El input se perdió!
  partInputType: 'undefined'   ← No llegó al componente
```

### ¿Dónde se pierde el input?

El flujo de datos es:
```
Backend (input: {}) → Transport (input: {}) → AI SDK useChat → part.input = undefined
```

El problema está entre el Transport y el hook `useChat`. El AI SDK no está mapeando el campo `input` del chunk `tool-approval-request` al `part.input`.

### Transiciones de Estado

Los logs también muestran las transiciones de estado del part:

```
partState: "input-streaming"      ← Empezó a recibir input
partState: "input-available"      ← Input disponible ✓
partState: "input-streaming"      ← ¡Se resetea!
partState: "approval-requested"   ← Estado final
```

El estado pasa de `input-available` (donde el input está disponible) a `input-streaming` otra vez, lo que podría estar reseteando el input.

### ¿Por qué pasa esto?

Hay **dos chunks separados** llegando del backend:

1. `chunk.toolCall` → Emite `tool-input-start` + `tool-input-available`
2. `chunk.toolApproval` → Emite `tool-input-start` + `tool-approval-request`

El segundo `tool-input-start` podría estar "reiniciando" el part y perdiendo el input que ya se había establecido.

---

## Análisis de los Logs

### Diagrama del Flujo con Logs

```
┌─────────────────────────────────────────────────────────────────────────┐
│ AI SDK (Vercel)                                                         │
│                                                                         │
│ Genera chunk: tool-call { input: {} }                                   │
│ Genera chunk: tool-approval-request { toolCall: { input: {} } }         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ aiService.ts (Backend)                                                  │
│                                                                         │
│ [FLOW-1] tool-call chunk received                                       │
│   hasInput: true, inputValue: {}    ← ✓ Input existe                    │
│                                                                         │
│ [FLOW-2] Yielding toolCall to frontend                                  │
│   arguments: {}, sourceUsed: "input"  ← ✓ Usamos input                  │
│                                                                         │
│ [FLOW-3] RAW tool-approval-request chunk                                │
│   toolCall.input: {}                  ← ✓ Input en el chunk             │
│                                                                         │
│ [FLOW-4] Yielding toolApproval to frontend                              │
│   input: {}                           ← ✓ Enviamos input                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ElectronChatTransport.ts (Frontend)                                     │
│                                                                         │
│ [FLOW-5] toolCall chunk received                                        │
│   arguments: {}                       ← ✓ Recibimos                     │
│                                                                         │
│ [FLOW-6] Yielding tool-input-available                                  │
│   input: {}                           ← ✓ Enviamos al AI SDK            │
│                                                                         │
│ [FLOW-7] toolApproval chunk received                                    │
│   inputValue: {}                      ← ✓ Recibimos                     │
│                                                                         │
│ [FLOW-8] Yielding tool-approval-request                                 │
│   input: {}                           ← ✓ Enviamos al AI SDK            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ useChat Hook (AI SDK React)                                             │
│                                                                         │
│ Procesa: tool-input-start     → part.state = "input-streaming"          │
│ Procesa: tool-input-available → part.state = "input-available"          │
│                                  part.input = {}  ← ✓ Input establecido │
│                                                                         │
│ Procesa: tool-input-start     → part.state = "input-streaming"          │
│                                  part.input = ??? ← ¿Se resetea?        │
│                                                                         │
│ Procesa: tool-approval-request → part.state = "approval-requested"      │
│                                  part.approval = { id: "..." }          │
│                                  part.input = ??? ← ¿No se mapea?       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ChatMessageItem.tsx (React Component)                                   │
│                                                                         │
│ [FLOW-13] Showing approval UI                                           │
│   partInput: undefined                ← ✗ ¡EL INPUT SE PERDIÓ!          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Glosario de Términos

### Chunk
Un "pedazo" de datos que se envía durante el streaming. En lugar de esperar a que toda la respuesta esté lista, el AI SDK envía pequeños chunks conforme se van generando.

### Part
Una "parte" de un mensaje. Un mensaje de IA puede tener múltiples parts:
- Texto
- Herramientas (tool calls)
- Razonamiento
- etc.

### Tool Call
Cuando el modelo de IA decide usar una herramienta. Incluye:
- `toolCallId`: ID único de esta llamada
- `toolName`: Nombre de la herramienta
- `input`: Los argumentos/parámetros para la herramienta

### Tool Approval Request
Un chunk especial que indica que una herramienta necesita aprobación antes de ejecutarse.

### State (de un tool part)
El estado actual de una herramienta:
- `input-streaming`: Recibiendo argumentos
- `input-available`: Argumentos listos
- `approval-requested`: Esperando aprobación del usuario
- `running`: Ejecutándose
- `complete`: Terminada

### UIMessageChunk
El formato de chunk que el hook `useChat` del AI SDK espera recibir. El Transport convierte los chunks de nuestro backend a este formato.

### Transport
Una clase que "transporta" los mensajes entre nuestro backend y el AI SDK. Actúa como un adaptador/traductor.

---

## SOLUCIÓN ENCONTRADA ✅

### El Bug

El problema era el **formato incorrecto** del chunk `tool-approval-request`.

**Formato incorrecto (lo que teníamos):**
```typescript
yield {
  type: "tool-approval-request",
  toolCallId: "...",      // ← En el nivel superior
  toolName: "...",        // ← En el nivel superior
  input: {},              // ← En el nivel superior
  approvalId: "..."
};
```

**Formato correcto (según el AI SDK Stream Protocol):**
```typescript
yield {
  type: "tool-approval-request",
  approvalId: "...",
  toolCall: {
    toolCallId: "...",
    toolName: "...",
    input: {}             // ← DENTRO de toolCall
  }
};
```

### Por qué fallaba

El AI SDK busca el input en `chunk.toolCall.input`, no en `chunk.input`. Como poníamos el input en el nivel superior, el AI SDK no lo encontraba y `part.input` quedaba como `undefined`.

### El Fix

En `ElectronChatTransport.ts`, cambiamos:

```typescript
// ANTES (incorrecto):
yield {
  type: "tool-approval-request",
  toolCallId: chunk.toolApproval.toolCallId,
  toolName: chunk.toolApproval.toolName,
  input: safeInput,
  approvalId: chunk.toolApproval.approvalId,
} as any;

// DESPUÉS (correcto):
yield {
  type: "tool-approval-request",
  approvalId: chunk.toolApproval.approvalId,
  toolCall: {
    toolCallId: chunk.toolApproval.toolCallId,
    toolName: chunk.toolApproval.toolName,
    input: safeInput,
  },
} as any;
```

### Verificación

Después del fix, los logs deberían mostrar:
- `[FLOW-8]`: `toolCall: { toolCallId: "...", toolName: "...", input: {} }`
- `[FLOW-13]`: `partInput: {}` (ya no `undefined`)

---

## SEGUNDO BUG ENCONTRADO ✅

### El Problema

El primer fix corrigió el formato, pero el part nunca llegaba a `approval-requested` porque:

1. `chunk.toolCall` → emit `tool-input-start` + `tool-input-available` → state = `input-available` ✅
2. `chunk.toolApproval` → emit `tool-input-start` + `tool-approval-request` → **state se RESETEA a `input-streaming`** ❌

El segundo `tool-input-start` reseteaba el part.

### El Fix

Eliminar el `tool-input-start` para `toolApproval` ya que el part ya existe:

```typescript
// ANTES:
if (chunk.toolApproval) {
  yield { type: "tool-input-start", ... };  // ← CAUSABA EL RESET
  yield { type: "tool-approval-request", ... };
}

// DESPUÉS:
if (chunk.toolApproval) {
  // NO emitir tool-input-start - el part ya existe
  yield { type: "tool-approval-request", ... };
}
```

---

## TERCER BUG: `tool_use` sin `tool_result` (EN INVESTIGACIÓN)

### Síntoma

Después de aprobar una herramienta y continuar la conversación, Anthropic devuelve:
```
Error: messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01Qv8wVRHNfES3GEMsuU2iUZ
```

### Contexto

El flujo de tool approval funciona:
1. ✅ Usuario envía mensaje
2. ✅ Modelo genera tool call
3. ✅ UI muestra botones de aprobar/denegar (con inputs visibles)
4. ✅ Usuario aprueba → herramienta se ejecuta → resultado mostrado

Pero cuando el usuario continúa la conversación DESPUÉS de que la herramienta se ejecutó:
- ❌ Anthropic rechaza los mensajes
- ❌ Error indica que hay `tool_use` sin su `tool_result` correspondiente

### Estructura de Mensajes Esperada por Anthropic

Anthropic requiere esta estructura estricta:

```
Mensaje 1 (user):
  - content: "Lista mis proyectos"

Mensaje 2 (assistant):
  - content: [
      { type: "tool_use", id: "toolu_ABC", name: "list_projects", input: {} }
    ]

Mensaje 3 (user):  ← CRÍTICO: El tool_result debe estar aquí
  - content: [
      { type: "tool_result", tool_use_id: "toolu_ABC", content: "[...resultado...]" }
    ]

Mensaje 4 (assistant):
  - content: "Aquí están tus proyectos..."
```

**Regla de Anthropic**: Cada `tool_use` en un mensaje del asistente DEBE tener un `tool_result` correspondiente en el siguiente mensaje del usuario, con el mismo `tool_use_id`.

### Logs Diagnósticos Añadidos

Se añadieron logs en `aiService.ts` para investigar:

```
[FLOW-10] Messages BEFORE convertToModelMessages:
  - Muestra estructura completa de UIMessages con partes y estados

[FLOW-10b] Messages AFTER convertToModelMessages:
  - Muestra cómo el AI SDK convierte los mensajes para el modelo
```

### Posibles Causas

1. **Desalineación de IDs**: El `toolCallId` en el UIMessage podría no coincidir con el `tool_use_id` que Anthropic espera

2. **Orden incorrecto**: Los mensajes podrían no tener el `tool_result` inmediatamente después del `tool_use`

3. **Conversión incompleta**: `convertToModelMessages` podría no estar incluyendo todos los `tool_result` necesarios

4. **Estado incorrecto**: Las partes de herramientas podrían tener un estado que no se traduce correctamente a `tool_result`

### Próximos Pasos

1. Ejecutar la app con los logs diagnósticos
2. Aprobar una herramienta y continuar la conversación
3. Revisar los logs [FLOW-10] y [FLOW-10b] para ver:
   - ¿Qué estados tienen las tool parts?
   - ¿Los toolCallIds coinciden?
   - ¿La conversión produce la estructura correcta?
