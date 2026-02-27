# Flujo Completo de Aprobación de Tools (Tool Approval)

> Investigación técnica sobre el sistema de aprobación de herramientas MCP en Levante.

---

## 1. Arquitectura General

El sistema de aprobación de tools implementa un flujo **bidireccional, asincrónico y basado en eventos** entre:

- **Main Process (Node.js)**: Ejecuta herramientas MCP y genera solicitudes de aprobación
- **Renderer Process (React)**: Muestra UI de aprobación y captura decisiones del usuario
- **AI SDK v5**: Orquesta el flujo de chat y gestiona estados de aprobación

---

## 2. Flujo Completo End-to-End

```
1. Usuario escribe prompt
   ↓
2. ChatPage: sendMessageAI(input)
   ↓
3. ElectronChatTransport.sendMessages()
   → IPC: levante/chat/stream(request)
   ↓
4. Main Process: AIService.streamChat()
   → AI SDK procesa
   → IA detecta que necesita una herramienta
   → IA genera tool-approval-request
   ↓
5. AIService caso "tool-approval-request"
   → Crea ChatStreamChunk.toolApproval
   ↓
6. ChatHandler: event.sender.send(`levante/chat/stream/${streamId}`, chunk)
   ↓
7. Renderer: ElectronChatTransport recibe en callback
   → convertChunkToUIMessageChunks()
   → Emite UIMessageChunk { type: "tool-approval-request", ... }
   ↓
8. AI SDK v5: parte state = 'approval-requested'
   ↓
9. ChatMessageItem renderiza <ToolApprovalInline>
   ↓
10a. [AUTO-APROBADO] isServerAutoApproved(serverId)
     → queueMicrotask(() => addToolApprovalResponse(..., true))

10b. [MANUAL] Usuario hace clic
     → onApprove() / onDeny()
     → addToolApprovalResponse({ id, approved })
   ↓
11. AI SDK: parte.approval = { approved: true/false }
    AI SDK: parte.state = 'approval-responded'
   ↓
12. Hook sendAutomaticallyWhen evalúa
    Si todas las aprobaciones son true:
      → Auto-continúa → streamChat nuevamente
    Si hay algún false:
      → Espera siguiente sendMessage del usuario
   ↓
13. [SI APPROVED] Siguiente streamChat:
    → Ejecuta herramienta
    → Retorna resultado
    → parte.state = 'output-available'

    [SI DENIED] Siguiente streamChat:
    → sanitizeMessagesForModel() convierte a denial message
    → Genera tool_result automático
    → IA genera respuesta explicando denegación
```

---

## 3. Diagrama de Datos

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN PROCESS (Node.js)                      │
├─────────────────────────────────────────────────────────────────────┤
│ AIService.streamChat()                                              │
│   ↓ AI SDK emite: tool-approval-request                            │
│   ↓                                                                  │
│ Caso: "tool-approval-request"                                       │
│   → Extrae: approvalId, toolCallId, toolName, input                │
│   → Genera: ChatStreamChunk.toolApproval                           │
│   ↓                                                                  │
│ IPC Handler: event.sender.send(`levante/chat/stream/${streamId}`,  │
│              { toolApproval: {...} })                               │
└─────────────────────┬───────────────────────────────────────────────┘
                      │ IPC (Electron)
┌─────────────────────▼───────────────────────────────────────────────┐
│                     RENDERER PROCESS (React)                         │
├─────────────────────────────────────────────────────────────────────┤
│ ElectronChatTransport.convertChunkToUIMessageChunks()              │
│   ↓ ChatStreamChunk.toolApproval                                   │
│   ↓                                                                  │
│ Emite: { type: "tool-approval-request", approvalId, ... }         │
│   ↓                                                                  │
│ AI SDK v5: actualiza part.state = 'approval-requested'            │
│   ↓                                                                  │
│ ChatMessageItem renderiza parte                                     │
│   ├─ Si isServerAutoApproved(serverId):                            │
│   │  → queueMicrotask(() => addToolApprovalResponse({              │
│   │      id: approvalId, approved: true                            │
│   │    }))                                                           │
│   │                                                                  │
│   └─ Si no:                                                          │
│      → Renderiza <ToolApprovalInline>                              │
│         ├ Botón "Deny"                                              │
│         ├ Botón "Approve"                                           │
│         └ Botón "Approve for Session"                               │
│                ↓                                                     │
│         Usuario hace clic                                           │
│           ↓                                                          │
│         addToolApprovalResponse({                                   │
│           id: approvalId,                                           │
│           approved: true/false                                      │
│         })                                                           │
│           ↓                                                          │
│         AI SDK: part.approval = { approved: true/false }           │
│         AI SDK: part.state = 'approval-responded'                  │
│           ↓                                                          │
│         Hook sendAutomaticallyWhen evalúa:                          │
│           ¿Todas las aprobaciones son true? → Si: auto-continúa    │
│                                             → No: espera usuario    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Archivos Clave

### Main Process

| Archivo | Líneas | Rol |
|---------|--------|-----|
| `src/main/services/aiService.ts` | 899–911, 1089–1099, 1373–1402, 135–148 | Orquestación AI SDK, emit `tool-approval-request`, sanitización de denegaciones |
| `src/main/services/ai/mcpToolsAdapter.ts` | 28–50, 182, 235, 292 | Convierte MCP tools a AI SDK format con flag `needsApproval` |
| `src/main/ipc/chatHandlers.ts` | 42–112 | IPC handlers para streaming, envía chunks al renderer |

### Renderer Process

| Archivo | Líneas | Rol |
|---------|--------|-----|
| `src/renderer/transports/ElectronChatTransport.ts` | 313–334 | Convierte `ChatStreamChunk` a `UIMessageChunk` con `type: "tool-approval-request"` |
| `src/renderer/components/ai-elements/tool-approval.tsx` | Completo | UI principal: botones approve/deny, preview de diff |
| `src/renderer/components/ai-elements/tool-call.tsx` | — | Visualización de tool calls ejecutadas |
| `src/renderer/components/ai-elements/tool.tsx` | — | Badges de estados (approval-requested, approval-responded) |
| `src/renderer/components/chat/ChatMessageItem.tsx` | 293–337, 56–59 | Detecta `approval-requested`, renderiza UI o auto-aprueba |
| `src/renderer/pages/ChatPage.tsx` | 79–84, 293–332 | Orquesta `useChat`, `sendAutomaticallyWhen`, auto-aprobación |
| `src/renderer/hooks/useToolAutoApproval.ts` | Completo | Mantiene el set de servidores auto-aprobados por sesión |
| `src/renderer/hooks/useToolApprovalWarning.ts` | — | Detecta si el proveedor no soporta approval |

### Tipos TypeScript

| Archivo | Tipos clave |
|---------|-------------|
| `src/preload/types/index.ts` | `ChatStreamChunk.toolApproval`, `ChatRequest` |
| `src/types/preferences.ts` | `MCPPreferences.disabledTools`, `providersWithoutToolApproval` |
| `src/main/types/mcp.ts` | `ToolCall`, `DisabledTools` |

---

## 5. Fase 1: Configuración Inicial

### 5.1 Determinación de herramientas que requieren aprobación

**`src/main/services/ai/mcpToolsAdapter.ts`** (líneas 28–50)

```typescript
interface GetMCPToolsOptions {
  skipApproval?: boolean;  // Configurable por proveedor
  disabledTools?: DisabledTools;
}

function createAISDKTool(serverId, mcpTool, { skipApproval = false }) {
  const aiTool = tool({
    needsApproval: !skipApproval,  // true = requiere aprobación
    execute: async (args) => { ... }
  });
}
```

### 5.2 Configuración por proveedor

**`src/types/preferences.ts`** (líneas 74–78)

```typescript
ai: {
  providersWithoutToolApproval?: ProviderType[];
  // Lista de proveedores que NO soportan el flujo de aprobación
}
```

**`src/main/services/aiService.ts`** (líneas 899–911)

```typescript
async shouldSkipToolApproval(providerType: ProviderType): Promise<boolean> {
  const providersWithoutApproval = preferences?.ai?.providersWithoutToolApproval ?? [];
  const shouldSkip = providersWithoutApproval.includes(providerType);
  return shouldSkip;
}
```

Cuando `skipApproval = true`, la tool se crea con `needsApproval: false` → ejecución automática sin confirmación.

---

## 6. Fase 2: Solicitud de Aprobación

### 6.1 AI SDK emite el evento

**`src/main/services/aiService.ts`** (líneas 1373–1402)

```typescript
case "tool-approval-request":
  const approvalChunk = chunk as {
    approvalId: string;
    toolCall?: {
      toolCallId: string;
      toolName: string;
      input?: Record<string, unknown>;
    };
  };

  yield {
    toolApproval: {
      approvalId: approvalChunk.approvalId,
      toolCallId: approvalChunk.toolCall?.toolCallId ?? '',
      toolName: approvalChunk.toolCall?.toolName ?? '',
      input: approvalChunk.toolCall?.input ?? {},
    },
  };
  break;
```

### 6.2 Tipo del chunk IPC

**`src/preload/types/index.ts`** (líneas 56–61)

```typescript
export interface ChatStreamChunk {
  toolApproval?: {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    input: Record<string, any>;
  };
}
```

### 6.3 Envío al renderer

**`src/main/ipc/chatHandlers.ts`** (líneas 42–112)

```typescript
async function handleChatStream(event, request) {
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  setImmediate(async () => {
    for await (const chunk of aiService.streamChat(request)) {
      event.sender.send(`levante/chat/stream/${streamId}`, chunk);
    }
  });

  return { streamId };
}
```

---

## 7. Fase 3: Conversión a UI Message Chunks

**`src/renderer/transports/ElectronChatTransport.ts`** (líneas 313–334)

```typescript
private *convertChunkToUIMessageChunks(chunk: ChatStreamChunk): Generator<UIMessageChunk> {
  if (chunk.toolApproval) {
    const safeInput = chunk.toolApproval.input ?? {};

    yield {
      type: "tool-approval-request",
      toolCallId: chunk.toolApproval.toolCallId,
      toolName: chunk.toolApproval.toolName,
      approvalId: chunk.toolApproval.approvalId,
      input: safeInput,
      toolCall: {
        toolCallId: chunk.toolApproval.toolCallId,
        toolName: chunk.toolApproval.toolName,
        input: safeInput,
      },
    } as any;
  }
}
```

El AI SDK v5 transforma este chunk automáticamente a una parte con `state: 'approval-requested'`.

---

## 8. Fase 4: Renderización de UI

### 8.1 ChatMessageItem detecta el estado

**`src/renderer/components/chat/ChatMessageItem.tsx`** (líneas 293–337)

```typescript
if (part.state === 'approval-requested' && addToolApprovalResponse) {
  const serverId = toolName.includes('_') ? toolName.split('_')[0] : 'unknown';

  // Auto-aprobar si el servidor está auto-aprobado para esta sesión
  if (isServerAutoApproved?.(serverId)) {
    queueMicrotask(() => {
      addToolApprovalResponse({
        id: part.approval?.id || part.toolCallId,
        approved: true,
      });
    });
    return <div>Auto-approved: {displayToolName}</div>;
  }

  // Mostrar UI interactiva
  return (
    <ToolApprovalInline
      toolName={toolName}
      input={part.input || {}}
      approvalId={part.approval?.id || part.toolCallId}
      onApprove={() => addToolApprovalResponse({ id: approvalId, approved: true })}
      onDeny={() => addToolApprovalResponse({ id: approvalId, approved: false })}
      onApproveForSession={onApproveServerForSession}
    />
  );
}
```

### 8.2 Componente ToolApprovalInline

**`src/renderer/components/ai-elements/tool-approval.tsx`**

```typescript
interface ToolApprovalInlineProps {
  toolName: string;                              // Formato: "serverId_toolName"
  input: Record<string, unknown>;
  approvalId: string;
  onApprove: () => void;
  onDeny: () => void;
  onApproveForSession?: (serverId: string) => void;
  className?: string;
}
```

**Características:**
- Preview de diff para herramientas `edit` y `write` (usa `createPatch`)
- Parámetros JSON expandibles
- Tres opciones: Deny / Approve / Approve for Session

---

## 9. Fase 5: Respuesta del Usuario

### 9.1 ChatPage: configuración del hook useChat

**`src/renderer/pages/ChatPage.tsx`** (líneas 293–332)

```typescript
const {
  messages,
  sendMessage: sendMessageAI,
  addToolApprovalResponse,
} = useChat({
  id: currentSession?.id || 'new-chat',
  transport,

  // Solo continuar automáticamente si TODAS las aprobaciones son true
  sendAutomaticallyWhen: ({ messages }) => {
    const lastAssistantMessage = messages
      .slice()
      .reverse()
      .find((m) => m.role === 'assistant');

    if (!lastAssistantMessage) return false;

    const toolParts = lastAssistantMessage.parts?.filter((p: any) =>
      p.type?.startsWith('tool-')
    ) || [];

    const partsWithApprovalResponse = toolParts.filter(
      (p: any) => p.state === 'approval-responded' && p.approval
    );

    if (partsWithApprovalResponse.length === 0) return false;

    return partsWithApprovalResponse.every(
      (p: any) => p.approval.approved === true
    );
  },
});
```

### 9.2 Función addToolApprovalResponse

Llamada con:
```typescript
addToolApprovalResponse({
  id: approvalId,      // ID único de la solicitud
  approved: true/false // Decisión del usuario
});
```

Esto dispara en el AI SDK v5:
1. `part.approval = { approved: true/false }`
2. `part.state = 'approval-responded'`
3. Evaluación de `sendAutomaticallyWhen`
4. Si todas son `true` → auto-continúa el stream
5. Si hay algún `false` → espera

---

## 10. Fase 6: Manejo de Denegaciones

**`src/main/services/aiService.ts`** (líneas 135–148) — `sanitizeMessagesForModel()`

```typescript
if (part.state === 'approval-responded') {
  const wasDenied = part.approval?.approved === false;
  if (wasDenied) {
    part = {
      ...part,
      state: 'output-available',
      output: 'Tool execution was denied by the user.',
    };
  }
}
```

**Razón:** Anthropic y OpenRouter requieren un `tool_result` por cada `tool_use`. Sin esta conversión, retornan error 500.

---

## 11. Auto-Aprobación por Sesión

### Hook useToolAutoApproval

**`src/renderer/hooks/useToolAutoApproval.ts`**

```typescript
interface UseToolAutoApprovalReturn {
  autoApprovedServers: Set<string>;
  approveServerForSession: (serverId: string) => void;
  isServerAutoApproved: (serverId: string) => boolean;
  clearAutoApprovals: () => void;
}
```

**Ciclo de vida:**
- Duración: solo por sesión (en memoria)
- Limpieza: al cambiar sesión o cerrar app
- Alcance: por servidor MCP completo, no por herramienta individual

### Flujo de "Approve for Session"

```
1. Usuario hace clic en "Approve for Session"
   ↓
2. ToolApprovalInline.tsx:
   handleApproveForSession = () => {
     onApprove();                    // Aprobar esta herramienta
     onApproveForSession?.(serverId); // Registrar servidor
   }
   ↓
3. ChatPage: approveServerForSession(serverId)
   → agrega serverId al Set en useToolAutoApproval
   ↓
4. En próximos approval-requested:
   isServerAutoApproved(serverId) === true
   → queueMicrotask(() => addToolApprovalResponse({ id, approved: true }))
```

---

## 12. Estados de una Herramienta

```
1. 'input-streaming'     → Argumentos llegando en streaming
2. 'input-available'     → Argumentos listos, esperando ejecución
3. 'approval-requested'  → ⭐ Esperando aprobación del usuario
4. 'approval-responded'  → Usuario respondió (approved: true/false)
5. 'output-available'    → Ejecución completada exitosamente
6. 'output-error'        → Error durante ejecución
7. 'output-denied'       → Denegada por el usuario
```

---

## 13. Preview de Diff para Herramientas de Edición

**`src/renderer/components/ai-elements/tool-approval.tsx`** (líneas 75–90)

```typescript
const normalizedTool = displayToolName.toLowerCase();
const isDiffTool = normalizedTool === 'edit' || normalizedTool === 'write';

if (isDiffTool) {
  const filePath = String(input.file_path ?? 'file');
  const fname = filePath.split(/[/\\]/).pop() ?? 'file';

  if (normalizedTool === 'edit') {
    previewDiff = createPatch(fname, String(input.old_string ?? ''), String(input.new_string ?? ''));
  } else {
    previewDiff = createPatch(fname, '', String(input.content ?? ''));
  }
}
```

El componente `<DiffViewer>` muestra:
- Líneas añadidas (`+`) en verde
- Líneas eliminadas (`-`) en rojo
- Estadísticas de cambios

---

## 14. Puntos Críticos de Integración

### AI SDK v5 - Custom Transport

El transporte personalizado debe:
1. Emitir `type: "tool-approval-request"` correctamente
2. **NO** emitir `tool-input-start` antes de `approval-request` (causa reset de estado)
3. Garantizar que `input` nunca sea `undefined`

### IPC Main ↔ Renderer

Debe mantener:
1. `approvalId` consistente entre chunks del mismo stream
2. `toolName` con formato `"serverId_toolName"` correcto
3. Mapeo limpio entre Electron IPC y AI SDK chunks

### sendAutomaticallyWhen

Lógica crítica:
- Se evalúa **después** de cada llamada a `addToolApprovalResponse`
- Solo continúa si **TODAS** las aprobaciones son `true`
- Se ejecuta en sincronía con los cambios de estado del AI SDK

---

## 15. Logging y Debug

**Categorías relevantes:**
- `logger.aiSdk.info()` — Solicitudes de aprobación recibidas
- `logger.aiSdk.debug()` — Detalles de chunks y conversión
- `logger.aiSdk.warn()` — Advertencias de configuración de proveedor
- `logger.core.error()` — Errores graves

**Variables de entorno:**
```
DEBUG_AI_SDK=true  → Logs del AI SDK y aprobaciones
DEBUG_MCP=true     → Logs de herramientas MCP
DEBUG_IPC=true     → Logs de comunicación IPC
```
