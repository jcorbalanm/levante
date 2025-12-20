# PRD: MCP UI Widgets Integration

## Status: ✅ Production Ready (95% Complete)

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1: Core Integration | ✅ Done | UIResourceMessage, detection, data injection |
| Phase 2: UIAction Handlers | ✅ Done | Tool calls, prompts, links, notifications |
| Phase 3: Display Modes | ✅ Done | Inline, PiP, Fullscreen |
| Phase 4: Widget HTTP Proxy | ✅ Done | CSP bypass, bridge injection, security |
| Phase 5: MCP Apps (SEP-1865) | ✅ Done | JSON-RPC 2.0, window.mcpApp API |
| Phase 6: OpenAI Apps SDK | ✅ Done | window.openai compatibility |
| Phase 7: Polish | ✅ Done | Theme sync, auto-resize, visual separation |
| Phase 8: Context Picker | ❌ 0% | Not started |

### Recent Updates
- **2024-12-20**: Removed hardcoded MCP server references, dynamic baseUrl resolution
- **2024-12-20**: Added `mcp:tool-cancelled` event for SEP-1865 compliance
- **2024-12-20**: Fixed theme to use Levante settings (not OS directly)
- **2024-12-20**: Visual separation between ToolCall and widget during streaming
- **2024-12-19**: Fixed toolInput/toolOutput passing to OpenAI SDK widgets
- **2024-12-19**: Added MCP Apps (SEP-1865) support with JSON-RPC 2.0 protocol
- **2024-12-19**: Fixed MIME type detection for `text/html;profile=mcp-app`
- **2024-12-08**: Widget HTTP Proxy for CSP bypass and bridge injection

---

## Overview

Levante supports **three widget protocols** for MCP servers to provide rich, interactive UIs:

1. **MCP Apps (SEP-1865)** - JSON-RPC 2.0 protocol with `window.mcpApp` API
2. **OpenAI Apps SDK** - Custom postMessage protocol with `window.openai` API
3. **MCP-UI** - Basic `ui://` resources with `@mcp-ui/client`

### Protocol Detection Priority

When rendering tool results, Levante checks for UI metadata in this order:

1. **MCP Apps**: `ui/resourceUri` in tool metadata → `text/html;profile=mcp-app`
2. **OpenAI Apps SDK**: `openai/outputTemplate` in tool metadata
3. **MCP-UI**: Inline `ui://` resource in tool result

---

## Architecture

### Widget HTTP Proxy

All HTML widgets are served through a local HTTP proxy server for:
- **Real origin**: Widgets get a real origin instead of `null` from srcdoc iframes
- **Permissive CSP**: External scripts and resources can load properly
- **Bridge injection**: Automatic injection of `window.mcpApp` or `window.openai` APIs
- **Security isolation**: Double-iframe sandbox architecture

```
Host (Levante React) → Proxy Page (iframe #1) → Widget Content (iframe #2)
```

### Key Files

| File | Purpose |
|------|---------|
| `src/main/services/widgetProxy.ts` | HTTP proxy server, bridge injection |
| `src/main/services/ai/widgets/mcpAppsBridge.ts` | MCP Apps (SEP-1865) bridge script |
| `src/main/services/ai/widgets/types.ts` | Widget type definitions |
| `src/main/ipc/widgetHandlers.ts` | IPC handlers for widget storage |
| `src/renderer/components/chat/UIResourceMessage.tsx` | Widget rendering component |
| `src/renderer/components/chat/ChatMessageItem.tsx` | Message with visual separation |
| `src/main/services/ai/mcpToolsAdapter.ts` | Tool execution and widget handling |

---

## MCP Apps (SEP-1865)

### window.mcpApp API

Widgets can access this API when using the MCP Apps protocol:

```javascript
window.mcpApp = {
  // Data properties (injected on load)
  toolInput: { ... },     // Tool input arguments
  toolResult: { ... },    // Tool execution result
  hostContext: { ... },   // Host context (theme, locale, etc.)

  // Methods
  async callTool(name, args),      // Call another MCP tool
  async readResource(uri),         // Read an MCP resource
  async openLink(url),             // Open external link
  async sendMessage(text),         // Send message to chat
  resize(width, height),           // Notify host of size change
};
```

### Events

Widgets can listen for these events:

```javascript
window.addEventListener('mcp:tool-input', (e) => { ... });
window.addEventListener('mcp:tool-result', (e) => { ... });
window.addEventListener('mcp:tool-cancelled', (e) => { ... });
window.addEventListener('mcp:context-change', (e) => { ... });
window.addEventListener('mcp:teardown', (e) => { ... });
```

### JSON-RPC 2.0 Protocol

All communication uses JSON-RPC 2.0 format:

**Requests (with response expected):**
```javascript
{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "...", arguments: {} } }
```

**Notifications (no response):**
```javascript
{ jsonrpc: "2.0", method: "ui/notifications/initialized", params: { widgetId: "..." } }
```

### Supported Methods

| Method | Direction | Description |
|--------|-----------|-------------|
| `tools/call` | Widget → Host | Call an MCP tool |
| `resources/read` | Widget → Host | Read an MCP resource |
| `ui/open-link` | Widget → Host | Open external URL |
| `ui/message` | Widget → Host | Send message to chat |
| `ui/size-change` | Widget → Host | Notify of size change |
| `ui/notifications/initialized` | Widget → Host | Widget finished initializing |
| `ui/notifications/tool-input` | Host → Widget | Send tool input |
| `ui/notifications/tool-result` | Host → Widget | Send tool result |
| `ui/notifications/tool-cancelled` | Host → Widget | Tool was cancelled |
| `ui/host-context-change` | Host → Widget | Theme or context changed |
| `ui/notifications/teardown` | Host → Widget | Widget is about to be torn down |

---

## OpenAI Apps SDK

### window.openai API

For compatibility with OpenAI Apps SDK widgets:

```javascript
window.openai = {
  // Data properties
  toolInput: { ... },
  toolOutput: { ... },
  toolResponseMetadata: { ... },
  theme: 'light' | 'dark',
  locale: 'en-US',
  displayMode: 'inline',
  maxHeight: 600,
  safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  userAgent: { device: { type: 'desktop' }, capabilities: { hover: true, touch: false } },
  widgetState: {},

  // Methods
  async callTool(name, args),
  async sendFollowUpMessage(message),
  async requestDisplayMode(options),
  async setWidgetState(state),
  async openExternal(options),
  async requestModal(options),
  async requestClose(),
  async resize(height),
};
```

---

## Display Modes

### Inline (Default)
Widget renders within the chat message flow with auto-resize (200px - 600px height).

### Picture-in-Picture (PiP)
Floating, draggable window that persists while scrolling chat.

### Fullscreen
Overlay mode with backdrop blur for immersive experiences.

---

## Theme Synchronization

Widgets receive theme from **Levante settings** (not OS directly):

```javascript
// In bridge injection
hostContext: {
  theme: 'light' | 'dark',  // From Levante preferences
  locale: 'en-US',
  displayMode: 'inline',
  // ...
}
```

Theme changes are communicated via:
- `ui/host-context-change` notification (MCP Apps)
- `openai:set_globals` message (OpenAI SDK)

---

## Security Model

### Content Security Policy

The widget proxy uses a permissive CSP:

```
default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;
script-src * 'unsafe-inline' 'unsafe-eval' data: blob:;
style-src * 'unsafe-inline' data: blob:;
connect-src *;
```

### Iframe Sandbox Attributes

```html
<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation" />
```

### Security Features

- **Double-iframe architecture**: Origin isolation between host and widget
- **Secret token authentication**: Prevents unauthorized access to widget proxy
- **API shimming**: Graceful handling of unsupported APIs (Keyboard.lock, requestFullscreen)
- **Dynamic baseUrl**: No hardcoded server references

---

## Implementation Details

### MIME Type Detection

```typescript
const mimeType = resource?.mimeType || '';
const isHtml = mimeType === 'text/html' ||
               mimeType.startsWith('text/html+') ||
               mimeType.startsWith('text/html;');
```

Supported formats:
- `text/html`
- `text/html+skybridge`
- `text/html;profile=mcp-app`
- `text/html; charset=utf-8`

### Widget Data Flow

```
MCP Tool Execution
    ↓
mcpToolsAdapter.ts → handleAppsSdkWidget() / handleMcpAppsWidget()
    ↓
Adds bridgeOptions: { toolInput, toolOutput, theme, locale }
    ↓
UIResourceMessage.tsx → detects widget protocol
    ↓
IPC → widgetHandlers.ts → widgetProxy.ts
    ↓
HTTP Proxy serves widget with injected bridge
```

### Base URL Resolution

Relative URLs in widgets are resolved dynamically:
1. Extract from HTML content (script/link tags)
2. Use resource URI origin if available
3. Inject `<base href="...">` tag

---

## Testing

### MCP Servers for Testing

| Server | Protocol | Features |
|--------|----------|----------|
| Arcade (arcade.xmcp.dev) | MCP Apps | FIFA World Cup widgets |
| Regex Playground | OpenAI SDK | Regex testing interface |
| mcp-ui examples | MCP-UI | Basic HTML widgets |

### Test Cases

1. **MCP Apps widget loads with toolInput/toolOutput**
2. **OpenAI SDK widget loads with correct theme**
3. **Theme changes propagate to widget**
4. **Widget can call back to MCP tools**
5. **External links open correctly**
6. **Display mode switching works**
7. **Visual separation during streaming**

---

## Implementation Checklist

### Phase 1-3: Core & Display ✅
- [x] UIResourceMessage component
- [x] Display modes (inline, PiP, fullscreen)
- [x] Auto-resize iframe (200px-600px)
- [x] Error handling and loading states

### Phase 4: Widget HTTP Proxy ✅
- [x] Local HTTP server for widgets
- [x] Secret token authentication
- [x] Double-iframe sandbox architecture
- [x] Base URL injection for relative paths
- [x] Next.js image proxy support
- [x] Dynamic baseUrl resolution (no hardcoded servers)

### Phase 5: MCP Apps (SEP-1865) ✅
- [x] JSON-RPC 2.0 protocol
- [x] window.mcpApp API
- [x] All events (tool-input, tool-result, tool-cancelled, context-change, teardown)
- [x] tools/call and resources/read methods
- [x] ui/open-link, ui/message, ui/size-change notifications

### Phase 6: OpenAI Apps SDK ✅
- [x] window.openai API
- [x] Compatibility layer (maps to mcpApp methods)
- [x] Legacy message format handling
- [x] Widget state support
- [x] toolInput/toolOutput injection

### Phase 7: Polish ✅
- [x] Theme from Levante settings (not OS)
- [x] Visual separation between ToolCall and widget
- [x] Streaming support
- [x] API shimming (Keyboard.lock, requestFullscreen)

### Phase 8: Context Picker ❌
- [ ] WidgetContextPicker component
- [ ] Integration with AddContextMenu

---

## Comparison: MCP Apps vs OpenAI Apps SDK

| Feature | MCP Apps (SEP-1865) | OpenAI Apps SDK |
|---------|---------------------|-----------------|
| Protocol | JSON-RPC 2.0 | Custom postMessage |
| API | `window.mcpApp` | `window.openai` |
| Detection | `ui/resourceUri` | `openai/outputTemplate` |
| MIME Type | `text/html;profile=mcp-app` | `text/html` / `text/html+skybridge` |
| State persistence | Not supported | localStorage |
| Modal support | Not supported | Supported |

---

## References

- [SEP-1865: MCP Apps Proposal](https://github.com/anthropics/mcp/blob/main/proposals/sep-1865.md)
- [OpenAI Apps SDK Reference](https://platform.openai.com/docs/apps-sdk)
- [MCP-UI Official Repository](https://github.com/MCP-UI-Org/mcp-ui)
- [MCP-UI Documentation](https://mcpui.dev)
