# Flujo de Ejecución de Herramientas MCP en Levante

Este documento describe en detalle el flujo completo de ejecución de herramientas (tools) MCP en la aplicación Levante.

## Tabla de Contenidos

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [Arquitectura General](#arquitectura-general)
3. [Descubrimiento de Herramientas](#descubrimiento-de-herramientas)
4. [Ejecución de Herramientas](#ejecución-de-herramientas)
5. [Flujo Completo Renderer → Main → MCP](#flujo-completo-renderer--main--mcp)
6. [Streaming de Respuestas](#streaming-de-respuestas)
7. [Sistema de Aprobación](#sistema-de-aprobación)
8. [Manejo de Errores](#manejo-de-errores)
9. [Archivos Involucrados](#archivos-involucrados)
10. [Librerías y Dependencias](#librerías-y-dependencias)
11. [Diagrama de Flujo Visual](#diagrama-de-flujo-visual)

---

## Resumen Ejecutivo

El flujo de ejecución de herramientas MCP en Levante sigue estos pasos principales:

1. **Descubrimiento**: `getMCPTools()` conecta en paralelo a todos los servidores y lista herramientas
2. **Conversión**: `createAISDKTool()` transforma herramientas MCP al formato AI SDK
3. **Integración**: AI SDK incluye herramientas en `streamText({ tools, ... })`
4. **Ejecución**: AI SDK ejecuta automáticamente `tool.execute()` cuando el modelo lo solicita
5. **Resultado**: `processToolResult()` procesa el resultado, detecta widgets, inyecta bridges
6. **Streaming**: Eventos (`toolCall`, `toolResult`, `toolError`) se envían al renderer en tiempo real
7. **Monitoreo**: `mcpHealthService` registra éxitos/errores para cada herramienta
8. **Recuperación**: Si falla, intenta retry sin tools o con configuración alternativa

---

## Arquitectura General

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RENDERER PROCESS                                │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐                │
│  │  ChatPage   │───▶│  useChat()   │───▶│ IPC: chat/stream│                │
│  └─────────────┘    └──────────────┘    └────────┬────────┘                │
└──────────────────────────────────────────────────│──────────────────────────┘
                                                   │
                           IPC Bridge (levante/*)  │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               MAIN PROCESS                                   │
│  ┌────────────────┐    ┌─────────────────┐    ┌──────────────────────┐     │
│  │ chatHandlers   │───▶│   AIService     │───▶│  mcpToolsAdapter     │     │
│  └────────────────┘    └────────┬────────┘    └──────────┬───────────┘     │
│                                 │                        │                  │
│                                 ▼                        ▼                  │
│                      ┌──────────────────┐      ┌─────────────────────┐     │
│                      │   AI SDK         │      │    MCPService       │     │
│                      │ (streamText)     │◀────▶│ (mcp-use/official)  │     │
│                      └──────────────────┘      └──────────┬──────────┘     │
└──────────────────────────────────────────────────────────│──────────────────┘
                                                           │
                              MCP Protocol (stdio/sse)     │
                                                           ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MCP SERVERS                                        │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐                   │
│  │  filesystem   │  │    weather    │  │   database    │  ...              │
│  └───────────────┘  └───────────────┘  └───────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Descubrimiento de Herramientas

### Proceso de Descubrimiento

El descubrimiento de herramientas ocurre al inicio de cada sesión de chat cuando MCP está habilitado.

**Archivo principal**: `src/main/services/ai/mcpToolsAdapter.ts` (líneas 29-173)

**Función**: `getMCPTools()`

```
Fase 1: Conexión paralela a todos los servidores MCP
└─ Para cada servidor: mcpService.connectServer()
└─ Los servidores ya conectados se reutilizan (isConnected check)

Fase 2: Listado paralelo de herramientas
└─ Para cada servidor: mcpService.listTools(serverId)
└─ Retorna array de Tools con name, description, inputSchema

Fase 3: Conversión a formato AI SDK
└─ createAISDKTool(serverId, mcpTool)
└─ Sanitización de schemas JSON
└─ Normalización de nombres (serverId_toolName)
```

### Implementación de listTools

**Archivo**: `src/main/services/mcp/mcpUseService.ts` (líneas 395-419)

```typescript
async listTools(serverId: string): Promise<Tool[]> {
  const session = this.sessions.get(serverId);
  if (!session) {
    throw new Error(`Session ${serverId} not found. Make sure to connect first.`);
  }

  try {
    const tools = session.connector.tools;
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema,
      _meta: tool._meta, // Metadata para widgets (e.g., openai/outputTemplate)
    }));
  }
}
```

### Tipo de Datos Tool

**Archivo**: `src/main/types/mcp.ts` (líneas 55-67)

```typescript
export interface Tool {
  name: string;
  description: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  _meta?: Record<string, any>; // Widget config (openai/outputTemplate para Skybridge)
  annotations?: ToolAnnotations; // MCP spec: readOnly, destructive, idempotent, openWorld
}
```

---

## Ejecución de Herramientas

### Flujo en AI Service

**Archivo**: `src/main/services/aiService.ts` (líneas 1026-1088)

```
1. Llamada a streamText() de AI SDK
   ├─ Parámetros:
   │  ├─ model: Language model
   │  ├─ messages: Sanitizadas (líneas 91-196)
   │  ├─ tools: Record<string, AI SDK Tool>
   │  ├─ system: System prompt
   │  └─ stopWhen: stepCountIs(calculateMaxSteps(...))
   │
2. Manejo de full stream (fullStream loop - línea 1094)
   ├─ AI SDK envía eventos por tipo de chunk:
   │  ├─ text-delta: Texto generado
   │  ├─ tool-call: Se solicita ejecutar herramienta
   │  ├─ tool-result: Resultado de la herramienta
   │  ├─ tool-error: Error en ejecución
   │  ├─ reasoning-start/delta/end: Pensamiento del modelo
   │  └─ error: Error general
   │
3. AI SDK maneja automáticamente:
   ├─ Llamada a tool.execute(args)
   ├─ Obtención del resultado
   └─ Iteración si hay más tool calls
```

### Creación de Herramientas en Formato AI SDK

**Archivo**: `src/main/services/ai/mcpToolsAdapter.ts` (líneas 178-384)

**Función**: `createAISDKTool(serverId: string, mcpTool: Tool)`

```typescript
const aiTool = tool({
  description: mcpTool.description || `Tool from MCP server ${serverId}`,
  inputSchema: jsonSchema(sanitizedSchema),
  execute: async (args: any) => {
    // 1. Log de ejecución
    logger.aiSdk.debug("Executing MCP tool", {
      serverId,
      toolName: mcpTool.name,
      args,
    });

    // 2. Llamada al MCP service
    const result = await mcpService.callTool(serverId, {
      name: mcpTool.name,
      arguments: args,
    });

    // 3. Procesamiento de resultado
    // - Detección de widgets (mcp-use, Apps SDK, MCP Apps)
    // - Inyección de bridges si es necesario
    // - Normalización de recursos UI

    // 4. Retorno del resultado procesado
    return processToolResult(...);
  },
});
```

### Ejecución Real del Tool

**Archivo**: `src/main/services/mcp/mcpUseService.ts` (líneas 421-498)

```typescript
async callTool(serverId: string, toolCall: ToolCall): Promise<ToolResult> {
  const session = this.sessions.get(serverId);
  if (!session) {
    throw new Error(`Session ${serverId} not found. Make sure to connect first.`);
  }

  try {
    // Llamada a mcp-use connector
    const result = await session.connector.callTool(toolCall.name, toolCall.arguments);

    // Normalización de resultado
    let content: any[];
    if (Array.isArray(result.content)) {
      content = result.content;
    } else if (result.content !== undefined && result.content !== null) {
      content = [{
        type: "text",
        text: typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content)
      }];
    } else {
      content = [];
    }

    const finalResult: ToolResult = {
      content,
      isError: Boolean(result.isError),
      _meta: result._meta,           // Metadata de widgets
      structuredContent: result.structuredContent, // Datos estructurados
    };

    return finalResult;
  }
}
```

---

## Flujo Completo Renderer → Main → MCP

### Entrada desde el Renderer

**Archivo**: `src/main/ipc/chatHandlers.ts` (líneas 42-112)

**IPC Handler**: `levante/chat/stream`

```typescript
async function handleChatStream(
  event: IpcMainInvokeEvent,
  request: ChatRequest
): Promise<{ streamId: string }> {
  // 1. Generación de streamId único
  const streamId = `stream_${Date.now()}_${Math.random()...}`;

  // 2. Inicio de streaming asincrónico
  setImmediate(async () => {
    try {
      for await (const chunk of aiService.streamChat(request)) {
        // 3. Envío de chunks al renderer
        event.sender.send(`levante/chat/stream/${streamId}`, chunk);

        if (chunk.done) break;
      }
    } catch (error) {
      event.sender.send(`levante/chat/stream/${streamId}`, {
        error: error.message,
        done: true,
      });
    } finally {
      activeStreams.delete(streamId);
    }
  });

  return { streamId };
}
```

### Evento Tool Call en Stream

**Archivo**: `src/main/services/aiService.ts` (líneas 1177-1214)

```typescript
case "tool-call":
  this.logger.aiSdk.debug("Tool call chunk received", {
    type: chunk.type,
    toolCallId: chunk.toolCallId,
    toolName: chunk.toolName,
    hasArguments: !!(chunk as any).arguments,
  });

  // Validación de nombre vacío
  if (!chunk.toolName || chunk.toolName.trim() === "") {
    logger.aiSdk.error("ERROR: Tool call with empty name detected!", {
      toolCallId: chunk.toolCallId,
      toolName: chunk.toolName,
      availableTools: Object.keys(tools),
    });
    continue; // Skip this problematic tool call
  }

  // Yield al cliente renderer
  yield {
    toolCall: {
      id: chunk.toolCallId,
      name: chunk.toolName,
      arguments: (chunk as any).arguments || {},
      status: "running" as const,
      timestamp: Date.now(),
    },
  };
  break;
```

### Evento Tool Result en Stream

**Archivo**: `src/main/services/aiService.ts` (líneas 1216-1239)

```typescript
case "tool-result":
  this.logger.aiSdk.debug("Tool result RAW chunk", {
    chunk: JSON.stringify(chunk, null, 2),
  });

  // Extracción del resultado
  const toolResult = (chunk as any).output || {};

  yield {
    toolResult: {
      id: chunk.toolCallId,
      result: toolResult,
      status: "success" as const,
      timestamp: Date.now(),
    },
  };
  break;
```

---

## Streaming de Respuestas

### Flujo de Streaming

**Archivo**: `src/main/services/aiService.ts` (líneas 1094-1314)

```typescript
for await (const chunk of result.fullStream) {
  switch (chunk.type) {
    case "text-delta":
      yield { delta: chunk.text };
      break;

    case "reasoning-start":
      // Iniciar acumulación de reasoning
      reasoningBlocks.set(chunkId, '');
      break;

    case "reasoning-delta":
      // Acumular reasoning por bloque
      reasoningBlocks.set(id, currentText + delta);
      yield { reasoningText: accumulated, reasoningId: id };
      break;

    case "tool-call":
      // Tool solicitada por el modelo
      yield { toolCall: { id, name, arguments, status, timestamp } };
      break;

    case "tool-result":
      // Resultado de ejecución
      yield { toolResult: { id, result, status, timestamp } };
      break;

    case "tool-error":
      // Error en ejecución
      yield { toolResult: { id, result: { error }, status: "error", timestamp } };
      break;

    case "error":
      // Manejo especial: si es error de tool-use no soportado
      if (isToolUseNotSupportedError(chunk.error) && enableMCP) {
        // Retry sin tools
        yield* this.streamChat({ ...request, enableMCP: false });
      }
      break;
  }
}
```

### Tipos de Chunks Enviados

```typescript
interface ChatStreamChunk {
  delta?: string;                    // Texto generado incrementalmente
  done?: boolean;                    // Stream completado
  error?: string;                    // Error ocurrido
  sources?: Array<{ url; title }>;   // URLs de búsqueda web
  reasoningText?: string;            // Pensamiento del modelo
  reasoningId?: string;              // ID para reconciliación

  toolCall?: {
    id: string;                      // ID único de llamada
    name: string;                    // Nombre de la herramienta
    arguments: Record<string, any>;  // Argumentos
    status: "running" | "success" | "error";
    timestamp: number;
  };

  toolResult?: {
    id: string;                      // Corresponde a toolCall.id
    result: any;                     // Resultado de ejecución
    status: "success" | "error";
    timestamp: number;
  };

  generatedAttachment?: {            // Para modelos de generación
    type: "image" | "audio" | "video";
    mime: string;
    dataUrl: string;
    filename: string;
  };
}
```

---

## Sistema de Aprobación

### Estado Actual

**NO HAY SISTEMA DE APROBACIÓN EXPLÍCITO** para la ejecución de herramientas.

Sin embargo, existen mecanismos de control:

### Validación Pre-ejecución

**Archivo**: `src/main/services/aiService.ts` (líneas 883-913)

```typescript
// VALIDACIÓN: ¿Soporta el modelo tools?
if (enableMCP && !isLocalProvider && !modelInfo.capabilities.supportsTools) {
  yield {
    delta: `⚠️ **Tool Use Not Supported**\n\nThe model "${model}" doesn't support tool calling...`,
  };
  request.enableMCP = false;
}
```

### Descubrimiento de Tools Habilitadas

**Archivo**: `src/main/services/ai/mcpToolsAdapter.ts` (líneas 45-80)

```typescript
// Solo se conectan servidores MCP que estén ACTIVOS en configuración
const config = await configManager.loadConfiguration();
const serverEntries = Object.entries(config.mcpServers);

// Solo hay 2 categorías:
// - mcpServers: ACTIVOS (se conectan)
// - disabled: DESHABILITADOS (no se conectan)
```

### Validación de Herramientas Disponibles

**Archivo**: `src/main/services/aiService.ts` (líneas 951-1004)

```typescript
// Validación rigurosa antes de enviar a AI SDK:
if (invalidTools.length > 0) {
  logger.aiSdk.error("Found invalid tools", { invalidTools });
}

// Verificación de objetos tool válidos
const invalidToolObjects = Object.entries(tools).filter(([key, tool]) => {
  return !tool || typeof tool !== "object" || typeof tool.execute !== "function";
});

if (invalidToolObjects.length > 0) {
  logger.aiSdk.error("CRITICAL: Invalid tool objects detected", {
    invalidToolNames: invalidToolObjects.map(([key]) => key),
  });
  invalidToolObjects.forEach(([key]) => delete tools[key]);
}
```

---

## Manejo de Errores

### Detección de Errores

**Archivo**: `src/main/services/ai/toolErrorDetector.ts`

```typescript
export function isToolUseNotSupportedError(error: unknown): boolean {
  // Patrones detectados:
  const toolUseErrorPatterns = [
    'no endpoints found that support tool use',
    'tool use is not supported',
    'does not support tool',
    'function calling is not supported',
    'tool_choice is not supported',
    'tools parameter is not supported',
    'model does not support tools',
  ];

  // Búsqueda en múltiples ubicaciones del error
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (toolUseErrorPatterns.some(pattern => message.includes(pattern))) {
      return true;
    }
  }

  return false;
}
```

### Recuperación de Errores

**Archivo**: `src/main/services/aiService.ts` (líneas 1262-1298)

```typescript
case "error":
  const isToolUseError = isToolUseNotSupportedError(chunk.error);

  if (isToolUseError && enableMCP) {
    // RETRY SIN TOOLS
    yield {
      delta: `⚠️ **Tool Use Not Supported**\n\n...`,
    };

    try {
      const retryRequest = { ...request, enableMCP: false };
      for await (const retryChunk of this.streamChat(retryRequest)) {
        yield retryChunk;
      }
      return;
    } catch (retryError) {
      logger.aiSdk.error("Retry without tools also failed", {
        error: retryError,
        model,
      });
      yield {
        error: "Failed to process request both with and without tools.",
        done: true,
      };
      return;
    }
  }
  break;
```

### Health Monitoring

**Archivo**: `src/main/services/mcpHealthService.ts`

```typescript
recordSuccess(serverId: string, toolName: string): void {
  health.successCount++;
  health.consecutiveErrors = 0;
  health.lastSuccess = Date.now();
}

recordError(serverId: string, toolName: string, error: string): void {
  health.errorCount++;
  health.consecutiveErrors++;
  health.lastError = error;

  // Marcar como unhealthy si hay 5+ errores consecutivos
  if (health.consecutiveErrors >= 5) {
    health.status = 'unhealthy';
  }
}
```

---

## Archivos Involucrados

### Main Process - MCP Services

| Archivo | Descripción |
|---------|-------------|
| `src/main/services/mcp/IMCPService.ts` | Interfaz del servicio MCP (45 métodos) |
| `src/main/services/mcp/mcpUseService.ts` | Implementación con mcp-use (1043 líneas) |
| `src/main/services/mcp/mcpServiceFactory.ts` | Factory pattern (selección SDK) |
| `src/main/services/mcp/mcpLegacyService.ts` | Implementación oficial SDK |
| `src/main/services/mcp/types.ts` | Tipos MCP registry |
| `src/main/services/mcp/MCPCacheService.ts` | Cacheo de tools |
| `src/main/services/mcp/MCPProviderService.ts` | Sincronización de providers |
| `src/main/services/mcp/registry.ts` | Carga de registry |
| `src/main/services/mcp/transports.ts` | Configuración de transports |
| `src/main/services/mcp/commandResolver.ts` | Resolución de comandos |
| `src/main/services/mcp/packageValidator.ts` | Validación de paquetes |

### Main Process - AI Integration

| Archivo | Descripción |
|---------|-------------|
| `src/main/services/ai/mcpToolsAdapter.ts` | Conversión MCP → AI SDK (924 líneas) |
| `src/main/services/ai/schemaSanitizer/` | Sanitización de schemas |
| `src/main/services/ai/toolErrorDetector.ts` | Detección de errores |
| `src/main/services/aiService.ts` | Orquestación de chat (1600+ líneas) |
| `src/main/services/mcpHealthService.ts` | Health monitoring de tools |

### Main Process - IPC Handlers

| Archivo | Descripción |
|---------|-------------|
| `src/main/ipc/mcpHandlers/index.ts` | Registro de handlers |
| `src/main/ipc/mcpHandlers/tools.ts` | Handlers de tools |
| `src/main/ipc/mcpHandlers/connection.ts` | Connection handlers |
| `src/main/ipc/mcpHandlers/configuration.ts` | Configuration handlers |
| `src/main/ipc/mcpHandlers/resources.ts` | Resource handlers |
| `src/main/ipc/mcpHandlers/prompts.ts` | Prompt handlers |
| `src/main/ipc/mcpHandlers/health.ts` | Health handlers |
| `src/main/ipc/chatHandlers.ts` | Chat streaming handlers |
| `src/main/ipc/inferenceHandlers.ts` | Inference task handlers |

### Renderer

| Archivo | Descripción |
|---------|-------------|
| `src/renderer/stores/mcpStore.ts` | Zustand store para MCP state |
| `src/renderer/hooks/useMCPConfig.ts` | Hook para configuración MCP |
| `src/renderer/hooks/useInference.ts` | Hook para inference |

### Types

| Archivo | Descripción |
|---------|-------------|
| `src/main/types/mcp.ts` | Definición de tipos MCP (194 líneas) |
| `src/renderer/types/mcp.ts` | Tipos del renderer |

---

## Librerías y Dependencias

### Dependencias Principales

```json
{
  "mcp-use": "^1.11.2",
  "@modelcontextprotocol/sdk": "^1.25.1",
  "@mcp-ui/client": "^5.17.1",
  "@mcp-ui/server": "^5.16.3",
  "@ai-sdk/*": "^3.0.0+",
  "ai": "^6.0.3",
  "electron": "^37.3.1",
  "electron-store": "^11.0.2"
}
```

### Jerarquía de Abstracción

```
┌─ mcp-use (default, recomendado) ← FRAMEWORK MODERNO
│  └─ Code Mode soportado (40-60% reducción de tokens)
│  └─ UI widgets built-in
│  └─ Session management automático
│
├─ @modelcontextprotocol/sdk ← OFFICIAL SDK (legacy)
│  └─ Soporte directo del protocolo MCP
│
└─ @mcp-ui/* ← WIDGET RENDERING
   └─ Client y server para UI resources
```

### Configuración del MCP Service (Factory Pattern)

**Archivo**: `src/main/services/mcp/mcpServiceFactory.ts`

```typescript
export class MCPServiceFactory {
  static async create(preferences?: MCPPreferences): Promise<IMCPService> {
    const mcpPrefs = preferences || DEFAULT_MCP_PREFERENCES;

    // SELECCIÓN DE SDK EN RUNTIME
    if (mcpPrefs.sdk === 'official-sdk') {
      // Use Official MCP SDK (@modelcontextprotocol/sdk)
      return new MCPLegacyService();
    } else {
      // Default to mcp-use (RECOMENDADO - soporta Code Mode)
      return new MCPUseService(mcpPrefs);
    }
  }
}
```

### Code Mode Configuration

```typescript
interface CodeModeConfig {
  enabled: boolean;
  executor?: 'vm' | 'e2b';
  executorOptions?: {
    timeout?: number;
    memoryLimit?: number;
    apiKey?: string;  // E2B only
  };
}

// Configuración guardada en ui-preferences.json
// Aplicable por servidor o global
```

---

## Diagrama de Flujo Visual

```
RENDERER                          MAIN PROCESS                        MCP SERVER
─────────────────────────────────────────────────────────────────────────────
User selects model
        │
        ├─ levante/chat/stream ──────→ handleChatStream()
        │                              │
        │                              ├─ AIService.streamChat()
        │                              │  │
        │                              │  ├─ Get MCP Tools (parallel connect & list)
        │                              │  │  │
        │                              │  │  ├─ getMCPTools()
        │                              │  │  │  │
        │                              │  │  │  ├─ For each server:
        │                              │  │  │  │  └─ mcpService.connectServer()────────→ Establish connection
        │                              │  │  │  │
        │                              │  │  │  ├─ For each server:
        │                              │  │  │  │  └─ mcpService.listTools()────────────→ tools = []
        │                              │  │  │  │
        │                              │  │  │  └─ Convert to AI SDK format
        │                              │  │  │
        │                              │  ├─ streamText({ tools, messages, model })
        │                              │  │  │
        │                              │  │  ├─ FOR EACH chunk from fullStream:
        │                              │  │  │  │
        │◄─ delta ─────────────────────│◄─│──│◄─ text-delta
        │  (texto)                     │  │  │  │
        │                              │  │  │  ├─ tool-call
        │                              │  │  │  │  │
        │                              │  │  │  │  └─ AI SDK ejecuta tool.execute(args)
        │                              │  │  │  │     │
        │                              │  │  │  │     ├─ mcpService.callTool()──────────→ connector.callTool(name, args)
        │                              │  │  │  │     │                                   │
        │◄─ toolCall ────────────────←│◄─│◄─│◄─│────→ EJECUTA EN SERVIDOR MCP
        │  (corriendo)                 │  │  │  │     │
        │                              │  │  │  │     └─ return ToolResult
        │                              │  │  │  │        { content[], isError, _meta, structuredContent }
        │                              │  │  │  │
        │                              │  │  │  ├─ processToolResult()
        │                              │  │  │  │  ├─ Detect widgets (mcp-use, Apps SDK, MCP Apps)
        │                              │  │  │  │  ├─ Inyectar bridges si es necesario
        │                              │  │  │  │  └─ Normalizar recursos UI
        │                              │  │  │  │
        │                              │  │  │  ├─ tool-result
        │◄─ toolResult ──────────────←│◄─│◄─│◄─│
        │  (éxito/error)               │  │  │  │
        │                              │  │  │  ├─ Modelo continúa generando...
        │                              │  │  │  │  └─ ¿Más tool calls?
        │                              │  │  │  │     GOTO: tool-call loop
        │                              │  │  │  │
        │                              │  │  │  └─ Done
        │◄─ done: true ──────────────←│◄─│◄─│◄─
        │
        Display complete response with:
        - Text
        - Tool calls & results
        - UI widgets (rendered from uiResources)
        - Reasoning (si disponible)
```

---

## Procesamiento de Resultados de Tools

### Detección de Widgets

**Archivo**: `src/main/services/ai/mcpToolsAdapter.ts` (líneas 229-358)

**Prioridad de protocolos detectados:**

```
1. mcp-use/widget (en result._meta)
   └─ Formato: { name, type, html, props }

2. openai/outputTemplate (Apps SDK Skybridge)
   └─ URI tipo ui://... que apunta a recurso HTML

3. ui/resourceUri (MCP Apps SEP-1865)
   └─ Comunicación via window.mcpApp API

4. Recursos embebidos en content[]
   └─ Detección de ui:// o mimeType text/html
```

### Inyección de Bridges

```typescript
// Para Apps SDK widgets
if (isAppsSdkWidget && resourceData?.text) {
  if (!resourceData.text.includes("window.openai")) {
    // Inyectar bridge de OpenAI si no está presente
    resourceData.text = injectAppsSdkBridge(resourceData.text, {
      toolInput: args,
      toolOutput: result.structuredContent || {},
      responseMetadata: result._meta || {},
      locale: "en-US",
    });
  }
}

// Para MCP Apps widgets
if (uiResourceUri && uiResourceUri.startsWith("ui://")) {
  const uiResource = {
    type: "resource",
    resource: {
      uri: uiResourceUri,
      mimeType: "text/html",
      text: widgetHtml,
      _meta: {
        widgetProtocol: "mcp-apps" as const,
        bridgeOptions: {
          toolInput: args,
          toolOutput: widgetData,
          responseMetadata: result._meta || {},
          serverId,
        },
      },
    },
  };
}
```

---

## Sanitización de Mensajes

**Archivo**: `src/main/services/aiService.ts` (líneas 91-196)

```typescript
function sanitizeMessagesForModel(messages: UIMessage[]): UIMessage[] {
  const clonedMessages = JSON.parse(JSON.stringify(messages)); // Deep clone

  return clonedMessages.map((message: any) => {
    const parts = message.parts;
    if (!Array.isArray(parts)) return message;

    return parts.map((part: any) => {
      // 1. Remover providerExecuted si es null (GitHub Issue #8061)
      if ('providerExecuted' in part && part.providerExecuted === null) {
        const { providerExecuted, ...partWithoutProvider } = part;
        part = partWithoutProvider;
      }

      // 2. IMPORTANTE: Preservar Google's thoughtSignature para Gemini 3
      // Sin esto, Gemini 3 falla con "function call is missing a thought_signature"
      const hasThoughtSignature = metadata.google?.thoughtSignature ||
                                  metadata.vertex?.thoughtSignature;
      if (!hasThoughtSignature) {
        const { providerMetadata, ...partWithoutMetadata } = part;
        part = partWithoutMetadata;
      }

      // 3. Sanitizar outputs de tools con uiResources
      // Según MCP spec 2025-11-25:
      // - structuredContent → ENVIAR a LLM ✓
      // - content → ENVIAR a LLM ✓
      // - _meta → NUNCA enviar (metadata del cliente)
      // - uiResources → NUNCA enviar (solo para widgets)
      if (isToolWithOutput && part.output?.uiResources) {
        const cleanOutput: Record<string, unknown> = {};

        if (output.structuredContent) {
          cleanOutput.structuredContent = output.structuredContent;
        }
        if (Array.isArray(output.content)) {
          const textItems = output.content
            .filter((item: any) => item?.type === 'text' && item?.text)
            .map((item: any) => item.text);
          if (textItems.length > 0) {
            cleanOutput.text = textItems.join('\n');
          }
        }

        return {
          ...part,
          output: cleanOutput.structuredContent || cleanOutput.text || '[Widget rendered]',
        };
      }

      return part;
    });
  });
}
```

---

## Conclusiones

El sistema de ejecución de herramientas MCP en Levante es robusto y bien estructurado:

1. **Modularidad**: Clara separación entre descubrimiento, ejecución y streaming
2. **Flexibilidad**: Soporte para múltiples SDKs (mcp-use y official-sdk)
3. **Extensibilidad**: Sistema de widgets con múltiples protocolos
4. **Resiliencia**: Manejo de errores con retry automático
5. **Monitoreo**: Health tracking para cada herramienta

### Áreas de Mejora Identificadas

- **Sistema de Aprobación**: No existe un sistema de aprobación explícita antes de ejecutar herramientas. El usuario solo puede habilitar/deshabilitar servidores MCP completos.
- **Granularidad de Permisos**: No hay control a nivel de herramienta individual.
- **Confirmación de Ejecución**: Las herramientas se ejecutan automáticamente cuando el modelo las solicita.
