# Plan de Implementación: Sistema de Aprobación de Herramientas MCP

## Tabla de Contenidos

1. [Resumen](#resumen)
2. [Flujo del AI SDK](#flujo-del-ai-sdk)
3. [Archivos a Modificar](#archivos-a-modificar)
4. [Paso 1: Backend - Agregar needsApproval a las Tools](#paso-1-backend---agregar-needsapproval-a-las-tools)
5. [Paso 2: Frontend - Componente de Aprobación](#paso-2-frontend---componente-de-aprobación)
6. [Paso 3: Frontend - Integrar en ChatMessageItem](#paso-3-frontend---integrar-en-chatmessageitem)
7. [Flujo Completo](#flujo-completo)
8. [Consideraciones](#consideraciones)

---

## Resumen

Este plan implementa el sistema de aprobación de herramientas usando el **flujo nativo del AI SDK**.

**Versión simplificada: TODAS las herramientas MCP requieren aprobación del usuario.**

### Lo que hace el AI SDK automáticamente:
- Detecta `needsApproval: true` en la herramienta
- Cambia el estado del part a `approval-requested`
- Proporciona `addToolApprovalResponse()` en el hook `useChat`
- Maneja la segunda llamada al LLM automáticamente

### Lo que nosotros debemos hacer:
1. **Backend**: Agregar `needsApproval: true` a las herramientas MCP
2. **Frontend**: Renderizar UI cuando `part.state === 'approval-requested'`
3. **Frontend**: Llamar a `addToolApprovalResponse()` cuando el usuario decide
4. **Frontend**: Configurar `sendAutomaticallyWhen` para que el SDK envíe automáticamente después de la aprobación

---

## Flujo del AI SDK

```
┌─────────────────────────────────────────────────────────────────┐
│                    PRIMERA LLAMADA AL LLM                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Usuario: "¿Qué tiempo hace en Madrid?"                         │
│                         │                                       │
│                         ▼                                       │
│  LLM decide: "Usar herramienta get_weather"                     │
│                         │                                       │
│                         ▼                                       │
│  AI SDK ve: needsApproval = true                                │
│                         │                                       │
│                         ▼                                       │
│  AI SDK retorna part con state: "approval-requested"            │
│                                                                 │
│  ─────────── FIN DE LA PRIMERA LLAMADA ───────────              │
└─────────────────────────────────────────────────────────────────┘

                    ⏳ Usuario ve UI de aprobación...

┌─────────────────────────────────────────────────────────────────┐
│              USUARIO APRUEBA/DENIEGA                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  addToolApprovalResponse({ id, approved: true/false })          │
│                         │                                       │
│                         ▼                                       │
│  sendAutomaticallyWhen detecta approval response pendiente      │
│                         │                                       │
│                         ▼                                       │
│  useChat envía AUTOMÁTICAMENTE los mensajes (SEGUNDA LLAMADA)   │
│                         │                                       │
│                         ▼                                       │
│  Si approved: ejecuta herramienta → LLM genera respuesta        │
│  Si denied: LLM recibe denegación → genera respuesta alternativa│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

⚠️  IMPORTANTE: Sin sendAutomaticallyWhen, la aprobación se queda
    en memoria pero NUNCA se envía al servidor. El flujo se detiene.
```

---

## Archivos a Modificar

| Archivo | Modificación |
|---------|--------------|
| `src/main/services/ai/mcpToolsAdapter.ts` | Agregar `needsApproval: true` a todas las tools |
| `src/renderer/components/ai-elements/tool-approval.tsx` | **Nuevo**: Componente UI de aprobación |
| `src/renderer/components/chat/ChatMessageItem.tsx` | Renderizar aprobación cuando `state === 'approval-requested'` |
| `src/renderer/pages/ChatPage.tsx` | Configurar `sendAutomaticallyWhen` (CRÍTICO) |

> **Nota**: 4 archivos (1 nuevo + 3 modificados). El AI SDK maneja todo lo demás automáticamente.

---

## Paso 1: Backend - Agregar needsApproval a las Tools

### Modificar `src/main/services/ai/mcpToolsAdapter.ts`

Buscar la función `createAISDKTool` y agregar `needsApproval: true`:

```typescript
/**
 * Convert an MCP tool to AI SDK format with approval support
 */
function createAISDKTool(serverId: string, mcpTool: Tool) {
  // ... código existente de validación y schema ...

  const aiTool = tool({
    description: mcpTool.description || `Tool from MCP server ${serverId}`,
    inputSchema: inputSchema,

    // ═══════════════════════════════════════════════════════
    // NUEVO: Todas las herramientas requieren aprobación
    // ═══════════════════════════════════════════════════════
    needsApproval: true,

    execute: async (args: any) => {
      // ... código existente de execute SIN CAMBIOS ...
    },
  });

  return aiTool;
}
```

**Eso es todo en el backend.** El AI SDK hace el resto.

---

## Paso 2: Frontend - Componente de Aprobación

### Crear `src/renderer/components/ai-elements/tool-approval.tsx`

```typescript
/**
 * ToolApprovalInline - UI para aprobar/denegar ejecución de herramientas
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ShieldCheck,
  Wrench,
  X,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { CodeBlock } from './code-block';

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

interface ToolApprovalInlineProps {
  /** Nombre de la herramienta (formato: serverId_toolName) */
  toolName: string;
  /** Argumentos que se van a pasar a la herramienta */
  input: Record<string, unknown>;
  /** ID de aprobación del AI SDK */
  approvalId: string;
  /** Callback cuando el usuario aprueba */
  onApprove: () => void;
  /** Callback cuando el usuario deniega */
  onDeny: () => void;
  /** Clases CSS adicionales */
  className?: string;
}

// ═══════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════

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
  // Formato: serverId_toolName → toolName
  const displayToolName = toolName.includes('_')
    ? toolName.split('_').slice(1).join('_')
    : toolName;

  // Extraer serverId
  const serverId = toolName.includes('_')
    ? toolName.split('_')[0]
    : 'unknown';

  return (
    <div
      className={cn(
        'rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-4 space-y-3',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-yellow-500" />
        <span className="font-medium">Tool Approval Required</span>
      </div>

      {/* Tool Info */}
      <div className="flex items-center gap-2 text-sm">
        <Wrench className="w-4 h-4 text-muted-foreground" />
        <span className="font-mono font-medium">{displayToolName}</span>
        <Badge variant="outline" className="text-xs">
          {serverId}
        </Badge>
      </div>

      {/* Toggle Parameters */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showDetails ? (
          <>
            <ChevronUp className="w-3 h-3" />
            Hide parameters
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" />
            Show parameters
          </>
        )}
      </button>

      {/* Parameters */}
      {showDetails && (
        <div className="rounded-md border overflow-hidden">
          <CodeBlock
            code={JSON.stringify(input, null, 2)}
            language="json"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onDeny}
          className="gap-1"
        >
          <X className="w-3 h-3" />
          Deny
        </Button>
        <Button
          size="sm"
          onClick={onApprove}
          className="gap-1"
        >
          <Check className="w-3 h-3" />
          Approve
        </Button>
      </div>
    </div>
  );
}
```

---

## Paso 3: Frontend - Integrar en ChatMessageItem

### Modificar `src/renderer/components/chat/ChatMessageItem.tsx`

El componente debe detectar cuando un part de herramienta tiene `state === 'approval-requested'` y mostrar la UI de aprobación.

#### 3.1 Agregar import

```typescript
// Agregar al inicio del archivo
import { ToolApprovalInline } from '@/components/ai-elements/tool-approval';
```

#### 3.2 Recibir `addToolApprovalResponse` como prop

El componente `ChatMessageItem` debe recibir la función del hook `useChat`:

```typescript
interface ChatMessageItemProps {
  message: UIMessage;
  isStreaming?: boolean;
  // ... otras props existentes ...

  // NUEVO: Función del AI SDK para responder a aprobaciones
  addToolApprovalResponse?: (response: { id: string; approved: boolean }) => void;
}
```

#### 3.3 Renderizar aprobación cuando corresponda

Buscar donde se renderizan los parts de herramientas y agregar el caso de aprobación:

```typescript
// Dentro del map de parts del mensaje
{message.parts.map((part, index) => {
  // Detectar si es un part de herramienta (empieza con "tool-")
  if (part.type.startsWith('tool-')) {
    const toolPart = part as any; // ToolUIPart

    // NUEVO: Si está esperando aprobación, mostrar UI de aprobación
    if (toolPart.state === 'approval-requested' && addToolApprovalResponse) {
      return (
        <ToolApprovalInline
          key={`${part.type}-${index}`}
          toolName={toolPart.toolName}
          input={toolPart.input}
          approvalId={toolPart.approval.id}
          onApprove={() => addToolApprovalResponse({
            id: toolPart.approval.id,
            approved: true,
          })}
          onDeny={() => addToolApprovalResponse({
            id: toolPart.approval.id,
            approved: false,
          })}
        />
      );
    }

    // Casos existentes: input-streaming, output-available, etc.
    // ... código existente ...
  }

  // ... otros tipos de parts ...
})}
```

#### 3.4 Configurar ChatPage con `sendAutomaticallyWhen`

En `ChatPage.tsx`, hay que hacer dos cosas:
1. Configurar `sendAutomaticallyWhen` para que el SDK envíe automáticamente después de aprobar
2. Pasar `addToolApprovalResponse` al componente

```typescript
// En ChatPage.tsx

// ═══════════════════════════════════════════════════════
// NUEVO: Importar la función helper del AI SDK
// ═══════════════════════════════════════════════════════
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';

const {
  messages,
  sendMessage,
  status,
  stop,
  error,
  addToolApprovalResponse,  // ← NUEVO: extraer del hook useChat
} = useChat({
  // ... config existente ...

  // ═══════════════════════════════════════════════════════
  // CRÍTICO: Sin esto, la aprobación no se envía al servidor
  // ═══════════════════════════════════════════════════════
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});

// Pasar al componente
<ChatMessageItem
  message={message}
  isStreaming={status === 'streaming' && index === messages.length - 1}
  addToolApprovalResponse={addToolApprovalResponse}  // ← NUEVO
  // ... otras props ...
/>
```

#### ¿Qué hace `sendAutomaticallyWhen`?

Esta configuración le dice al hook `useChat` cuándo enviar mensajes automáticamente:

```
Sin sendAutomaticallyWhen:
  1. Usuario aprueba → addToolApprovalResponse()
  2. Respuesta se agrega a mensajes en memoria
  3. ❌ NADA MÁS PASA - el servidor nunca recibe la aprobación

Con sendAutomaticallyWhen:
  1. Usuario aprueba → addToolApprovalResponse()
  2. Respuesta se agrega a mensajes en memoria
  3. ✅ useChat detecta: "hay approval response pendiente"
  4. ✅ useChat AUTOMÁTICAMENTE envía al servidor
  5. ✅ Servidor ejecuta herramienta y responde
```

La función `lastAssistantMessageIsCompleteWithApprovalResponses` verifica:
- ¿El último mensaje del asistente está completo (no streaming)?
- ¿Hay respuestas de aprobación pendientes?

Si ambas son `true`, dispara automáticamente el envío.

---

## Flujo Completo

```
┌─────────────────────────────────────────────────────────────────┐
│                         FLUJO COMPLETO                          │
│              (Usando flujo nativo del AI SDK)                   │
└─────────────────────────────────────────────────────────────────┘

1. Usuario escribe: "¿Qué tiempo hace en Madrid?"
   │
   ▼
2. ChatPage llama a sendMessage()
   │
   ▼
3. useChat → Transport → IPC → AIService → streamText()
   │
   ▼
4. LLM decide usar herramienta "weather_get_weather"
   │
   ▼
5. AI SDK ve needsApproval: true
   │
   ▼
6. AI SDK retorna mensaje con part:
   {
     type: "tool-weather_get_weather",
     state: "approval-requested",      ← Estado especial
     toolName: "weather_get_weather",
     input: { city: "Madrid" },
     approval: { id: "abc123" }        ← ID para responder
   }
   │
   ▼
7. ChatMessageItem detecta state === "approval-requested"
   │
   ▼
8. Renderiza ToolApprovalInline:
   ┌──────────────────────────────────────────┐
   │ 🛡️ Tool Approval Required                │
   │ 🔧 get_weather  [weather]                │
   │ ▼ Show parameters                        │
   │ [Deny]  [Approve]                        │
   └──────────────────────────────────────────┘
   │
   ▼
9. Usuario hace click en "Approve"
   │
   ▼
10. Se llama: addToolApprovalResponse({ id: "abc123", approved: true })
    │
    ▼
11. sendAutomaticallyWhen detecta approval response pendiente
    │
    ▼
12. useChat AUTOMÁTICAMENTE envía al servidor (SEGUNDA LLAMADA)
    │
    ▼
13. AI SDK:
    - Ejecuta la herramienta
    - Retorna resultado al LLM
    - LLM genera respuesta final
    │
    ▼
14. part.state cambia a "output-available"
    │
    ▼
15. ChatMessageItem renderiza el resultado normalmente
```

---

## Consideraciones

### Simplicidad
- **Solo 3 archivos** a modificar/crear
- El AI SDK maneja toda la lógica de estado y comunicación
- No necesitamos stores custom ni IPC handlers adicionales

### Estados de las herramientas

| Estado | Qué mostrar |
|--------|-------------|
| `input-streaming` | Spinner, "Preparando..." |
| `input-available` | Spinner, "Ejecutando..." |
| `approval-requested` | **UI de aprobación** |
| `approval-responded` | Spinner, "Procesando..." |
| `output-available` | Resultado de la herramienta |
| `output-error` | Mensaje de error |

### Dos llamadas al LLM
- **Primera**: El modelo decide qué herramienta usar
- **Segunda**: Se ejecuta la herramienta y el modelo genera la respuesta
- El AI SDK maneja esto automáticamente con `addToolApprovalResponse` + `sendAutomaticallyWhen`

### `sendAutomaticallyWhen` - CRÍTICO

⚠️ **Sin esta configuración, el sistema de aprobación NO funciona.**

```typescript
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';

useChat({
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});
```

**¿Por qué es necesario?**
- `addToolApprovalResponse()` solo agrega la respuesta a los mensajes en memoria
- NO envía nada al servidor automáticamente
- `sendAutomaticallyWhen` detecta cuando hay approval responses pendientes y dispara el envío

**Analogía**: Es como escribir un mensaje pero no presionar ENTER. Sin `sendAutomaticallyWhen`, el mensaje nunca se envía.

### Seguridad
- **TODAS** las herramientas MCP requieren aprobación
- El usuario siempre ve qué se va a ejecutar y con qué parámetros
- La herramienta NO se ejecuta hasta que el usuario aprueba

---

## Resumen de Cambios

### Archivo Nuevo (1)

| Archivo | Descripción |
|---------|-------------|
| `src/renderer/components/ai-elements/tool-approval.tsx` | Componente UI de aprobación |

### Archivos a Modificar (3)

| Archivo | Cambio |
|---------|--------|
| `src/main/services/ai/mcpToolsAdapter.ts` | Agregar `needsApproval: true` |
| `src/renderer/components/chat/ChatMessageItem.tsx` | Renderizar aprobación + recibir `addToolApprovalResponse` |
| `src/renderer/pages/ChatPage.tsx` | Configurar `sendAutomaticallyWhen` + extraer y pasar `addToolApprovalResponse` |

**Total: 1 archivo nuevo + 3 archivos modificados = 4 cambios**

### Imports Nuevos Necesarios

```typescript
// En ChatPage.tsx
import { lastAssistantMessageIsCompleteWithApprovalResponses } from 'ai';
```
