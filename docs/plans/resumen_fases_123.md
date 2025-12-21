# Resumen de Fases 1, 2 y 3 - Implementación OAuth para Levante

## Información del Documento

- **Versión**: 1.0
- **Fecha**: 2025-12-21
- **Estado**: Documentación de fases completadas
- **Audiencia**: Desarrolladores trabajando con OAuth en Levante

---

## Tabla de Contenidos

1. [Visión General](#visión-general)
2. [Fase 1: Token Store Seguro](#fase-1-token-store-seguro)
3. [Fase 2: OAuth Flow con PKCE](#fase-2-oauth-flow-con-pkce)
4. [Fase 3: Discovery Automático](#fase-3-discovery-automático)
5. [Integración y Uso](#integración-y-uso)
6. [Testing](#testing)
7. [Consideraciones de Seguridad](#consideraciones-de-seguridad)

---

## Visión General

Las fases 1, 2 y 3 implementan el **núcleo funcional** del sistema OAuth 2.1 con PKCE para Levante, permitiendo autenticación segura con servidores MCP protegidos.

### ¿Qué se ha implementado?

```
Fase 1 (Token Store) → Almacenamiento seguro de tokens encriptados
Fase 2 (OAuth Flow)  → Flujo completo de autorización con PKCE
Fase 3 (Discovery)   → Descubrimiento automático de authorization servers
```

### Stack Tecnológico

- **Encriptación**: `electron.safeStorage` (Keychain/DPAPI/libsecret)
- **PKCE**: SHA-256 con `crypto` built-in
- **HTTP Server**: Node.js `http` para loopback callback
- **Discovery**: RFC 9728 + RFC 8414
- **Almacenamiento**: `~/levante/ui-preferences.json`

### Estructura de Archivos

```
src/main/services/oauth/
├── index.ts                          # Exports públicos
├── types.ts                          # TypeScript types completos
├── OAuthTokenStore.ts                # Fase 1: Token storage
├── OAuthFlowManager.ts               # Fase 2: OAuth flow
├── OAuthRedirectServer.ts            # Fase 2: Loopback server
├── OAuthStateManager.ts              # Fase 2: State management
├── OAuthDiscoveryService.ts          # Fase 3: Discovery
└── __tests__/                        # Tests unitarios
    ├── OAuthTokenStore.test.ts
    ├── OAuthFlowManager.test.ts
    ├── OAuthRedirectServer.test.ts
    ├── OAuthDiscoveryService.test.ts
    └── oauth-integration.test.ts
```

---

## Fase 1: Token Store Seguro

### Objetivo

Implementar almacenamiento seguro de tokens OAuth con encriptación automática usando `electron.safeStorage`.

### Componente Principal: `OAuthTokenStore`

**Ubicación**: `src/main/services/oauth/OAuthTokenStore.ts`

#### API Principal

```typescript
class OAuthTokenStore {
  // Guardar tokens (automáticamente encriptados)
  async saveTokens(serverId: string, tokens: OAuthTokens): Promise<void>

  // Obtener tokens (automáticamente desencriptados)
  async getTokens(serverId: string): Promise<OAuthTokens | null>

  // Eliminar tokens
  async deleteTokens(serverId: string): Promise<void>

  // Verificar si token está expirado (incluye 60s de buffer)
  isTokenExpired(tokens: OAuthTokens): boolean

  // Listar servidores con tokens
  async getAllTokenizedServers(): Promise<string[]>

  // Limpiar tokens expirados sin refresh token
  async cleanExpiredTokens(): Promise<number>

  // Verificar disponibilidad de encriptación
  isEncryptionAvailable(): boolean
}
```

#### Tipos Clave

```typescript
interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;        // Unix timestamp en milliseconds
  tokenType: 'Bearer';
  scope?: string;
}

interface StoredOAuthTokens {
  accessToken: string;      // ENCRYPTED
  refreshToken?: string;    // ENCRYPTED
  expiresAt: number;
  tokenType: 'Bearer';
  scope?: string;
  issuedAt: number;
}
```

#### Estructura de Almacenamiento

**Archivo**: `~/levante/ui-preferences.json`

```json
{
  "mcpServers": {
    "server-id": {
      "transport": "http",
      "baseUrl": "https://mcp.example.com",
      "oauth": {
        "enabled": true,
        "authServerId": "https://auth.example.com",
        "clientId": "levante-client-abc123",
        "scopes": ["mcp:read", "mcp:write"],
        "redirectUri": "http://127.0.0.1/callback"
      }
    }
  },
  "oauthTokens": {
    "server-id": {
      "accessToken": "ENCRYPTED:aGVsbG8gd29ybGQ=...",
      "refreshToken": "ENCRYPTED:cmVmcmVzaCB0b2tlbg==...",
      "expiresAt": 1703980800000,
      "tokenType": "Bearer",
      "scope": "mcp:read mcp:write",
      "issuedAt": 1703977200000
    }
  }
}
```

#### Encriptación

- **Motor**: `electron.safeStorage`
- **Backend por OS**:
  - macOS: Keychain
  - Windows: DPAPI
  - Linux: libsecret
- **Formato**: `ENCRYPTED:` + base64(encrypted_data)
- **Campos encriptados**: `accessToken`, `refreshToken`, `clientSecret`

#### Uso Básico

```typescript
import { OAuthTokenStore } from './services/oauth';
import { PreferencesService } from './services/preferences/PreferencesService';

const prefs = new PreferencesService();
await prefs.initialize();

const tokenStore = new OAuthTokenStore(prefs);

// Guardar tokens
await tokenStore.saveTokens('my-server', {
  accessToken: 'abc123',
  refreshToken: 'xyz789',
  expiresAt: Date.now() + 3600000,
  tokenType: 'Bearer',
  scope: 'mcp:read mcp:write',
});

// Recuperar tokens
const tokens = await tokenStore.getTokens('my-server');
console.log(tokens?.accessToken); // Desencriptado automáticamente

// Verificar expiración
if (tokens && tokenStore.isTokenExpired(tokens)) {
  console.log('Token expired, need refresh');
}
```

#### Características Importantes

- **Buffer de expiración**: 60 segundos para clock skew
- **Auto-cleanup**: Limpieza automática de tokens expirados sin refresh token
- **Type-safe**: Completo soporte TypeScript
- **Error handling**: Excepciones tipadas (`OAuthTokenStoreError`)

---

## Fase 2: OAuth Flow con PKCE

### Objetivo

Implementar el flujo completo de Authorization Code Flow con PKCE (Proof Key for Code Exchange) según OAuth 2.1.

### Componentes Principales

#### 1. `OAuthFlowManager`

**Ubicación**: `src/main/services/oauth/OAuthFlowManager.ts`

**Responsabilidades**:
- Generar PKCE (verifier + challenge)
- Crear Authorization URLs
- Intercambiar code por tokens
- Refresh de access tokens
- Orquestar el flujo completo de autorización

**API Principal**:

```typescript
class OAuthFlowManager {
  // Generar PKCE con S256
  generatePKCE(): PKCEParams

  // Crear Authorization URL
  createAuthorizationUrl(params: AuthorizationUrlParams): string

  // Flujo completo de autorización (abre browser, espera callback)
  async authorize(params: {
    serverId: string;
    authorizationEndpoint: string;
    clientId: string;
    scopes: string[];
    resource?: string;
  }): Promise<{ code: string; verifier: string }>

  // Intercambiar code por tokens
  async exchangeCodeForTokens(params: TokenExchangeParams): Promise<OAuthTokens>

  // Refresh access token
  async refreshAccessToken(params: TokenRefreshParams): Promise<OAuthTokens>

  // Cleanup de states expirados
  cleanup(): void
}
```

**Tipos Clave**:

```typescript
interface PKCEParams {
  verifier: string;    // 43-128 caracteres, base64url
  challenge: string;   // SHA-256(verifier), base64url
  method: 'S256';
}

interface AuthorizationUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  resource?: string;   // RFC 8707
}

interface TokenExchangeParams {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
  clientSecret?: string;
}

interface TokenRefreshParams {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}
```

#### 2. `OAuthRedirectServer`

**Ubicación**: `src/main/services/oauth/OAuthRedirectServer.ts`

**Responsabilidades**:
- Crear servidor HTTP loopback en 127.0.0.1
- Escuchar callback de OAuth
- Mostrar página de éxito/error al usuario
- Timeout configurable (default: 5 minutos)

**API Principal**:

```typescript
class OAuthRedirectServer {
  // Iniciar servidor en puerto aleatorio
  async start(config?: LoopbackServerConfig): Promise<LoopbackServerResult>

  // Esperar callback de OAuth
  async waitForCallback(): Promise<AuthorizationCallback>

  // Detener servidor
  async stop(): Promise<void>
}

interface LoopbackServerResult {
  port: number;
  redirectUri: string;  // e.g., "http://127.0.0.1:8080/callback"
}

interface AuthorizationCallback {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}
```

#### 3. `OAuthStateManager`

**Ubicación**: `src/main/services/oauth/OAuthStateManager.ts`

**Responsabilidades**:
- Generar state parameters (128 bits de entropía)
- Almacenar state temporalmente con timeout
- Validar state en callback
- Auto-cleanup de states expirados

**API Principal**:

```typescript
class OAuthStateManager {
  // Generar state aleatorio
  generateState(): string

  // Almacenar state con metadata
  storeState(
    state: string,
    serverId: string,
    codeVerifier: string,
    redirectUri: string,
    timeout?: number
  ): void

  // Validar y recuperar state (one-time use)
  validateAndRetrieveState(state: string): StoredState

  // Limpiar states expirados
  cleanExpiredStates(): number
}
```

### Flujo Completo de Autorización

```typescript
import { OAuthFlowManager, OAuthTokenStore } from './services/oauth';

const flowManager = new OAuthFlowManager();
const tokenStore = new OAuthTokenStore(preferencesService);

async function authorizeServer(serverId: string) {
  try {
    // 1. Ejecutar flujo de autorización
    const { code, verifier } = await flowManager.authorize({
      serverId,
      authorizationEndpoint: 'https://auth.example.com/authorize',
      clientId: 'my-client-id',
      scopes: ['mcp:read', 'mcp:write'],
      resource: 'https://mcp.example.com',  // RFC 8707
    });

    // 2. Intercambiar code por tokens
    const tokens = await flowManager.exchangeCodeForTokens({
      tokenEndpoint: 'https://auth.example.com/token',
      code,
      redirectUri: 'http://127.0.0.1:PORT/callback',  // Del loopback server
      clientId: 'my-client-id',
      codeVerifier: verifier,
    });

    // 3. Guardar tokens
    await tokenStore.saveTokens(serverId, tokens);

    console.log('Authorization successful!');
  } catch (error) {
    console.error('Authorization failed:', error);
  }
}
```

### Flujo de Refresh de Tokens

```typescript
async function refreshTokenIfNeeded(serverId: string) {
  const tokens = await tokenStore.getTokens(serverId);

  if (!tokens) {
    throw new Error('No tokens found');
  }

  if (tokenStore.isTokenExpired(tokens)) {
    console.log('Token expired, refreshing...');

    const newTokens = await flowManager.refreshAccessToken({
      tokenEndpoint: 'https://auth.example.com/token',
      refreshToken: tokens.refreshToken!,
      clientId: 'my-client-id',
    });

    await tokenStore.saveTokens(serverId, newTokens);
    return newTokens;
  }

  return tokens;
}
```

### Características Importantes

#### PKCE (Proof Key for Code Exchange)

- **Método**: S256 (SHA-256)
- **Verifier**: 32 bytes random → 43 caracteres base64url
- **Challenge**: SHA-256(verifier) → base64url
- **Obligatorio**: OAuth 2.1 requiere PKCE

```typescript
const pkce = flowManager.generatePKCE();
console.log(pkce.verifier);   // "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
console.log(pkce.challenge);  // "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
console.log(pkce.method);     // "S256"
```

#### State Parameter

- **Entropía**: 128 bits (16 bytes)
- **Formato**: Hex string (32 caracteres)
- **Timeout**: 5 minutos (configurable)
- **One-time use**: Se elimina tras validación
- **Propósito**: Prevenir CSRF attacks

#### Loopback Server

- **Host**: 127.0.0.1 (nunca 0.0.0.0)
- **Puerto**: Aleatorio (evita conflictos)
- **Path**: `/callback` (fijo)
- **Timeout**: 5 minutos (configurable)
- **HTML Pages**: Páginas de éxito/error amigables

#### Seguridad

- ✅ PKCE S256 obligatorio
- ✅ State parameter único por sesión
- ✅ Loopback solo en 127.0.0.1
- ✅ Puerto aleatorio
- ✅ HTTPS para auth endpoints (excepto localhost)
- ✅ Auto-cleanup de recursos

---

## Fase 3: Discovery Automático

### Objetivo

Implementar descubrimiento automático de authorization servers según RFC 9728 y RFC 8414, permitiendo que Levante detecte y configure OAuth sin intervención manual.

### Componente Principal: `OAuthDiscoveryService`

**Ubicación**: `src/main/services/oauth/OAuthDiscoveryService.ts`

**Responsabilidades**:
- Discovery de authorization servers desde MCP servers (RFC 9728)
- Fetching de metadata de authorization servers (RFC 8414)
- Parsing de WWW-Authenticate headers
- Cache de metadata con TTL
- Validación completa de metadata

#### API Principal

```typescript
class OAuthDiscoveryService {
  // RFC 9728: Descubrir authorization servers desde protected resource
  async discoverAuthServer(resourceUrl: string): Promise<ProtectedResourceMetadata>

  // RFC 8414: Fetch metadata de authorization server
  async fetchServerMetadata(authServerUrl: string): Promise<AuthorizationServerMetadata>

  // Parsear WWW-Authenticate header
  parseWWWAuthenticate(header: string): WWWAuthenticateParams

  // Discovery completo desde 401 response
  async discoverFromUnauthorized(
    resourceUrl: string,
    wwwAuthenticateHeader?: string
  ): Promise<DiscoveryResult>

  // Cache management
  cleanExpiredCache(): number
  clearCache(): void
  getCacheStats(): { metadataCount: number; resourceCount: number; total: number }
}
```

#### Tipos Clave

```typescript
// RFC 9728: Protected Resource Metadata
interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported?: string[];
  resource_documentation?: string;
}

// RFC 8414: Authorization Server Metadata
interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  code_challenge_methods_supported: string[];  // Debe incluir 'S256'
}

// WWW-Authenticate Header
interface WWWAuthenticateParams {
  scheme?: string;
  realm?: string;
  as_uri?: string;
  resource_metadata?: string;
  error?: string;
  error_description?: string;
  scope?: string;
}

// Discovery Result
interface DiscoveryResult {
  authorizationServer: string;
  metadata: AuthorizationServerMetadata;
  fromCache: boolean;
}
```

### Flujo de Discovery Completo

```typescript
import { OAuthDiscoveryService } from './services/oauth';

const discovery = new OAuthDiscoveryService();

async function discoverAndConnect(mcpServerUrl: string) {
  try {
    // 1. Intentar request sin autenticación
    const response = await fetch(mcpServerUrl);

    if (response.status === 401) {
      // 2. Obtener WWW-Authenticate header
      const wwwAuth = response.headers.get('WWW-Authenticate');

      // 3. Discovery completo
      const result = await discovery.discoverFromUnauthorized(
        mcpServerUrl,
        wwwAuth
      );

      console.log('Authorization Server:', result.authorizationServer);
      console.log('Authorization Endpoint:', result.metadata.authorization_endpoint);
      console.log('Token Endpoint:', result.metadata.token_endpoint);
      console.log('Registration Endpoint:', result.metadata.registration_endpoint);
      console.log('Scopes Supported:', result.metadata.scopes_supported);
      console.log('PKCE Methods:', result.metadata.code_challenge_methods_supported);

      // 4. Verificar PKCE S256 support
      if (!result.metadata.code_challenge_methods_supported.includes('S256')) {
        throw new Error('Authorization server does not support PKCE S256');
      }

      // 5. Proceder con OAuth flow usando metadata
      return result.metadata;
    }
  } catch (error) {
    console.error('Discovery failed:', error);
  }
}
```

### Discovery Paso a Paso

#### 1. Protected Resource Metadata (RFC 9728)

```typescript
// Endpoint: /.well-known/oauth-protected-resource
const resourceMetadata = await discovery.discoverAuthServer(
  'https://mcp.example.com'
);

console.log(resourceMetadata);
// {
//   resource: "https://mcp.example.com",
//   authorization_servers: ["https://auth.example.com"]
// }
```

#### 2. Authorization Server Metadata (RFC 8414)

```typescript
// Endpoint: /.well-known/oauth-authorization-server
const serverMetadata = await discovery.fetchServerMetadata(
  'https://auth.example.com'
);

console.log(serverMetadata);
// {
//   issuer: "https://auth.example.com",
//   authorization_endpoint: "https://auth.example.com/authorize",
//   token_endpoint: "https://auth.example.com/token",
//   response_types_supported: ["code"],
//   code_challenge_methods_supported: ["S256"],
//   registration_endpoint: "https://auth.example.com/register",
//   revocation_endpoint: "https://auth.example.com/revoke",
//   scopes_supported: ["mcp:read", "mcp:write"]
// }
```

#### 3. WWW-Authenticate Header Parsing

```typescript
const header = 'Bearer realm="mcp", as_uri="https://auth.example.com", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';

const parsed = discovery.parseWWWAuthenticate(header);

console.log(parsed);
// {
//   scheme: "Bearer",
//   realm: "mcp",
//   as_uri: "https://auth.example.com",
//   resource_metadata: "https://mcp.example.com/.well-known/oauth-protected-resource"
// }
```

### Cache de Metadata

#### Configuración

- **TTL**: 1 hora (configurable)
- **Storage**: In-memory Map
- **Auto-cleanup**: Automático tras TTL
- **Persistencia**: No persiste entre reinicios

#### Uso

```typescript
// Primera llamada - fetch desde servidor
const metadata1 = await discovery.fetchServerMetadata('https://auth.example.com');
console.log('From server');

// Segunda llamada - desde cache
const metadata2 = await discovery.fetchServerMetadata('https://auth.example.com');
console.log('From cache');

// Stats
const stats = discovery.getCacheStats();
console.log(stats);
// { metadataCount: 1, resourceCount: 0, total: 1 }

// Limpiar cache
discovery.clearCache();
```

### Validación de Metadata

#### Protected Resource Metadata

- ✅ Campo `resource` obligatorio
- ✅ Campo `authorization_servers` obligatorio (array no vacío)
- ✅ Origin del `resource` debe coincidir con el MCP server

```typescript
// ❌ Error: resource origin mismatch
{
  resource: "https://different-origin.com",
  authorization_servers: ["https://auth.example.com"]
}
// Expected: https://mcp.example.com
```

#### Authorization Server Metadata

- ✅ Campos obligatorios:
  - `issuer`
  - `authorization_endpoint`
  - `token_endpoint`
  - `response_types_supported`
  - `code_challenge_methods_supported`
- ✅ PKCE S256 obligatorio
- ✅ HTTPS para endpoints (excepto localhost)
- ⚠️ Warning si issuer origin no coincide con auth server

```typescript
// ❌ Error: PKCE not supported
{
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  response_types_supported: ["code"],
  // Falta code_challenge_methods_supported
}

// ❌ Error: PKCE S256 not supported
{
  // ...
  code_challenge_methods_supported: ["plain"]  // Solo plain, no S256
}

// ✅ OK
{
  // ...
  code_challenge_methods_supported: ["S256", "plain"]
}
```

### Características Importantes

#### Estrategia de Discovery

1. **Desde WWW-Authenticate header** (si disponible):
   - Usar `as_uri` directamente
   - O usar `resource_metadata` URL

2. **Desde Protected Resource**:
   - Fetch `/.well-known/oauth-protected-resource`
   - Usar primer servidor de `authorization_servers` array

3. **Fetch Authorization Server Metadata**:
   - Fetch `/.well-known/oauth-authorization-server`
   - Validar metadata completo

#### Prioridad de Selección

```typescript
// WWW-Authenticate header tiene prioridad
const wwwAuth = 'Bearer as_uri="https://custom-auth.example.com"';
const result = await discovery.discoverFromUnauthorized(
  'https://mcp.example.com',
  wwwAuth
);

// Usará https://custom-auth.example.com
// Aunque protected resource metadata indique otro servidor
```

#### Error Handling

```typescript
try {
  const result = await discovery.discoverFromUnauthorized(
    'https://mcp.example.com'
  );
} catch (error) {
  if (error instanceof OAuthDiscoveryError) {
    switch (error.code) {
      case 'METADATA_FETCH_FAILED':
        console.log('Failed to fetch metadata:', error.details);
        break;
      case 'INVALID_METADATA':
        console.log('Invalid metadata:', error.details);
        break;
      case 'PKCE_NOT_SUPPORTED':
        console.log('Server does not support PKCE S256');
        break;
      case 'NETWORK_ERROR':
        console.log('Network error:', error.details);
        break;
      case 'VALIDATION_FAILED':
        console.log('Validation failed:', error.details);
        break;
      case 'PARSE_ERROR':
        console.log('Parse error:', error.details);
        break;
    }
  }
}
```

---

## Integración y Uso

### Flujo Completo de Conexión OAuth

```typescript
import {
  OAuthDiscoveryService,
  OAuthFlowManager,
  OAuthTokenStore,
} from './services/oauth';
import { PreferencesService } from './services/preferences/PreferencesService';

async function connectToOAuthProtectedMCPServer(mcpServerUrl: string) {
  const discovery = new OAuthDiscoveryService();
  const flowManager = new OAuthFlowManager();
  const prefs = new PreferencesService();
  await prefs.initialize();
  const tokenStore = new OAuthTokenStore(prefs);

  try {
    // 1. Discovery: Detectar authorization server
    console.log('Step 1: Discovering authorization server...');
    const { authorizationServer, metadata } = await discovery.discoverFromUnauthorized(
      mcpServerUrl
    );

    console.log('Authorization Server:', authorizationServer);
    console.log('Authorization Endpoint:', metadata.authorization_endpoint);
    console.log('Token Endpoint:', metadata.token_endpoint);

    // 2. Verificar PKCE support
    if (!metadata.code_challenge_methods_supported.includes('S256')) {
      throw new Error('Server does not support PKCE S256');
    }

    // 3. Client ID (de Dynamic Registration o configurado)
    const clientId = 'my-client-id';  // TO-DO: Dynamic Registration en Fase 5

    // 4. Autorización: Abrir browser y obtener code
    console.log('\nStep 2: Starting authorization flow...');
    const { code, verifier } = await flowManager.authorize({
      serverId: 'my-mcp-server',
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId,
      scopes: metadata.scopes_supported || ['mcp:read', 'mcp:write'],
      resource: mcpServerUrl,
    });

    console.log('Authorization code received');

    // 5. Token Exchange: Intercambiar code por tokens
    console.log('\nStep 3: Exchanging code for tokens...');
    const tokens = await flowManager.exchangeCodeForTokens({
      tokenEndpoint: metadata.token_endpoint,
      code,
      redirectUri: 'http://127.0.0.1:PORT/callback',  // Del loopback server
      clientId,
      codeVerifier: verifier,
    });

    console.log('Tokens received');

    // 6. Guardar tokens
    console.log('\nStep 4: Saving tokens...');
    await tokenStore.saveTokens('my-mcp-server', tokens);

    console.log('\n✅ Successfully connected to OAuth-protected MCP server!');
    console.log('Access Token expires at:', new Date(tokens.expiresAt).toISOString());

    return tokens;
  } catch (error) {
    console.error('\n❌ Connection failed:', error);
    throw error;
  }
}
```

### Uso en Requests HTTP

```typescript
import { OAuthTokenStore } from './services/oauth';

async function makeAuthenticatedRequest(
  serverId: string,
  url: string
): Promise<Response> {
  const tokenStore = new OAuthTokenStore(preferencesService);

  // 1. Obtener tokens
  let tokens = await tokenStore.getTokens(serverId);

  if (!tokens) {
    throw new Error('No tokens found for server');
  }

  // 2. Verificar expiración y refresh si necesario
  if (tokenStore.isTokenExpired(tokens)) {
    console.log('Token expired, refreshing...');

    const flowManager = new OAuthFlowManager();
    const discovery = new OAuthDiscoveryService();

    // Obtener metadata del servidor (desde cache si está disponible)
    const config = await getOAuthConfig(serverId);
    const metadata = await discovery.fetchServerMetadata(config.authServerId);

    // Refresh tokens
    tokens = await flowManager.refreshAccessToken({
      tokenEndpoint: metadata.token_endpoint,
      refreshToken: tokens.refreshToken!,
      clientId: config.clientId,
    });

    // Guardar nuevos tokens
    await tokenStore.saveTokens(serverId, tokens);
  }

  // 3. Hacer request con Authorization header
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  });

  // 4. Manejar 401 (token inválido)
  if (response.status === 401) {
    console.log('Token invalid, attempting refresh...');
    // Repetir flujo de refresh
  }

  return response;
}
```

### Integración con MCP Transports

```typescript
// En transports.ts
import { OAuthTokenStore, OAuthFlowManager } from './services/oauth';

async function createTransport(config: MCPServerConfig) {
  const transportType = config.transport;
  const baseUrl = config.baseUrl;

  // Check if OAuth is enabled
  if (config.oauth?.enabled && isHttpTransport(transportType)) {
    return await createOAuthTransport(config, transportType, baseUrl);
  }

  return createNormalTransport(config, transportType, baseUrl);
}

async function createOAuthTransport(
  config: MCPServerConfig,
  transportType: string,
  baseUrl: string
) {
  const tokenStore = new OAuthTokenStore(preferencesService);

  // Obtener o refresh token
  let tokens = await tokenStore.getTokens(config.id);

  if (!tokens) {
    throw new Error('No OAuth tokens. Please authorize first.');
  }

  if (tokenStore.isTokenExpired(tokens)) {
    tokens = await refreshToken(config.id);
  }

  // Crear transport con Authorization header
  const headers = {
    ...config.headers,
    Authorization: `Bearer ${tokens.accessToken}`,
  };

  switch (transportType) {
    case 'http':
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(baseUrl), {
        requestInit: { headers },
      });

    case 'sse':
      return new SSEClientTransport(new URL(baseUrl), {
        requestInit: { headers },
      });

    default:
      throw new Error(`Unsupported transport for OAuth: ${transportType}`);
  }
}

function isHttpTransport(transport: string): boolean {
  return ['http', 'sse', 'streamable-http'].includes(transport);
}
```

---

## Testing

### Tests Unitarios

#### Fase 1: OAuthTokenStore

**Archivo**: `src/main/services/oauth/__tests__/OAuthTokenStore.test.ts`

**Cobertura**:
- ✅ Encriptación/desencriptación de tokens
- ✅ Guardado y recuperación
- ✅ Verificación de expiración
- ✅ Limpieza de tokens expirados
- ✅ Manejo de errores de encriptación
- ✅ Edge cases (tokens largos, caracteres especiales, unicode)

**Ejecutar**:
```bash
pnpm test src/main/services/oauth/__tests__/OAuthTokenStore.test.ts
```

#### Fase 2: OAuthFlowManager

**Archivo**: `src/main/services/oauth/__tests__/OAuthFlowManager.test.ts`

**Cobertura**:
- ✅ Generación de PKCE
- ✅ Creación de Authorization URLs
- ✅ Token exchange
- ✅ Token refresh
- ✅ Manejo de errores

**Ejecutar**:
```bash
pnpm test src/main/services/oauth/__tests__/OAuthFlowManager.test.ts
```

#### Fase 2: OAuthRedirectServer

**Archivo**: `src/main/services/oauth/__tests__/OAuthRedirectServer.test.ts`

**Cobertura**:
- ✅ Inicio de servidor en puerto aleatorio
- ✅ Handling de callback
- ✅ Timeout
- ✅ Páginas HTML de éxito/error
- ✅ Validación de parámetros

**Ejecutar**:
```bash
pnpm test src/main/services/oauth/__tests__/OAuthRedirectServer.test.ts
```

#### Fase 3: OAuthDiscoveryService

**Archivo**: `src/main/services/oauth/__tests__/OAuthDiscoveryService.test.ts`

**Cobertura**:
- ✅ Discovery de authorization servers
- ✅ Fetching de metadata
- ✅ Parsing de WWW-Authenticate
- ✅ Validación de metadata
- ✅ Cache management
- ✅ Discovery completo

**Ejecutar**:
```bash
pnpm test src/main/services/oauth/__tests__/OAuthDiscoveryService.test.ts
```

#### Tests de Integración

**Archivo**: `src/main/services/oauth/__tests__/oauth-integration.test.ts`

**Cobertura**:
- ✅ Flujo completo de autorización
- ✅ Token refresh
- ✅ PKCE verification
- ✅ Error handling end-to-end

**Ejecutar**:
```bash
pnpm test src/main/services/oauth/__tests__/oauth-integration.test.ts
```

### Ejecutar Todos los Tests

```bash
# Todos los tests de OAuth
pnpm test src/main/services/oauth

# Con UI
pnpm test:ui src/main/services/oauth

# Con coverage
pnpm test --coverage src/main/services/oauth
```

### Test Manual con Mock Server

```typescript
// test-oauth-manual.ts
import {
  OAuthDiscoveryService,
  OAuthFlowManager,
  OAuthTokenStore,
} from './services/oauth';

async function testOAuthFlow() {
  // Mock fetch para simular servidor OAuth
  global.fetch = async (url: string) => {
    if (url.includes('oauth-protected-resource')) {
      return {
        ok: true,
        json: async () => ({
          resource: 'https://mcp.example.com',
          authorization_servers: ['https://auth.example.com'],
        }),
      } as Response;
    }

    if (url.includes('oauth-authorization-server')) {
      return {
        ok: true,
        json: async () => ({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          registration_endpoint: 'https://auth.example.com/register',
        }),
      } as Response;
    }

    if (url.includes('token')) {
      return {
        ok: true,
        json: async () => ({
          access_token: 'mock-access-token',
          refresh_token: 'mock-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as Response;
    }

    return { ok: false, status: 404 } as Response;
  };

  // Test discovery
  const discovery = new OAuthDiscoveryService();
  const result = await discovery.discoverFromUnauthorized(
    'https://mcp.example.com'
  );

  console.log('✅ Discovery successful');
  console.log('   Auth Server:', result.authorizationServer);
  console.log('   Metadata:', result.metadata);

  // Test PKCE
  const flowManager = new OAuthFlowManager();
  const pkce = flowManager.generatePKCE();

  console.log('✅ PKCE generated');
  console.log('   Verifier length:', pkce.verifier.length);
  console.log('   Challenge length:', pkce.challenge.length);

  // Test token exchange (mock)
  const tokens = await flowManager.exchangeCodeForTokens({
    tokenEndpoint: result.metadata.token_endpoint,
    code: 'mock-code',
    redirectUri: 'http://127.0.0.1:8080/callback',
    clientId: 'test-client',
    codeVerifier: pkce.verifier,
  });

  console.log('✅ Token exchange successful');
  console.log('   Access Token:', tokens.accessToken);

  // Test token storage
  const tokenStore = new OAuthTokenStore(preferencesService);
  await tokenStore.saveTokens('test-server', tokens);

  const retrieved = await tokenStore.getTokens('test-server');
  console.log('✅ Tokens stored and retrieved');
  console.log('   Retrieved:', retrieved?.accessToken);

  console.log('\n✅ All manual tests passed!');
}

testOAuthFlow().catch(console.error);
```

---

## Consideraciones de Seguridad

### Almacenamiento de Tokens

- ✅ **Encriptación**: `electron.safeStorage` para todos los tokens
- ✅ **Prefix**: `ENCRYPTED:` para identificar valores encriptados
- ✅ **No logs**: Tokens nunca en logs (solo primeros 8 caracteres para debug)
- ✅ **Separación**: Tokens en sección separada de configuración
- ✅ **Limpieza**: Auto-delete de tokens expirados sin refresh token

### PKCE (Proof Key for Code Exchange)

- ✅ **Método**: S256 obligatorio (SHA-256)
- ✅ **Entropía**: 32 bytes (256 bits) para verifier
- ✅ **One-time use**: Verifier usado solo una vez
- ✅ **Validación**: Server valida challenge contra verifier
- ✅ **Protección**: Previene intercepción de authorization code

### State Parameter

- ✅ **Entropía**: 128 bits mínimo (16 bytes)
- ✅ **Timeout**: 5 minutos máximo
- ✅ **One-time use**: Se elimina tras validación
- ✅ **Validación**: Match exacto requerido
- ✅ **Protección**: Prevenir CSRF attacks

### Redirect URI

- ✅ **Loopback**: Solo 127.0.0.1 (nunca 0.0.0.0)
- ✅ **Puerto**: Aleatorio para evitar ataques de puerto fijo
- ✅ **Protocolo**: HTTP permitido solo para loopback
- ✅ **Path**: `/callback` fijo
- ✅ **Validación**: Exact match con el configurado

### HTTPS Enforcement

- ✅ **Authorization endpoint**: HTTPS obligatorio
- ✅ **Token endpoint**: HTTPS obligatorio
- ✅ **Metadata endpoints**: HTTPS obligatorio
- ⚠️ **Excepción**: Localhost/127.0.0.1 permite HTTP
- ✅ **Validación**: Warnings en logs si HTTP en producción

### Token Audience

- ✅ **Resource parameter**: RFC 8707 support
- ✅ **Validation**: Tokens emitidos para el MCP server específico
- ✅ **No sharing**: Tokens no reutilizados entre servidores
- ✅ **Binding**: Token bound al resource solicitado

### Clock Skew

- ✅ **Buffer**: 60 segundos para expiración
- ✅ **Prevención**: Evita fallos por diferencias de reloj
- ✅ **Conservador**: Mejor expirar antes que usar token inválido

### Secrets en Logs

```typescript
// ❌ MAL - Token completo en logs
logger.debug('Token:', token.accessToken);

// ✅ BIEN - Solo preview
logger.debug('Token:', token.accessToken.substring(0, 8) + '...[REDACTED]');

// ✅ MEJOR - Usar función helper
function sanitizeForLog(token: string): string {
  if (!token || token.length < 16) return '[REDACTED]';
  return `${token.substring(0, 8)}...[REDACTED]`;
}

logger.debug('Token:', sanitizeForLog(token.accessToken));
```

### Browser Security

- ✅ **Sistema**: Usar navegador del sistema (no webview)
- ✅ **URL visible**: Usuario puede ver URL completa
- ✅ **Cancelable**: Usuario puede cancelar en cualquier momento
- ✅ **Warnings**: Advertencias si authorization server no usa HTTPS

### Error Messages

```typescript
// ❌ MAL - Exponer detalles internos
throw new Error(`Token refresh failed with token: ${refreshToken}`);

// ✅ BIEN - Mensaje genérico
throw new Error('Token refresh failed. Re-authorization required.');

// ✅ MEJOR - Con código de error pero sin secrets
throw new OAuthFlowError(
  'Token refresh failed',
  'TOKEN_REFRESH_FAILED',
  { status: response.status }  // No incluir tokens
);
```

---

## Próximos Pasos

### Fase 4: HTTP Client con Auto-Refresh

**Pendiente de implementación**:
- Interceptor para añadir Authorization header
- Detección de 401 Unauthorized
- Auto-refresh de tokens
- Retry automático tras refresh
- Integración con transports de MCP

### Fase 5: Dynamic Client Registration

**Pendiente de implementación**:
- RFC 7591: Dynamic Client Registration Protocol
- Registro automático de Levante como cliente
- Manejo de client credentials
- **TO-DO**: Estrategia de fallback cuando no hay Dynamic Registration

### Fase 6: Revocación y UI

**Pendiente de implementación**:
- RFC 7009: Token Revocation
- UI completa para OAuth connections
- Estado de conexiones OAuth
- Disconnect con revocación

---

## Referencias

### RFCs Implementados

- **[RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)** - OAuth 2.0 Authorization Framework
- **[RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)** - PKCE (Proof Key for Code Exchange)
- **[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)** - OAuth 2.0 for Native Apps
- **[RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414)** - OAuth 2.0 Authorization Server Metadata
- **[RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)** - Resource Indicators for OAuth 2.0
- **[RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728)** - OAuth 2.0 Protected Resource Metadata
- **[OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)** - OAuth 2.1 (PKCE obligatorio)

### MCP Specification

- **[MCP Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)** - MCP OAuth Specification

### Documentación del Proyecto

- **[Plan General](./oauth-implementation-plan.md)** - Plan completo de implementación OAuth
- **[Fase 1](./fase_1_oauth.md)** - Token Store Seguro
- **[Fase 2](./fase_2_oauth.md)** - OAuth Flow con PKCE
- **[Fase 3](./fase_3_oauth.md)** - Discovery Automático

---

## Resumen Ejecutivo

### ¿Qué funciona actualmente?

✅ **Fase 1 (Token Store)**:
- Almacenamiento seguro de tokens con encriptación
- CRUD operations completas
- Verificación de expiración
- Auto-cleanup

✅ **Fase 2 (OAuth Flow)**:
- Authorization Code Flow con PKCE S256
- Loopback HTTP server para callbacks
- State parameter management
- Token exchange y refresh
- Apertura automática de browser

✅ **Fase 3 (Discovery)**:
- RFC 9728: Protected Resource Metadata
- RFC 8414: Authorization Server Metadata
- WWW-Authenticate header parsing
- Cache de metadata con TTL
- Validación completa

### ¿Qué falta?

❌ **Fase 4 (HTTP Client)**:
- Auto-refresh en requests
- 401 handling automático
- Integración con MCP transports

❌ **Fase 5 (Dynamic Registration)**:
- RFC 7591 implementation
- Estrategia de fallback

❌ **Fase 6 (UI y Revocación)**:
- UI components
- Token revocation
- Connection management

### Uso Típico

```typescript
// 1. Discovery
const discovery = new OAuthDiscoveryService();
const { metadata } = await discovery.discoverFromUnauthorized(mcpServerUrl);

// 2. Authorization
const flowManager = new OAuthFlowManager();
const { code, verifier } = await flowManager.authorize({
  serverId: 'my-server',
  authorizationEndpoint: metadata.authorization_endpoint,
  clientId: 'my-client',
  scopes: ['mcp:read', 'mcp:write'],
});

// 3. Token Exchange
const tokens = await flowManager.exchangeCodeForTokens({
  tokenEndpoint: metadata.token_endpoint,
  code,
  codeVerifier: verifier,
  clientId: 'my-client',
  redirectUri: 'http://127.0.0.1:PORT/callback',
});

// 4. Save Tokens
const tokenStore = new OAuthTokenStore(preferencesService);
await tokenStore.saveTokens('my-server', tokens);

// 5. Use in Requests
const validTokens = await tokenStore.getTokens('my-server');
if (validTokens && tokenStore.isTokenExpired(validTokens)) {
  // Refresh logic
}
```

---

**Última actualización**: 2025-12-21
**Versión**: 1.0
**Autor**: Arquitectura Levante
