# Diagnóstico y corrección: error Anthropic `tool_use` sin `tool_result` inmediato

## 1) Error observado

Error exacto recibido:

```text
messages.1: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_...
Each `tool_use` block must have a corresponding `tool_result` block in the next message.
```

## 2) Qué estaba fallando realmente

### Regla que impone Anthropic

Cuando en un mensaje `assistant` hay un `tool_use`, el **siguiente mensaje** debe contener el `tool_result` correspondiente (sin romper el orden lógico por pasos).

### Flujo real que estaba ocurriendo

Con los logs crudos se vio que el historial acababa mezclando en el mismo mensaje `assistant`:

- `tool_use`
- y texto final de respuesta (resultado ya explicado al usuario)

Luego venía el `tool_result` y después el siguiente turno del usuario.

Esa composición es la que detonaba el 400 de Anthropic.

## 3) Causa raíz técnica

El problema no era el tool en sí, sino los **límites de paso** (`start-step` / `finish-step`) del stream:

1. `streamText(...).fullStream` emite `start-step` y `finish-step`.
2. En `src/main/services/aiService.ts` esos eventos no se estaban reenviando al renderer.
3. En el renderer (`useChat`), sin esos límites, el mensaje `assistant` quedaba como un único bloque continuo.
4. Al reconstruir mensajes para el siguiente turno, el `assistant` quedaba con `tool_use` + texto final en el mismo mensaje.
5. Anthropic lo rechazaba como secuencia inválida para tools.

En resumen: **faltaba preservar boundaries de step entre backend y frontend**.

## 4) Archivos modificados y código exacto

## A. `src/main/services/aiService.ts`

### A.1 Añadidos flags de step al chunk IPC

```ts
export interface ChatStreamChunk {
  delta?: string;
  done?: boolean;
  error?: string;
  stepStart?: boolean;
  stepFinish?: boolean;
  // ...
}
```

### A.2 Reenvío explícito de `start-step` / `finish-step`

```ts
switch (chunk.type) {
  case "start-step":
    this.logger.aiSdk.info("[APPROVAL-TRACE] Forwarding start-step to renderer", {
      streamTraceId,
    });
    yield { stepStart: true };
    break;

  case "finish-step":
    this.logger.aiSdk.info("[APPROVAL-TRACE] Forwarding finish-step to renderer", {
      streamTraceId,
    });
    yield { stepFinish: true };
    break;

  // ...
}
```

## B. `src/preload/types/index.ts`

Se sincronizó el contrato de tipos IPC:

```ts
export interface ChatStreamChunk {
  delta?: string;
  done?: boolean;
  error?: string;
  stepStart?: boolean;
  stepFinish?: boolean;
  // ...
}
```

## C. `src/renderer/transports/ElectronChatTransport.ts`

Se mapearon los flags IPC a chunks nativos del AI SDK (`start-step` / `finish-step`) y se cerró/reabrió texto por step para mantener consistencia interna:

```ts
if (chunk.stepStart) {
  if (this.hasStartedTextPart) {
    yield {
      type: "text-end",
      id: this.currentTextPartId,
    };
    this.hasStartedTextPart = false;
  }

  this.currentTextPartId = `text-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  yield { type: "start-step" };
}

if (chunk.stepFinish) {
  if (this.hasStartedTextPart) {
    yield {
      type: "text-end",
      id: this.currentTextPartId,
    };
    this.hasStartedTextPart = false;
  }
  yield { type: "finish-step" };
}
```

## 5) Por qué esta solución arregla el error

Con `start-step`/`finish-step` propagados:

1. `useChat` separa correctamente los pasos del mensaje `assistant`.
2. El paso del `tool_use` queda aislado del paso del texto final.
3. En el siguiente request, la serialización hacia Anthropic mantiene el orden esperado:
   - `assistant` con `tool_use`
   - `user` con `tool_result`
   - `assistant` con texto final
4. Ya no aparece el 400 de `tool_use` sin `tool_result` inmediato.

## 6) Validación ejecutada

Se ejecutó:

```bash
pnpm -s typecheck
```

Resultado: OK.

## 7) Qué debes mirar en logs para confirmar en runtime

1. Presencia de:
   - `[APPROVAL-TRACE] Forwarding start-step to renderer`
   - `[APPROVAL-TRACE] Forwarding finish-step to renderer`
2. En `Provider raw request body (stream)`:
   - El `assistant` con `tool_use` debe ir separado del `assistant` con respuesta final.
   - El `tool_result` debe ir inmediatamente después del `tool_use`.
3. El error `messages.1: tool_use ids were found without tool_result...` no debe volver a aparecer.

---

Si reaparece, captura de nuevo el bloque completo de:

- `LLM raw v3 prompt before provider call`
- `Provider raw request body (stream)`

y compara si se volvió a perder algún `start-step` en tránsito.
