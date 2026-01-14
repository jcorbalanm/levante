# Flujo de Aprobacion y Ejecucion de Herramientas - Guia Completa

Esta guia explica paso a paso como funciona el sistema de aprobacion y ejecucion de herramientas (tools) en Levante, desde que el AI decide usar una herramienta hasta que se ejecuta y se muestra el resultado.

---

## Indice

1. [Vision General del Flujo](#1-vision-general-del-flujo)
2. [Archivos Involucrados](#2-archivos-involucrados)
3. [Fase 1: Configuracion de needsApproval](#3-fase-1-configuracion-de-needsapproval)
4. [Fase 2: Peticion de Chat desde el Frontend](#4-fase-2-peticion-de-chat-desde-el-frontend)
5. [Fase 3: Procesamiento en el Backend](#5-fase-3-procesamiento-en-el-backend)
6. [Fase 4: El AI SDK y la Solicitud de Aprobacion](#6-fase-4-el-ai-sdk-y-la-solicitud-de-aprobacion)
7. [Fase 5: Envio de Chunks al Frontend](#7-fase-5-envio-de-chunks-al-frontend)
8. [Fase 6: Conversion en el Transport](#8-fase-6-conversion-en-el-transport)
9. [Fase 7: Renderizado de la UI de Aprobacion](#9-fase-7-renderizado-de-la-ui-de-aprobacion)
10. [Fase 8: Usuario Aprueba o Deniega](#10-fase-8-usuario-aprueba-o-deniega)
11. [Fase 9: Ejecucion de la Herramienta](#11-fase-9-ejecucion-de-la-herramienta)
12. [Tipos de Datos Importantes](#12-tipos-de-datos-importantes)
13. [Diagrama de Flujo Completo](#13-diagrama-de-flujo-completo)

---

## 1. Vision General del Flujo

El flujo de aprobacion de herramientas funciona asi (version simplificada):

```
Usuario envia mensaje
       |
       v
AI procesa y decide usar una herramienta
       |
       v
Se detecta que la herramienta necesita aprobacion (needsApproval: true)
       |
       v
Se muestra UI al usuario: "Quieres aprobar esta herramienta?"
       |
       v
Usuario hace click en "Approve" o "Deny"
       |
       v
Si aprobo: Se ejecuta la herramienta y se muestra el resultado
Si denego: Se cancela la operacion
```

---

## 2. Archivos Involucrados

### Main Process (Backend - Node.js)

| Archivo | Descripcion |
|---------|-------------|
| `src/main/services/ai/mcpToolsAdapter.ts` | **CLAVE** - Convierte herramientas MCP a formato AI SDK. Aqui se configura `needsApproval: true` |
| `src/main/services/aiService.ts` | **CLAVE** - Servicio principal que orquesta todo el streaming de chat |
| `src/main/ipc/chatHandlers.ts` | Maneja la comunicacion IPC para el chat |
| `src/main/services/mcp/mcpUseService.ts` | Ejecuta las herramientas MCP reales |

### Preload (Puente entre Main y Renderer)

| Archivo | Descripcion |
|---------|-------------|
| `src/preload/types/index.ts` | Define el tipo `ChatStreamChunk` que incluye `toolApproval` |

### Renderer Process (Frontend - React)

| Archivo | Descripcion |
|---------|-------------|
| `src/renderer/pages/ChatPage.tsx` | **CLAVE** - Configura `useChat` con `sendAutomaticallyWhen` y extrae `addToolApprovalResponse` |
| `src/renderer/transports/ElectronChatTransport.ts` | **CLAVE** - Convierte chunks de Electron a formato AI SDK |
| `src/renderer/components/chat/ChatMessageItem.tsx` | **CLAVE** - Detecta `state === 'approval-requested'` y renderiza la UI |
| `src/renderer/components/ai-elements/tool-approval.tsx` | **CLAVE** - Componente visual de aprobacion |

---

## 3. Fase 1: Configuracion de needsApproval

Todo empieza en `mcpToolsAdapter.ts`. Cuando se cargan las herramientas MCP, cada una se convierte al formato del AI SDK con la propiedad `needsApproval: true`:

```typescript
// src/main/services/ai/mcpToolsAdapter.ts (linea 226-233)

const aiTool = tool({
  description: mcpTool.description || `Tool from MCP server ${serverId}`,
  inputSchema: inputSchema,

  // ======================================================
  // Todas las herramientas MCP requieren aprobacion del usuario
  // ======================================================
  needsApproval: true,

  execute: async (args: any) => {
    // ... codigo de ejecucion
  },
});
```

**Que significa esto?**
- `needsApproval: true` le dice al AI SDK que ANTES de ejecutar esta herramienta, debe pedir permiso al usuario
- Sin esta propiedad, las herramientas se ejecutarian automaticamente

---

## 4. Fase 2: Peticion de Chat desde el Frontend

Cuando el usuario envia un mensaje, el `ChatPage.tsx` usa el hook `useChat` del AI SDK:

```typescript
// src/renderer/pages/ChatPage.tsx (lineas 196-213)

const {
  messages,
  setMessages,
  sendMessage: sendMessageAI,
  status,
  stop,
  error: chatError,
  addToolApprovalResponse, // <-- Funcion para responder a aprobaciones
} = useChat({
  id: currentSession?.id || 'new-chat',
  transport,

  // =======================================================
  // CRITICO: Sin esto, la aprobacion no se envia al servidor
  // =======================================================
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,

  // ... resto de configuracion
});
```

**Puntos clave:**
1. `addToolApprovalResponse` - Esta funcion se usa para decirle al AI SDK si aprobamos o denegamos una herramienta
2. `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses` - Esto hace que cuando el usuario apruebe una herramienta, el mensaje se envie automaticamente al servidor para continuar

---

## 5. Fase 3: Procesamiento en el Backend

El mensaje llega al `aiService.ts` a traves de IPC. Aqui se:
1. Obtienen las herramientas MCP
2. Se llama al AI SDK con `streamText()`

```typescript
// src/main/services/aiService.ts (lineas 1033-1095)

const result = streamText({
  model: modelProvider,
  messages: await convertToModelMessages(sanitizeMessagesForModel(messagesWithFileParts)),
  tools, // <-- Incluye herramientas con needsApproval: true
  system: await buildSystemPrompt(...),
  stopWhen: stepCountIs(await calculateMaxSteps(Object.keys(tools).length)),
  // ... mas opciones
});
```

---

## 6. Fase 4: El AI SDK y la Solicitud de Aprobacion

Cuando el modelo decide usar una herramienta con `needsApproval: true`, el AI SDK emite un chunk especial de tipo `tool-approval-request`:

```typescript
// src/main/services/aiService.ts (lineas 1188-1205)

case "tool-approval-request":
  // Herramienta con needsApproval: true requiere aprobacion del usuario
  this.logger.aiSdk.info("Tool approval request received", {
    approvalId: (chunk as any).approvalId,
    toolCallId: (chunk as any).toolCall?.toolCallId,
    toolName: (chunk as any).toolCall?.toolName,
    input: (chunk as any).toolCall?.input,
  });

  yield {
    toolApproval: {
      approvalId: (chunk as any).approvalId,
      toolCallId: (chunk as any).toolCall?.toolCallId,
      toolName: (chunk as any).toolCall?.toolName,
      input: (chunk as any).toolCall?.input || {},
    },
  };
  break;
```

**Que esta pasando aqui?**
1. El AI SDK detecta que la herramienta necesita aprobacion
2. En lugar de ejecutarla, emite un chunk `tool-approval-request`
3. El backend convierte esto a nuestro formato `toolApproval` y lo envia al frontend

---

## 7. Fase 5: Envio de Chunks al Frontend

Los chunks se envian al frontend a traves de IPC:

```typescript
// El chunk que se envia tiene esta estructura:
{
  toolApproval: {
    approvalId: "aitxt-xxxx",     // ID unico de la aprobacion
    toolCallId: "call-xxxx",      // ID de la llamada a la herramienta
    toolName: "serverId_toolName", // Nombre de la herramienta
    input: { /* argumentos */ }    // Argumentos que se pasaran
  }
}
```

---

## 8. Fase 6: Conversion en el Transport

El `ElectronChatTransport.ts` recibe los chunks y los convierte al formato que el AI SDK espera:

```typescript
// src/renderer/transports/ElectronChatTransport.ts (lineas 297-320)

// Handle tool approval requests (for needsApproval: true tools)
if (chunk.toolApproval) {
  console.log('Transport: Tool approval request', {
    approvalId: chunk.toolApproval.approvalId,
    toolCallId: chunk.toolApproval.toolCallId,
    toolName: chunk.toolApproval.toolName,
  });

  // Start the tool part
  yield {
    type: "tool-input-start",
    toolCallId: chunk.toolApproval.toolCallId,
    toolName: chunk.toolApproval.toolName,
  };

  // Emit tool-approval-request chunk for AI SDK
  yield {
    type: "tool-approval-request",
    toolCallId: chunk.toolApproval.toolCallId,
    toolName: chunk.toolApproval.toolName,
    input: chunk.toolApproval.input,
    approvalId: chunk.toolApproval.approvalId,
  } as any;
}
```

**Que hace esto?**
1. Primero emite `tool-input-start` para indicar que empieza una herramienta
2. Luego emite `tool-approval-request` que el AI SDK usa para cambiar el estado del part a `approval-requested`

---

## 9. Fase 7: Renderizado de la UI de Aprobacion

El `ChatMessageItem.tsx` detecta cuando un part tiene estado `approval-requested` y renderiza el componente de aprobacion:

```typescript
// src/renderer/components/chat/ChatMessageItem.tsx (lineas 296-314)

// Si esta esperando aprobacion, mostrar UI de aprobacion
if (part.state === 'approval-requested' && addToolApprovalResponse) {
  const toolName = part.toolName || part.type.replace(/^tool-/, '');
  return (
    <ToolApprovalInline
      key={`${message.id}-${i}`}
      toolName={toolName}
      input={part.input || {}}
      approvalId={part.approval?.id || part.toolCallId}
      onApprove={() => addToolApprovalResponse({
        id: part.approval?.id || part.toolCallId,
        approved: true,
      })}
      onDeny={() => addToolApprovalResponse({
        id: part.approval?.id || part.toolCallId,
        approved: false,
      })}
    />
  );
}
```

**El componente `ToolApprovalInline` se ve asi:**

```typescript
// src/renderer/components/ai-elements/tool-approval.tsx

export function ToolApprovalInline({
  toolName,
  input,
  approvalId,
  onApprove,
  onDeny,
  className,
}: ToolApprovalInlineProps) {
  const [showDetails, setShowDetails] = useState(false);

  // Extraer nombre de herramienta sin prefijo del servidor
  const displayToolName = toolName.includes('_')
    ? toolName.split('_').slice(1).join('_')
    : toolName;

  const serverId = toolName.includes('_')
    ? toolName.split('_')[0]
    : 'unknown';

  return (
    <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-yellow-500" />
        <span className="font-medium">Tool Approval Required</span>
      </div>

      {/* Tool Info */}
      <div className="flex items-center gap-2 text-sm">
        <Wrench className="w-4 h-4 text-muted-foreground" />
        <span className="font-mono font-medium">{displayToolName}</span>
        <Badge variant="outline">{serverId}</Badge>
      </div>

      {/* Toggle para mostrar parametros */}
      <button onClick={() => setShowDetails(!showDetails)}>
        {showDetails ? 'Hide parameters' : 'Show parameters'}
      </button>

      {/* Parametros en JSON */}
      {showDetails && (
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      )}

      {/* Botones de accion */}
      <div className="flex gap-2 pt-2">
        <Button variant="outline" size="sm" onClick={onDeny}>
          <X className="w-3 h-3" /> Deny
        </Button>
        <Button size="sm" onClick={onApprove}>
          <Check className="w-3 h-3" /> Approve
        </Button>
      </div>
    </div>
  );
}
```

**El resultado visual es algo asi:**

```
+------------------------------------------+
|  Tool Approval Required                   |
|  read_file    [filesystem]               |
|  > Show parameters                        |
|  [Deny]  [Approve]                        |
+------------------------------------------+
```

---

## 10. Fase 8: Usuario Aprueba o Deniega

Cuando el usuario hace click en "Approve":

```typescript
onApprove={() => addToolApprovalResponse({
  id: part.approval?.id || part.toolCallId,
  approved: true,
})}
```

**Que pasa despues?**
1. `addToolApprovalResponse` agrega la respuesta a los mensajes internos
2. `sendAutomaticallyWhen` detecta que hay approval responses pendientes
3. El hook `useChat` automaticamente envia el mensaje al servidor
4. El servidor recibe la aprobacion y continua con la ejecucion

---

## 11. Fase 9: Ejecucion de la Herramienta

Una vez aprobada, el AI SDK ejecuta la funcion `execute` de la herramienta:

```typescript
// src/main/services/ai/mcpToolsAdapter.ts (lineas 235-246)

execute: async (args: any) => {
  try {
    logger.aiSdk.debug("Executing MCP tool", {
      serverId,
      toolName: mcpTool.name,
      args,
    });

    // Llamar al servidor MCP real
    const result = await mcpService.callTool(serverId, {
      name: mcpTool.name,
      arguments: args,
    });

    // ... procesamiento del resultado
    return result;
  } catch (error) {
    // ... manejo de errores
  }
},
```

El resultado vuelve al frontend como un chunk `tool-result` y se muestra en la UI.

---

## 12. Tipos de Datos Importantes

### ChatStreamChunk (lo que envia el backend)

```typescript
interface ChatStreamChunk {
  delta?: string;              // Texto del AI
  done?: boolean;              // Indica fin del stream
  error?: string;              // Mensaje de error

  toolCall?: {                 // Llamada a herramienta
    id: string;
    name: string;
    arguments: Record<string, any>;
    status: "running" | "success" | "error";
    timestamp: number;
  };

  toolResult?: {               // Resultado de herramienta
    id: string;
    result: any;
    status: "success" | "error";
    timestamp: number;
  };

  // NUEVO: Para aprobacion
  toolApproval?: {
    approvalId: string;        // ID unico de la aprobacion
    toolCallId: string;        // ID de la llamada
    toolName: string;          // Nombre de la herramienta
    input: Record<string, any>;// Argumentos
  };
}
```

### Estados de un Tool Part (en el AI SDK)

```typescript
type ToolPartState =
  | "input-streaming"     // Recibiendo argumentos
  | "input-available"     // Argumentos listos
  | "output-available"    // Resultado disponible
  | "output-error"        // Error en ejecucion
  | "output-denied"       // Usuario denego
  | "approval-requested"  // Esperando aprobacion <-- ESTADO CLAVE
  | "approval-responded"; // Usuario respondio
```

---

## 13. Diagrama de Flujo Completo

```
FRONTEND (Renderer)                    BACKEND (Main)                     MCP SERVER
       |                                    |                                  |
[1] Usuario envia mensaje                   |                                  |
       |                                    |                                  |
       +------ IPC: streamChat() ---------->|                                  |
       |                                    |                                  |
       |                            [2] aiService.streamChat()                 |
       |                                    |                                  |
       |                            [3] getMCPTools()                          |
       |                                    |-------- connect() -------------->|
       |                                    |<------- tools[] ----------------|
       |                                    |                                  |
       |                            [4] streamText({                           |
       |                                  tools, // needsApproval: true        |
       |                                })                                     |
       |                                    |                                  |
       |                            [5] AI decide usar herramienta             |
       |                                    |                                  |
       |                            [6] AI SDK emite:                          |
       |                                type: "tool-approval-request"          |
       |                                    |                                  |
       |<------- toolApproval chunk --------|                                  |
       |                                    |                                  |
[7] ElectronChatTransport                   |                                  |
    convierte a UIMessageChunk              |                                  |
       |                                    |                                  |
[8] ChatMessageItem detecta                 |                                  |
    state === 'approval-requested'          |                                  |
       |                                    |                                  |
[9] Renderiza ToolApprovalInline            |                                  |
    +--------------------------------+      |                                  |
    | Tool Approval Required          |      |                                  |
    | read_file [filesystem]         |      |                                  |
    | [Deny] [Approve]               |      |                                  |
    +--------------------------------+      |                                  |
       |                                    |                                  |
[10] Usuario click "Approve"                |                                  |
       |                                    |                                  |
[11] addToolApprovalResponse({              |                                  |
       id: "...",                           |                                  |
       approved: true                       |                                  |
     })                                     |                                  |
       |                                    |                                  |
[12] sendAutomaticallyWhen detecta          |                                  |
     approval response pendiente            |                                  |
       |                                    |                                  |
       +------ IPC: streamChat() ---------->|                                  |
       |     (con approval response)        |                                  |
       |                                    |                                  |
       |                            [13] AI SDK recibe aprobacion              |
       |                                    |                                  |
       |                            [14] Ejecuta tool.execute()                |
       |                                    |-------- callTool() ------------->|
       |                                    |<------- result[] ----------------|
       |                                    |                                  |
       |                            [15] Emite tool-result                     |
       |                                    |                                  |
       |<------- toolResult chunk ----------|                                  |
       |                                    |                                  |
[16] Renderiza resultado                    |                                  |
       |                                    |                                  |
      FIN                                  FIN                                FIN
```

---

## Resumen

1. **Backend marca herramientas con `needsApproval: true`** en `mcpToolsAdapter.ts`
2. **AI SDK detecta esto** y emite `tool-approval-request` en lugar de ejecutar
3. **Backend convierte a `toolApproval`** chunk y lo envia via IPC
4. **Transport convierte** el chunk al formato del AI SDK
5. **ChatMessageItem detecta** `state === 'approval-requested'` y muestra UI
6. **Usuario aprueba/deniega** usando `addToolApprovalResponse`
7. **`sendAutomaticallyWhen`** detecta la respuesta y envia automaticamente
8. **AI SDK ejecuta** la herramienta si fue aprobada
9. **Resultado** vuelve al frontend como `tool-result`

El sistema esta disenado para dar control total al usuario sobre que herramientas pueden ejecutarse, manteniendo la seguridad de la aplicacion.
