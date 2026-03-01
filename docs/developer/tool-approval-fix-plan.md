# Runbook de corrección: tools aprobadas antes de `convertToModelMessages`

> Última actualización: 2026-02-24
> Alcance: `src/main/services/aiService.ts`
> Objetivo: eliminar errores 400 de Anthropic y evitar round-trips extra al reanudar tools aprobadas.

---

## 1) Problema que corrige este runbook

En el segundo stream (el que dispara `sendAutomaticallyWhen` tras aprobar tools), los parts llegan con:

- `state: "approval-responded"`
- `approval.approved: true`
- sin `output`

`convertToModelMessages(...)` recibe ese estado intermedio y no genera `tool_result` para esos calls, dejando secuencias inválidas para Anthropic.

Resultado actual:

- Anthropic: `400` por `tool_use` sin `tool_result` inmediato.
- OpenRouter (Claude): a veces tolera, pero hace ciclos extra innecesarios.

---

## 2) Causa raíz confirmada (sin suposiciones)

### En código local

- `sanitizeMessagesForModel` solo convierte `approval-responded` cuando `approved === false`.
- Para `approved === true`, hoy no convierte y solo loguea warning.

Archivo:
- `src/main/services/aiService.ts`

### En AI SDK v6 (fuente real en `node_modules/ai/src`)

`convert-to-model-messages.ts` confirma:

1. Un part en `approval-responded` no produce `tool-result`.
2. `tool-result` sí se genera para estados:
   - `output-available`
   - `output-error`
3. `tool-output-error` en stream se materializa como `state: 'output-error'`.
4. `tool-output-available` se materializa como `state: 'output-available'`.

Conclusión: para reanudar correctamente, los parts aprobados deben convertirse a `output-available` (éxito) o `output-error` (fallo) **antes** de `convertToModelMessages`.

---

## 3) Decisiones técnicas obligatorias

1. Ejecutar tools aprobadas en main process antes de `streamText`.
2. No serializar outputs a string si la ejecución fue exitosa.
   - Mantener `output` con su tipo original (`object`, `string`, etc.).
   - Esto preserva widgets (`uiResources`) y render de diffs.
3. Si ejecución falla (incluyendo tool no encontrada), convertir a `output-error`.
4. Emitir chunks al renderer inmediatamente:
   - éxito -> `toolResult.status = "success"`
   - error -> `toolResult.status = "error"`
5. Mantener `sanitizeMessagesForModel` para sanitización normal y caso denied existente.

---

## 4) Cambios exactos a aplicar

## 4.1 Archivo único a modificar

- `src/main/services/aiService.ts`

No modificar transport, renderer ni tipos preload para este fix.

---

## 4.2 Añadir helpers + `preExecuteApprovedTools`

Insertar antes de la clase `AIService` (después de `sanitizeMessagesForModel` es un buen punto).

```typescript
type PreExecutedTool = {
  toolCallId: string;
  toolName: string;
  status: "success" | "error";
  result?: unknown;
  errorText?: string;
};

function isToolLikePart(part: any): boolean {
  if (!part || typeof part !== "object") return false;
  if (part.type === "dynamic-tool") return true;
  return typeof part.type === "string" && part.type.startsWith("tool-");
}

function resolveToolNameFromPart(part: any): string | undefined {
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    return part.toolName;
  }

  if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
    return part.toolName;
  }

  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice(5);
  }

  return undefined;
}

/**
 * Ejecuta tools aprobadas (approval-responded + approved=true) antes de convertToModelMessages.
 *
 * Objetivo:
 * - Evitar que convertToModelMessages reciba parts en approval-responded aprobados sin output
 * - Producir estados finales válidos para modelo: output-available u output-error
 */
async function preExecuteApprovedTools(
  messages: UIMessage[],
  tools: Record<string, any>
): Promise<{
  updatedMessages: UIMessage[];
  executedTools: PreExecutedTool[];
}> {
  const logger = getLogger();
  const cloned = JSON.parse(JSON.stringify(messages)) as any[];
  const executedTools: PreExecutedTool[] = [];

  for (const message of cloned) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) continue;

    for (const part of message.parts) {
      if (!isToolLikePart(part)) continue;

      const isApprovedResponse =
        part.state === "approval-responded" && part.approval?.approved === true;
      if (!isApprovedResponse) continue;

      const toolCallId = part.toolCallId;
      const toolName = resolveToolNameFromPart(part);

      if (!toolCallId || !toolName) {
        const errorText = "Cannot resume approved tool: missing toolCallId or toolName.";

        part.state = "output-error";
        part.errorText = errorText;
        delete part.output;

        if (toolCallId) {
          executedTools.push({
            toolCallId,
            toolName: toolName ?? "unknown-tool",
            status: "error",
            errorText,
          });
        }

        logger.aiSdk.error("[PRE-EXEC] Missing toolCallId/toolName", {
          toolCallId,
          toolName,
          partType: part.type,
        });

        continue;
      }

      const tool = tools[toolName];
      if (!tool || typeof tool.execute !== "function") {
        const errorText = `Tool \"${toolName}\" not found or has no execute function.`;

        part.state = "output-error";
        part.errorText = errorText;
        delete part.output;

        executedTools.push({
          toolCallId,
          toolName,
          status: "error",
          errorText,
        });

        logger.aiSdk.error("[PRE-EXEC] Tool missing in registry", {
          toolName,
          toolCallId,
          availableTools: Object.keys(tools),
        });

        continue;
      }

      const input = part.input ?? {};

      logger.aiSdk.info("[PRE-EXEC] Executing approved tool before stream", {
        toolName,
        toolCallId,
      });

      try {
        // Mantener output con su tipo original. NO stringify aquí.
        const result = await tool.execute(input, { toolCallId });

        part.state = "output-available";
        part.output = result;
        delete part.errorText;

        executedTools.push({
          toolCallId,
          toolName,
          status: "success",
          result,
        });

        logger.aiSdk.info("[PRE-EXEC] Tool executed successfully", {
          toolName,
          toolCallId,
          resultType: typeof result,
        });
      } catch (error) {
        const errorText =
          error instanceof Error ? error.message : "Unknown tool execution error";

        part.state = "output-error";
        part.errorText = errorText;
        delete part.output;

        executedTools.push({
          toolCallId,
          toolName,
          status: "error",
          errorText,
        });

        logger.aiSdk.error("[PRE-EXEC] Tool execution failed", {
          toolName,
          toolCallId,
          error: errorText,
        });
      }
    }
  }

  return {
    updatedMessages: cloned as UIMessage[],
    executedTools,
  };
}
```

---

## 4.3 Integrar en `streamChat`

Ubicar el bloque donde hoy se hace:

```typescript
const sanitizedMessages = sanitizeMessagesForModel(messagesWithFileParts);
...
messages: await convertToModelMessages(sanitizedMessages),
```

Reemplazar por este flujo:

```typescript
const { updatedMessages, executedTools } = await preExecuteApprovedTools(
  messagesWithFileParts,
  tools
);

// Emitir primero resultados pre-ejecutados para actualizar renderer
for (const executed of executedTools) {
  if (executed.status === "success") {
    yield {
      toolResult: {
        id: executed.toolCallId,
        result: executed.result,
        status: "success" as const,
        timestamp: Date.now(),
      },
    };
  } else {
    yield {
      toolResult: {
        id: executed.toolCallId,
        result: executed.errorText ?? "Tool execution failed",
        status: "error" as const,
        timestamp: Date.now(),
      },
    };
  }
}

const sanitizedMessages = sanitizeMessagesForModel(updatedMessages);

// (opcional temporal) logs de diagnóstico
sanitizedMessages.forEach((msg: any) => {
  if (msg.role === "assistant") {
    const toolParts = (msg.parts || []).filter((p: any) =>
      p?.type?.startsWith("tool-") || p?.type === "dynamic-tool"
    );

    if (toolParts.length > 0) {
      this.logger.aiSdk.info(
        "[APPROVAL-DEBUG] Assistant message tool parts before convertToModelMessages",
        {
          messageId: msg.id,
          toolParts: toolParts.map((p: any) => ({
            type: p.type,
            state: p.state,
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            hasOutput: p.output !== undefined,
            hasErrorText: typeof p.errorText === "string",
            approvalApproved: p.approval?.approved,
          })),
        }
      );
    }
  }
});

const result = streamText({
  model: modelProvider,
  messages: await convertToModelMessages(sanitizedMessages),
  ...
});
```

---

## 5) Comportamiento esperado tras aplicar

Flujo final en reanudación por aprobación:

1. `approval-responded + approved=true` entra en `streamChat`.
2. `preExecuteApprovedTools` ejecuta tool en main process.
3. Part queda en:
   - `output-available` (si éxito), o
   - `output-error` (si fallo).
4. Se emite chunk inmediato al renderer (`tool-output-available` / `tool-output-error` vía transport).
5. `convertToModelMessages` recibe estado final válido y genera `tool_result`.
6. Anthropic deja de devolver 400 por `tool_use` huérfano.

---

## 6) Invariantes que NO se deben romper

1. No hacer `JSON.stringify` del output exitoso en pre-exec.
2. No emitir `status: "success"` cuando hubo excepción o tool faltante.
3. No dejar parts aprobados en `approval-responded` antes de `convertToModelMessages`.
4. Mantener soporte a tools estáticas (`tool-...`) y `dynamic-tool`.

---

## 7) Casos de borde y manejo explícito

### A) Tool no existe en registry

Acción obligatoria:

- convertir part a `output-error`
- `errorText = "Tool \"...\" not found or has no execute function."`
- emitir chunk de error

Racional: evita volver a romper Anthropic por `approval-responded` sin resultado.

### B) `tool.execute()` lanza excepción

Acción obligatoria:

- convertir a `output-error`
- conservar `input`
- emitir chunk error

### C) Tool denegada (`approved=false`)

No cambia en este runbook. Sigue el manejo existente en `sanitizeMessagesForModel`.

---

## 8) Checklist de validación (obligatorio)

## 8.1 Type safety / compilación

Ejecutar:

```bash
pnpm run typecheck
```

Debe terminar sin errores.

## 8.2 Prueba manual mínima (Anthropic)

Escenario:

1. Prompt que dispare 2 tools con aprobación.
2. Aprobar ambas.
3. Verificar que el stream reanudado no falle con 400.

Logs esperados:

- aparece `[PRE-EXEC] Executing approved tool before stream`
- aparece `[PRE-EXEC] Tool executed successfully` (o failed con output-error controlado)
- justo antes de `convertToModelMessages`, no debe quedar ningún part aprobado en `approval-responded`

## 8.3 Prueba manual de error

Forzar fallo de tool (por ejemplo desconexión MCP o comando inválido):

- part debe terminar en `output-error`
- UI debe reflejar error
- no debe aparecer 400 de Anthropic por `tool_use` huérfano

## 8.4 OpenRouter (Claude)

- la reanudación debe requerir menos round-trips
- no deben quedar tools aprobadas atascadas en `approval-responded`

---

## 9) Plan de rollback

Si algo sale mal:

1. Revertir únicamente cambios en `src/main/services/aiService.ts`.
2. Confirmar vuelta al comportamiento anterior.
3. Mantener logs de diagnóstico para nuevo intento.

---

## 10) Definición de Done

Se considera completado cuando:

1. `pnpm run typecheck` pasa.
2. Flujo de aprobación en Anthropic completa sin error 400.
3. En pre-conversión no existen parts aprobados en `approval-responded`.
4. Outputs exitosos preservan tipo original (objetos no serializados).
5. Fallos de pre-ejecución se representan como `output-error` + chunk error.

---

## 11) Resumen ejecutivo para el agente que aplicará el plan

Implementa pre-ejecución de tools aprobadas en `streamChat` antes de `sanitizeMessagesForModel`/`convertToModelMessages`, actualiza estados a `output-available` o `output-error`, emite chunks correspondientes al renderer, y no conviertas outputs exitosos a string.
