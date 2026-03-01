# MCP Apps Widget Protocol — Arquitectura, Bugs y Fixes

## Índice

1. [Contexto: ¿Qué es MCP Apps?](#1-contexto-qué-es-mcp-apps)
2. [Arquitectura de Widgets en Levante](#2-arquitectura-de-widgets-en-levante)
3. [Flujo de Protocolo SEP-1865](#3-flujo-de-protocolo-sep-1865)
4. [Los Tres Bugs Originales](#4-los-tres-bugs-originales)
5. [Diagnóstico con Logs de MCPJam](#5-diagnóstico-con-logs-de-mcpjam)
6. [Fixes Implementados](#6-fixes-implementados)
7. [Referencia de Archivos Clave](#7-referencia-de-archivos-clave)

---

## 1. Contexto: ¿Qué es MCP Apps?

**MCP Apps** (definido en [SEP-1865](https://github.com/anthropics/mcp/blob/main/proposals/sep-1865.md)) es una extensión del protocolo MCP que permite a los servidores MCP devolver **widgets UI interactivos** como resultado de las llamadas a herramientas. En lugar de texto plano, el servidor devuelve HTML que el host embebe en el chat.

### Casos de uso típicos

| Servidor MCP | Widget | Descripción |
|---|---|---|
| Excalidraw | Diagrama interactivo | El AI dibuja diagramas que el usuario puede editar |
| Mapas | Mapa interactivo | Visualización geoespacial |
| Calendarios | Selector de fecha | UI para interactuar con la agenda |

### Diferencia con MCP-UI clásico

| Protocolo | Transporte | Inicialización | Datos al widget |
|---|---|---|---|
| **MCP-UI** (`@mcp-ui/client`) | Recurso embebido `ui://` | Sin handshake | `window.__IFRAME_RENDER_DATA__` |
| **MCP Apps (SEP-1865)** | `ui/resourceUri` en `_meta` de la herramienta | JSON-RPC 2.0 handshake `ui/initialize` | `ui/notifications/tool-input` vía postMessage |
| **OpenAI Apps SDK** | `openai/outputTemplate` en `_meta` | Mensajes `openai:*` | `window.openai.toolInput` estático |

---

## 2. Arquitectura de Widgets en Levante

### Capas del sistema

```
┌─────────────────────────────────────────────────────────────────┐
│  Renderer (React)                                               │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  ChatMessageItem.tsx                                        │ │
│  │   └─ UIResourceMessage.tsx   ← Orquestador de widgets      │ │
│  │       ├─ Gestión de displayMode (inline/pip/fullscreen)     │ │
│  │       ├─ Handler JSON-RPC para MCP Apps                     │ │
│  │       └─ <iframe src={widgetProxyUrl}>                      │ │
│  │             ↕ postMessage (proxy relay)                     │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         ↕ IPC levante/widget/store
┌─────────────────────────────────────────────────────────────────┐
│  Main Process (Node.js)                                         │
│  ├─ widgetProxy.ts       HTTP proxy local (127.0.0.1:puerto)   │
│  │   └─ generateProxyHtml()   Página relay con iframe anidado  │
│  ├─ mcpAppsBridge.ts    Inyecta window.mcpApp en el widget     │
│  └─ mcpToolsAdapter.ts  Detecta protocolo, fetcha HTML         │
└─────────────────────────────────────────────────────────────────┘
         ↕ HTTP 127.0.0.1:{port}/proxy/{widgetId}
┌─────────────────────────────────────────────────────────────────┐
│  Proxy HTML (origen http://127.0.0.1)                           │
│  └─ <iframe src="blob:...">    Widget HTML del servidor MCP    │
│       ↕ postMessage relay                                       │
│       ├─ window.mcpApp (bridge script inyectado)               │
│       └─ MCP Apps SDK (esm.sh)  ← SDK oficial del widget       │
└─────────────────────────────────────────────────────────────────┘
```

### Por qué se usa un proxy HTTP local

Los widgets MCP Apps usan el SDK oficial desde `esm.sh` que requiere un **origen real** (no `blob:` ni `srcdoc`). El proxy HTTP asigna `http://127.0.0.1:{puerto}` al widget, permitiendo:

- Carga de módulos ES desde `esm.sh`
- Comunicación postMessage con origen definido
- Sandbox de seguridad con CSP propios por widget

### Detección de protocolo

`mcpToolsAdapter.ts` → `detectWidgetProtocol()` sigue esta prioridad:

```
1. MCP Apps (SEP-1865):  herramienta tiene _meta["ui/resourceUri"]
2. OpenAI Apps SDK:      herramienta tiene _meta["openai/outputTemplate"]
3. MCP-UI clásico:       resultado tiene recurso embebido uri:// en content[]
```

---

## 3. Flujo de Protocolo SEP-1865

El flujo correcto (según la spec y validado contra MCPJam Inspector) es:

```
Widget                    Levante (Host)              Servidor MCP
  │                           │                            │
  │  ── ui/initialize ──────► │                            │
  │     { appInfo, proto }    │                            │
  │                           │                            │
  │  ◄─ response ──────────── │                            │
  │     { protocolVersion,    │                            │
  │       hostCapabilities:   │                            │
  │         { openLinks:{},   │                            │
  │           serverTools:{}, │                            │
  │           sandbox:{csp} } │                            │
  │       hostContext:        │                            │
  │         { theme, locale,  │                            │
  │           toolInfo: {     │                            │
  │             id, tool } }  │                            │
  │       hostInfo }          │                            │
  │                           │                            │
  │  ── ui/notifications/ ──► │                            │
  │       initialized         │                            │
  │                           │                            │
  │  ◄─ ui/notifications/ ─── │                            │
  │       tool-input          │ { arguments: {elements:…} }│
  │                           │                            │
  │  ◄─ ui/notifications/ ─── │                            │
  │       tool-result         │ { structuredContent:{…} }  │
  │                           │                            │
  │  [Widget renderiza]       │                            │
  │                           │                            │
  │  ── tools/call ─────────► │                            │
  │     { save_checkpoint }   │ ── tools/call ───────────► │
  │                           │ ◄─ result ──────────────── │
  │  ◄─ response ──────────── │                            │
```

### Mensajes críticos

| Dirección | Método | Propósito |
|---|---|---|
| Widget → Host | `ui/initialize` | Handshake inicial; el widget presenta sus capacidades |
| Host → Widget | *(response)* | El host presenta sus capacidades y contexto |
| Widget → Host | `ui/notifications/initialized` | El widget confirma que está listo |
| **Host → Widget** | **`ui/notifications/tool-input`** | **CRÍTICO: argumentos del tool call (qué renderizar)** |
| Host → Widget | `ui/notifications/tool-result` | Resultado del tool call (metadata, checkpointId, etc.) |
| Widget → Host | `tools/call` | Widget invoca otra herramienta MCP (ej. `save_checkpoint`) |
| Widget → Host | `ui/display-mode` | Widget solicita cambio de modo (pip, fullscreen) |

---

## 4. Los Tres Bugs Originales

### Bug 1 — `ui/initialize` no tenía handler → Error -32601

**Síntoma:** El widget enviaba `ui/initialize` pero recibía error JSON-RPC `-32601` ("Method not found"). El SDK del widget fallaba en la inicialización y mostraba pantalla en blanco.

**Causa:** `UIResourceMessage.tsx` solo manejaba `ui/close`, `ui/size-change`, `ui/display-mode`, y notificaciones. El método `ui/initialize` caía en el `default` del switch que devuelve `-32601`.

**Ubicación:** `src/renderer/components/chat/UIResourceMessage.tsx` — switch `case` en `handleJsonRpcMessage`

---

### Bug 2 — Contaminación de mensajes entre protocolos

**Síntoma:** El widget MCP Apps recibía mensajes con formato OpenAI (`{type: 'openai:set_globals', globals: {...}}`) que su SDK parseaba con `JSONRPCMessageSchema.strict()`, generando errores `unrecognized_keys: type, globals`.

**Causa:** `widgetProxy.ts` → `generateProxyHtml()` retransmitía **todos** los postMessages del host al widget sin filtrar por protocolo. Cuando el renderer enviaba globales al estilo OpenAI SDK, estos llegaban también a widgets MCP Apps.

**Mecanismo:**

```
Renderer
  ├─ postMessage({ type: 'openai:set_globals', globals: {...} })
  │
  └─► Proxy Page (relay sin filtro)
        └─► Widget MCP Apps SDK
              └─► JSONRPCMessageSchema.strict().parse(data)
                    → Error: unrecognized_keys "type", "globals"
```

**Ubicación:** `src/main/services/widgetProxy.ts` → `generateProxyHtml()`

---

### Bug 3 — Code Mode habilitado por defecto

**Síntoma:** Cuando Code Mode estaba activo, el AI usaba `mcp_execute_code` para orchestrar herramientas en lugar del flujo normal. Esto omitía completamente el pipeline de detección de widgets (`handleMcpAppsWidget`), haciendo que nunca se creara la UI resource.

**Causa:** `DEFAULT_MCP_PREFERENCES.codeModeDefaults.enabled = true` a pesar de un comentario que decía "Disabled by default".

**Ubicación:** `src/types/preferences.ts`

---

### Bug 4 (descubierto en segunda iteración) — `ui/initialize` response mínima + sin notificaciones post-init

**Síntoma:** El widget se inicializaba pero mostraba pantalla en blanco. El SDK del widget (cargado desde `esm.sh`) no sabía qué renderizar porque nunca recibía los datos del tool call.

**Causa (parte A):** La response de `ui/initialize` enviaba `hostCapabilities: {}` y `hostContext: {}`. Sin `serverTools: {}` en capabilities, el widget SDK puede deshabilitar la funcionalidad de llamadas a herramientas.

**Causa (parte B):** El handler de `ui/notifications/initialized` solo logueaba el evento. Según SEP-1865, el host **debe** enviar `ui/notifications/tool-input` con los argumentos del tool call inmediatamente después de que el widget confirme su inicialización. Sin esta notificación, el SDK del widget no sabe qué elementos renderizar.

**Diferencia arquitectónica Levante vs MCPJam:**

```
MCPJam (flujo en tiempo real):
  AI genera argumentos → streaming → host envía tool-input-partial → widget renderiza progresivamente

Levante (flujo post-ejecución):
  AI ya ejecutó el tool → resultado existe → widget se crea → host debe reenviar argumentos vía notificación

El SDK del widget (esm.sh) espera ui/notifications/tool-input en AMBOS casos.
El bridge script inyecta window.mcpApp.toolInput estático pero el SDK oficial no lo lee de ahí.
```

---

## 5. Diagnóstico con Logs de MCPJam

MCPJam Inspector implementa el protocolo SEP-1865 correctamente. Comparar sus logs con el comportamiento de Levante fue clave para identificar los bugs 4A y 4B.

### Secuencia correcta (MCPJam)

```
11:27:05.856  RECEIVE  resources/read → HTML del widget
11:27:05.922  UI→HOST  ui/notifications/sandbox-proxy-ready
11:27:05.971  UI→HOST  ui/initialize  { appInfo: "openai-compat", protocolVersion: "2026-01-26" }
11:27:05.974  HOST→UI  response       { protocolVersion, hostCapabilities: {serverTools:{}, sandbox:{csp:{…}}}, hostContext: {theme, toolInfo:{id,tool}} }
11:27:05.976  UI→HOST  ui/notifications/initialized
11:27:05.979  HOST→UI  ui/notifications/tool-input  { arguments: {elements: "[partial…"} }  ← ¡AQUÍ!
11:27:06.380  HOST→UI  ui/notifications/tool-input  { arguments: {elements: "[completo…"} }
11:27:06.558  HOST→UI  ui/notifications/tool-result { content:[…], structuredContent:{checkpointId:…} }
11:27:06.778  UI→HOST  ui/initialize  { appInfo: "Excalidraw", protocolVersion: "2025-11-21" }  ← 2ª inicialización del SDK real
11:27:06.781  HOST→UI  response       { … con toolInfo … }
11:27:06.787  UI→HOST  ui/notifications/initialized
11:27:06.790  HOST→UI  ui/notifications/tool-input  ← reenviado al SDK real
11:27:06.790  HOST→UI  ui/notifications/tool-result ← reenviado al SDK real
```

### Por qué hay dos `ui/initialize`

El widget de Excalidraw contiene **dos capas de inicialización**:

1. **Capa de compatibilidad OpenAI** (`openai-compat`): un shim que primero hace handshake para obtener `hostContext.theme` y `toolInfo` antes de que cargue el SDK principal.
2. **SDK de MCP Apps** (`Excalidraw`): el SDK oficial de `esm.sh` que hace su propio handshake al cargar.

El host debe responder a **ambos** `ui/initialize` y reenviar `tool-input`/`tool-result` a **cada** `ui/notifications/initialized`.

### `hostContext.toolInfo` en MCPJam

```json
{
  "toolInfo": {
    "id": "call_uByGR5IyeBazUb2ovxeynbdQ",
    "tool": {
      "name": "create_view",
      "inputSchema": { "type": "object" }
    }
  }
}
```

Este campo permite al widget:
- Correlacionar el tool call con el checkpoint (`save_checkpoint`)
- Identificar qué herramienta fue la que lo invocó

Levante no pasa `toolCallId` a `UIResourceMessage` actualmente (mejora pendiente, ver §6.4).

---

## 6. Fixes Implementados

### Fix 1 — Handler `ui/initialize` (sesión 1)

**Archivo:** `src/renderer/components/chat/UIResourceMessage.tsx`

```typescript
case 'ui/initialize': {
  logger.mcp.info('[MCP Apps] Widget initializing', { ... });
  sendResponse({
    protocolVersion: params.protocolVersion || '0.1.0',
    hostCapabilities: {},
    hostInfo: { name: 'Levante', version: '1.0.0' },
    hostContext: {},
  });
  break;
}
```

Este fix resuelve el error `-32601` y permite que el handshake se complete.

---

### Fix 2 — Filtrado de mensajes por protocolo en widgetProxy (sesión 1)

**Archivo:** `src/main/services/widgetProxy.ts`

Se cambió la firma de `generateProxyHtml` para recibir el protocolo del widget, y se añadió filtrado en el relay host→widget:

```javascript
// En el proxy HTML generado:
const protocol = ${JSON.stringify(protocol)};

window.addEventListener('message', function(event) {
  if (event.source === window.parent) {
    const data = event.data;
    let shouldForward = true;

    if (protocol === 'mcp-apps') {
      // Solo mensajes JSON-RPC 2.0 para widgets MCP Apps
      shouldForward = data && data.jsonrpc === '2.0';
    } else if (protocol === 'openai-sdk') {
      // Solo mensajes openai:* para widgets OpenAI SDK
      shouldForward = data && typeof data.type === 'string' && data.type.startsWith('openai:');
    }

    if (shouldForward) {
      iframe.contentWindow.postMessage(data, '*');
    }
  }
});
```

Los mensajes widget→host se siguen retransmitiendo sin filtrar (el host puede ignorar lo que no entiende).

---

### Fix 3 — Code Mode deshabilitado por defecto (sesión 1)

**Archivo:** `src/types/preferences.ts`

```typescript
// Antes:
enabled: true, // Disabled by default - can be enabled per-server or globally

// Después:
enabled: false, // Disabled by default - can be enabled per-server or globally
```

---

### Fix 4A — `ui/initialize` response enriquecida (sesión 2)

**Archivo:** `src/renderer/components/chat/UIResourceMessage.tsx`

```typescript
case 'ui/initialize': {
  // Extraer CSP y permisos del recurso
  const uiMeta = (resource.resource as any)?._meta?.ui;
  const widgetCsp = uiMeta?.csp;
  const widgetPermissions = uiMeta?.permissions;

  setTimeout(() => {
    sendResponse({
      protocolVersion: initProtocolVersion || '0.1.0',
      hostCapabilities: {
        openLinks: {},
        serverTools: {},      // ← necesario para que el widget llame herramientas
        serverResources: {},
        logging: {},
        ...(widgetCsp || widgetPermissions ? {
          sandbox: {
            ...(widgetCsp ? { csp: widgetCsp } : {}),           // ← permite esm.sh
            ...(widgetPermissions ? { permissions: widgetPermissions } : {}),
          },
        } : {}),
      },
      hostInfo: { name: 'Levante', version: '1.0.0' },
      hostContext: {
        theme,                                    // ← tema actual
        displayMode,                              // ← modo de visualización
        availableDisplayModes: ['inline', 'pip', 'fullscreen'],
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        platform: 'desktop',
      },
    });
  }, 0);
  break;
}
```

---

### Fix 4B — Notificaciones `tool-input`/`tool-result` tras `initialized` (sesión 2)

**Archivo:** `src/renderer/components/chat/UIResourceMessage.tsx`

Este es el fix más crítico para que el widget renderice contenido.

```typescript
case 'ui/notifications/initialized': {
  logger.mcp.info('[MCP Apps] Widget initialized', { widgetId: params.widgetId });

  // CRÍTICO: enviar argumentos del tool call al widget para que sepa qué renderizar
  const toolInputData = bridgeOptions?.toolInput;
  if (toolInputData && Object.keys(toolInputData).length > 0 && event.source) {
    (event.source as Window).postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: toolInputData },   // ej: { elements: "[{type:rectangle,...}]" }
    }, '*');
  }

  // Enviar resultado del tool (structuredContent: checkpointId, etc.)
  const toolOutputData = bridgeOptions?.toolOutput;
  if (toolOutputData && event.source) {
    (event.source as Window).postMessage({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: toolOutputData },
    }, '*');
  }
  break;
}
```

**¿De dónde vienen `toolInput` y `toolOutput`?**

`mcpToolsAdapter.ts` → `handleMcpAppsWidget()` construye el recurso UI con:

```typescript
const uiResource = {
  type: "resource",
  resource: {
    uri: uiResourceUri,
    mimeType: mimeType,
    text: widgetHtml,
    _meta: {
      widgetProtocol: "mcp-apps",
      bridgeOptions: {
        toolInput: args,        // ← argumentos del tool call del AI (ej: {elements:"[...]"})
        toolOutput: widgetData, // ← structuredContent del resultado (ej: {checkpointId:"..."})
        serverId,
      },
    },
  },
};
```

El flujo completo desde el AI hasta el widget:

```
AI llama create_view({ elements: "[...]" })
  ↓
mcpToolsAdapter.handleMcpAppsWidget(serverId, tool, args, result, uri)
  ↓ fetcha HTML desde resources/read
  ↓ crea uiResource con _meta.bridgeOptions.toolInput = args
  ↓
ChatMessageItem extrae uiResources del tool output
  ↓
UIResourceMessage recibe resource con _meta.bridgeOptions.toolInput = { elements: "[...]" }
  ↓
Widget carga → bridge script inyecta window.mcpApp.toolInput estáticamente
  ↓
Widget SDK envía ui/initialize → host responde
  ↓
Widget SDK envía ui/notifications/initialized
  ↓
UIResourceMessage envía ui/notifications/tool-input({ arguments: { elements: "[...]" } })
  ↓
Widget SDK recibe argumentos → renderiza el diagrama
```

---

## 6.4 Mejoras Pendientes

### `toolInfo` en `hostContext` (no implementado)

MCPJam incluye `hostContext.toolInfo` con el ID del tool call del LLM y el schema de la herramienta. Esto permite al widget correlacionar sus `tools/call` de callback (ej. `save_checkpoint`) con el tool call original.

Para implementarlo, se necesita pasar `toolCallId` desde `ChatMessageItem.tsx` a `UIResourceMessage.tsx` como prop:

```typescript
// ChatMessageItem.tsx
<UIResourceMessage
  resource={resource}
  serverId={serverId}
  toolCallId={part.toolCallId}          // ← añadir
  toolName={toolNameParts.slice(1).join('_')}  // ← bare name sin serverId prefix
  ...
/>

// UIResourceMessage.tsx
hostContext: {
  ...
  toolInfo: toolCallId ? {
    id: toolCallId,
    tool: { name: toolName || '', inputSchema: { type: 'object' } },
  } : undefined,
},
```

---

## 7. Referencia de Archivos Clave

| Archivo | Responsabilidad |
|---|---|
| `src/renderer/components/chat/UIResourceMessage.tsx` | Orquestador de widgets: handlers JSON-RPC MCP Apps, postMessage bridge OpenAI SDK, gestión displayMode |
| `src/main/services/widgetProxy.ts` | Servidor HTTP proxy local, generación de HTML relay, almacén de widgets por TTL |
| `src/main/services/ai/widgets/mcpAppsBridge.ts` | Genera el bridge script inyectado: `window.mcpApp`, `window.openai`, handlers para notificaciones |
| `src/main/services/ai/mcpToolsAdapter.ts` | Detecta protocolo de widget, fetcha HTML, construye `uiResource` con `_meta.bridgeOptions` |
| `src/main/services/ai/widgets/types.ts` | `detectWidgetProtocol()`, `WidgetProtocol` type, `WidgetMetadata` |
| `src/types/preferences.ts` | `DEFAULT_MCP_PREFERENCES` con `codeModeDefaults.enabled` |

### Rutas de logs relevantes (DevTools)

Todos los logs de widgets usan la categoría `mcp`:

```
[MCP Apps] Widget initializing        → ui/initialize recibido
[MCP Apps] Widget initialized         → ui/notifications/initialized recibido
[MCP Apps] Sent tool-input notification after widget init
[MCP Apps] Widget calling tool        → tools/call del widget al host
Widget proxy serving proxy page        → el proxy sirvió la página relay
Widget content served                  → el proxy sirvió el HTML del widget
```

Para activar logs MCP en desarrollo, añadir a `.env.local`:
```
DEBUG_MCP=true
DEBUG_ENABLED=true
```
