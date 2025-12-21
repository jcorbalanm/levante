# Fase 1: Token Store Seguro - Plan de Implementación Detallado

## Información del Documento

- **Fase**: 1 - Token Store Seguro
- **Fecha**: 2025-12-21
- **Estado**: Listo para implementación
- **Duración estimada**: 1-2 semanas
- **Autor**: Arquitectura Levante

## Índice

1. [Objetivos de la Fase 1](#objetivos-de-la-fase-1)
2. [Arquitectura y Decisiones](#arquitectura-y-decisiones)
3. [Estructura de Archivos](#estructura-de-archivos)
4. [Plan de Implementación Paso a Paso](#plan-de-implementación-paso-a-paso)
5. [Testing](#testing)
6. [Validación Final](#validación-final)

---

## Objetivos de la Fase 1

### Objetivos Principales

1. ✅ Implementar almacenamiento seguro de tokens OAuth
2. ✅ Extender PreferencesService para manejar tokens encriptados
3. ✅ Implementar operaciones CRUD para tokens por servidor MCP
4. ✅ Validar encriptación con `electron.safeStorage`

### Alcance

**Incluye:**
- Tipos TypeScript para OAuth tokens
- OAuthTokenStore con encriptación/desencriptación
- Extensión del schema de ui-preferences.json
- Tests unitarios completos
- Migración de configuración si es necesario

**No incluye:**
- OAuth flow (Fase 2)
- Discovery de authorization servers (Fase 3)
- Integración con HTTP clients (Fase 4)
- UI components (Fase 6)

---

## Arquitectura y Decisiones

### Estructura de Almacenamiento

Los tokens OAuth se almacenarán en `~/levante/ui-preferences.json` con la siguiente estructura:

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

### Encriptación

- **Método**: `electron.safeStorage` (Keychain en macOS, DPAPI en Windows, libsecret en Linux)
- **Campos encriptados**: `accessToken`, `refreshToken`, `clientSecret` (si existe)
- **Formato**: Prefix `ENCRYPTED:` + base64 encoded encrypted data
- **Seguridad**: Tokens nunca en logs, nunca en plaintext en disco

---

## Estructura de Archivos

### Nuevos Archivos a Crear

```
src/main/services/oauth/
├── index.ts                          # Exports públicos
├── types.ts                          # TypeScript interfaces y types
├── OAuthTokenStore.ts                # Token storage con encriptación
└── __tests__/
    └── OAuthTokenStore.test.ts       # Unit tests
```

### Archivos a Modificar

```
src/main/services/preferences/
└── PreferencesService.ts             # Extensión para soportar nueva estructura
```

---

## Plan de Implementación Paso a Paso

### Paso 1: Crear Tipos TypeScript

**Archivo**: `src/main/services/oauth/types.ts`

```typescript
/**
 * OAuth Token Types
 *
 * Tipos para almacenamiento seguro de tokens OAuth 2.1
 * Compatible con Authorization Code Flow + PKCE
 */

/**
 * OAuth tokens obtenidos del Authorization Server
 */
export interface OAuthTokens {
  /** Access token (JWT o opaque) */
  accessToken: string;

  /** Refresh token para renovar access token */
  refreshToken?: string;

  /** Timestamp de expiración del access token (milliseconds desde epoch) */
  expiresAt: number;

  /** Tipo de token (siempre "Bearer" para OAuth 2.1) */
  tokenType: 'Bearer';

  /** Scopes concedidos (puede diferir de los solicitados) */
  scope?: string;
}

/**
 * OAuth tokens almacenados (con encriptación)
 */
export interface StoredOAuthTokens {
  /** Access token encriptado */
  accessToken: string;

  /** Refresh token encriptado (opcional) */
  refreshToken?: string;

  /** Timestamp de expiración (no encriptado para validación rápida) */
  expiresAt: number;

  /** Tipo de token */
  tokenType: 'Bearer';

  /** Scopes concedidos */
  scope?: string;

  /** Timestamp de cuando se emitió el token */
  issuedAt: number;
}

/**
 * Configuración OAuth para un servidor MCP
 */
export interface OAuthConfig {
  /** OAuth habilitado para este servidor */
  enabled: boolean;

  /** URL del Authorization Server */
  authServerId?: string;

  /** Client ID registrado */
  clientId?: string;

  /** Client Secret (solo para confidential clients) */
  clientSecret?: string;

  /** Scopes a solicitar */
  scopes?: string[];

  /** Redirect URI configurado */
  redirectUri?: string;
}

/**
 * Extensión de MCPServerConfig para incluir OAuth
 */
export interface MCPServerConfigWithOAuth {
  id: string;
  transport: 'http' | 'sse' | 'streamable-http' | 'stdio';
  baseUrl?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;

  /** Configuración OAuth (opcional) */
  oauth?: OAuthConfig;
}

/**
 * Estructura de preferencias extendida con OAuth
 */
export interface UIPreferencesWithOAuth {
  // ... campos existentes de UIPreferences ...

  /** Configuración de servidores MCP con OAuth */
  mcpServers?: {
    [serverId: string]: MCPServerConfigWithOAuth;
  };

  /** Tokens OAuth almacenados (encriptados) */
  oauthTokens?: {
    [serverId: string]: StoredOAuthTokens;
  };
}

/**
 * Errores relacionados con OAuth Token Store
 */
export class OAuthTokenStoreError extends Error {
  constructor(
    message: string,
    public readonly code: 'ENCRYPTION_FAILED' | 'DECRYPTION_FAILED' | 'NOT_FOUND' | 'INVALID_FORMAT',
    public readonly serverId?: string
  ) {
    super(message);
    this.name = 'OAuthTokenStoreError';
  }
}
```

---

### Paso 2: Implementar OAuthTokenStore

**Archivo**: `src/main/services/oauth/OAuthTokenStore.ts`

```typescript
import { safeStorage } from 'electron';
import { getLogger } from '../logging';
import type { PreferencesService } from '../preferences/PreferencesService';
import type {
  OAuthTokens,
  StoredOAuthTokens,
  OAuthTokenStoreError,
} from './types';
import { OAuthTokenStoreError as TokenStoreError } from './types';

/**
 * OAuthTokenStore
 *
 * Gestión segura de tokens OAuth con encriptación automática
 * usando electron.safeStorage (Keychain/DPAPI/libsecret)
 */
export class OAuthTokenStore {
  private logger = getLogger();
  private readonly ENCRYPTED_PREFIX = 'ENCRYPTED:';

  constructor(private preferencesService: PreferencesService) {}

  /**
   * Encripta un valor usando safeStorage de Electron
   */
  private encrypt(value: string): string {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        this.logger.core.warn('Encryption not available, storing in plaintext');
        throw new TokenStoreError(
          'Encryption not available on this system',
          'ENCRYPTION_FAILED'
        );
      }

      const encrypted = safeStorage.encryptString(value);
      const base64 = encrypted.toString('base64');

      return `${this.ENCRYPTED_PREFIX}${base64}`;
    } catch (error) {
      this.logger.core.error('Failed to encrypt token', {
        error: error instanceof Error ? error.message : error,
      });
      throw new TokenStoreError(
        'Failed to encrypt token',
        'ENCRYPTION_FAILED'
      );
    }
  }

  /**
   * Desencripta un valor previamente encriptado
   */
  private decrypt(encrypted: string): string {
    try {
      if (!encrypted.startsWith(this.ENCRYPTED_PREFIX)) {
        throw new TokenStoreError(
          'Invalid encrypted format - missing ENCRYPTED: prefix',
          'INVALID_FORMAT'
        );
      }

      const base64Data = encrypted.replace(this.ENCRYPTED_PREFIX, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const decrypted = safeStorage.decryptString(buffer);
      return decrypted;
    } catch (error) {
      this.logger.core.error('Failed to decrypt token', {
        error: error instanceof Error ? error.message : error,
      });
      throw new TokenStoreError(
        'Failed to decrypt token',
        'DECRYPTION_FAILED'
      );
    }
  }

  /**
   * Guarda tokens OAuth para un servidor específico
   * Los tokens se encriptan automáticamente antes de guardar
   */
  async saveTokens(serverId: string, tokens: OAuthTokens): Promise<void> {
    try {
      this.logger.core.info('Saving OAuth tokens', { serverId });

      // Encriptar tokens sensibles
      const stored: StoredOAuthTokens = {
        accessToken: this.encrypt(tokens.accessToken),
        refreshToken: tokens.refreshToken
          ? this.encrypt(tokens.refreshToken)
          : undefined,
        expiresAt: tokens.expiresAt,
        tokenType: tokens.tokenType,
        scope: tokens.scope,
        issuedAt: Date.now(),
      };

      // Guardar en preferences
      await this.preferencesService.set(`oauthTokens.${serverId}`, stored);

      this.logger.core.debug('OAuth tokens saved successfully', {
        serverId,
        hasRefreshToken: !!tokens.refreshToken,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
      });
    } catch (error) {
      this.logger.core.error('Failed to save OAuth tokens', {
        serverId,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Obtiene tokens OAuth para un servidor específico
   * Los tokens se desencriptan automáticamente
   */
  async getTokens(serverId: string): Promise<OAuthTokens | null> {
    try {
      const stored = await this.preferencesService.get<StoredOAuthTokens>(
        `oauthTokens.${serverId}`
      );

      if (!stored) {
        this.logger.core.debug('No OAuth tokens found', { serverId });
        return null;
      }

      // Desencriptar tokens
      const tokens: OAuthTokens = {
        accessToken: this.decrypt(stored.accessToken),
        refreshToken: stored.refreshToken
          ? this.decrypt(stored.refreshToken)
          : undefined,
        expiresAt: stored.expiresAt,
        tokenType: stored.tokenType,
        scope: stored.scope,
      };

      this.logger.core.debug('OAuth tokens retrieved', {
        serverId,
        hasRefreshToken: !!tokens.refreshToken,
        isExpired: this.isTokenExpired(tokens),
      });

      return tokens;
    } catch (error) {
      if (error instanceof TokenStoreError) {
        throw error;
      }

      this.logger.core.error('Failed to get OAuth tokens', {
        serverId,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Elimina tokens OAuth para un servidor específico
   */
  async deleteTokens(serverId: string): Promise<void> {
    try {
      this.logger.core.info('Deleting OAuth tokens', { serverId });

      // Obtener todas las preferencias
      const allPrefs = await this.preferencesService.getAll();

      // Eliminar tokens del servidor
      if (allPrefs.oauthTokens && allPrefs.oauthTokens[serverId]) {
        delete allPrefs.oauthTokens[serverId];
        await this.preferencesService.set('oauthTokens', allPrefs.oauthTokens);
      }

      this.logger.core.debug('OAuth tokens deleted', { serverId });
    } catch (error) {
      this.logger.core.error('Failed to delete OAuth tokens', {
        serverId,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Verifica si un token está expirado
   * Incluye buffer de 60 segundos para clock skew
   */
  isTokenExpired(tokens: OAuthTokens): boolean {
    const CLOCK_SKEW_BUFFER = 60000; // 60 seconds
    const now = Date.now();
    const expiresWithBuffer = tokens.expiresAt - CLOCK_SKEW_BUFFER;

    const expired = now >= expiresWithBuffer;

    if (expired) {
      this.logger.core.debug('Token expired', {
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        now: new Date(now).toISOString(),
        secondsUntilExpiry: Math.floor((tokens.expiresAt - now) / 1000),
      });
    }

    return expired;
  }

  /**
   * Obtiene todos los servidores con tokens OAuth almacenados
   */
  async getAllTokenizedServers(): Promise<string[]> {
    try {
      const allPrefs = await this.preferencesService.getAll();
      const tokens = allPrefs.oauthTokens || {};
      return Object.keys(tokens);
    } catch (error) {
      this.logger.core.error('Failed to get tokenized servers', {
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  }

  /**
   * Limpia tokens expirados de todos los servidores
   * Útil para mantenimiento y limpieza periódica
   */
  async cleanExpiredTokens(): Promise<number> {
    try {
      this.logger.core.info('Cleaning expired OAuth tokens');

      const serverIds = await this.getAllTokenizedServers();
      let cleanedCount = 0;

      for (const serverId of serverIds) {
        const tokens = await this.getTokens(serverId);

        if (tokens && this.isTokenExpired(tokens) && !tokens.refreshToken) {
          // Solo eliminar si no tiene refresh token
          await this.deleteTokens(serverId);
          cleanedCount++;
        }
      }

      this.logger.core.info('Expired tokens cleaned', { count: cleanedCount });
      return cleanedCount;
    } catch (error) {
      this.logger.core.error('Failed to clean expired tokens', {
        error: error instanceof Error ? error.message : error,
      });
      return 0;
    }
  }

  /**
   * Verifica si safeStorage está disponible en el sistema
   */
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }
}
```

---

### Paso 3: Crear Index para Exports

**Archivo**: `src/main/services/oauth/index.ts`

```typescript
/**
 * OAuth Services
 *
 * Fase 1: Token Store Seguro
 */

export { OAuthTokenStore } from './OAuthTokenStore';
export type {
  OAuthTokens,
  StoredOAuthTokens,
  OAuthConfig,
  MCPServerConfigWithOAuth,
  UIPreferencesWithOAuth,
} from './types';
export { OAuthTokenStoreError } from './types';
```

---

### Paso 4: Extender PreferencesService

**Archivo a modificar**: `src/main/services/preferences/PreferencesService.ts`

**Cambios necesarios:**

1. Importar tipos de OAuth:

```typescript
import type { UIPreferencesWithOAuth } from '../oauth/types';
```

2. Actualizar el tipo de retorno de `getAll()` para incluir `oauthTokens`:

```typescript
async getAll(): Promise<UIPreferencesWithOAuth> {
  await this.ensureInitialized();
  const data = this.store.store;

  // Asegurar que la estructura incluye oauthTokens
  return {
    ...data,
    oauthTokens: data.oauthTokens || {},
  } as UIPreferencesWithOAuth;
}
```

3. No es necesario modificar `set()` ya que soporta paths anidados (`oauthTokens.serverId`)

**Archivo completo modificado**: `src/main/services/preferences/PreferencesService.ts`

```typescript
import Store from 'electron-store';
import { app, safeStorage } from 'electron';
import path from 'path';
import { getLogger } from '../logging';
import type { UIPreferencesWithOAuth } from '../oauth/types';

interface EncryptedValue {
  encrypted: boolean;
  value: string;
}

/**
 * PreferencesService
 * Gestiona preferencias de UI con encriptación selectiva de valores sensibles
 */
export class PreferencesService {
  private store: Store<Record<string, any>>;
  private logger = getLogger();
  private initialized = false;

  constructor() {
    const userDataPath = app.getPath('userData');
    const storePath = path.join(userDataPath, 'ui-preferences.json');

    this.store = new Store({
      name: 'ui-preferences',
      cwd: userDataPath,
      encryptionKey: undefined,
      clearInvalidConfig: false,
    });

    this.logger.preferences.debug('PreferencesService initialized', {
      path: storePath,
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure oauthTokens exists
    const current = this.store.store;
    if (!current.oauthTokens) {
      this.store.set('oauthTokens', {});
    }

    this.initialized = true;
    this.logger.preferences.info('PreferencesService initialized');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Obtiene todas las preferencias
   */
  async getAll(): Promise<UIPreferencesWithOAuth> {
    await this.ensureInitialized();
    const data = this.store.store;

    return {
      ...data,
      oauthTokens: data.oauthTokens || {},
    } as UIPreferencesWithOAuth;
  }

  /**
   * Obtiene un valor específico por path
   * Soporta paths anidados: "oauthTokens.serverId"
   */
  async get<T = any>(key: string): Promise<T | undefined> {
    await this.ensureInitialized();

    this.logger.preferences.debug('Getting preference', { key });
    const value = this.store.get(key) as T | undefined;

    return value;
  }

  /**
   * Guarda un valor en las preferencias
   * Soporta paths anidados: "oauthTokens.serverId"
   */
  async set(key: string, value: any): Promise<void> {
    await this.ensureInitialized();

    this.logger.preferences.debug('Setting preference', { key });
    this.store.set(key, value);
  }

  /**
   * Elimina un valor de las preferencias
   */
  async delete(key: string): Promise<void> {
    await this.ensureInitialized();

    this.logger.preferences.debug('Deleting preference', { key });
    this.store.delete(key);
  }

  /**
   * Limpia todas las preferencias
   */
  async clear(): Promise<void> {
    await this.ensureInitialized();

    this.logger.preferences.warn('Clearing all preferences');
    this.store.clear();

    // Reinicializar estructura básica
    this.store.set('oauthTokens', {});
  }

  /**
   * Verifica si existe una clave
   */
  async has(key: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.store.has(key);
  }
}
```

---

### Paso 5: Crear Tests Unitarios

**Archivo**: `src/main/services/oauth/__tests__/OAuthTokenStore.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { safeStorage } from 'electron';
import { OAuthTokenStore } from '../OAuthTokenStore';
import { OAuthTokenStoreError } from '../types';
import type { OAuthTokens } from '../types';
import type { PreferencesService } from '../../preferences/PreferencesService';

// Mock electron
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((str: string) => Buffer.from(str, 'utf8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf8')),
  },
}));

// Mock logger
vi.mock('../../logging', () => ({
  getLogger: () => ({
    core: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }),
}));

// Mock PreferencesService
class MockPreferencesService {
  private store: Record<string, any> = {};

  async get<T>(key: string): Promise<T | undefined> {
    const keys = key.split('.');
    let value: any = this.store;

    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) return undefined;
    }

    return value as T;
  }

  async set(key: string, value: any): Promise<void> {
    const keys = key.split('.');
    const lastKey = keys.pop()!;
    let target: any = this.store;

    for (const k of keys) {
      if (!target[k]) target[k] = {};
      target = target[k];
    }

    target[lastKey] = value;
  }

  async getAll(): Promise<any> {
    return this.store;
  }

  reset(): void {
    this.store = {};
  }
}

describe('OAuthTokenStore', () => {
  let tokenStore: OAuthTokenStore;
  let mockPreferences: MockPreferencesService;

  const createMockTokens = (expiresIn = 3600): OAuthTokens => ({
    accessToken: 'test-access-token-123',
    refreshToken: 'test-refresh-token-456',
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: 'Bearer',
    scope: 'mcp:read mcp:write',
  });

  beforeEach(() => {
    mockPreferences = new MockPreferencesService();
    tokenStore = new OAuthTokenStore(mockPreferences as any as PreferencesService);
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockPreferences.reset();
  });

  describe('saveTokens', () => {
    it('should encrypt and save tokens', async () => {
      const serverId = 'test-server-1';
      const tokens = createMockTokens();

      await tokenStore.saveTokens(serverId, tokens);

      const stored = await mockPreferences.get(`oauthTokens.${serverId}`);
      expect(stored).toBeDefined();
      expect((stored as any).accessToken).toMatch(/^ENCRYPTED:/);
      expect((stored as any).refreshToken).toMatch(/^ENCRYPTED:/);
      expect((stored as any).expiresAt).toBe(tokens.expiresAt);
      expect((stored as any).tokenType).toBe('Bearer');
    });

    it('should save tokens without refresh token', async () => {
      const serverId = 'test-server-2';
      const tokens: OAuthTokens = {
        accessToken: 'test-access-token',
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens(serverId, tokens);

      const stored = await mockPreferences.get(`oauthTokens.${serverId}`);
      expect(stored).toBeDefined();
      expect((stored as any).refreshToken).toBeUndefined();
    });

    it('should include issuedAt timestamp', async () => {
      const serverId = 'test-server-3';
      const tokens = createMockTokens();
      const beforeSave = Date.now();

      await tokenStore.saveTokens(serverId, tokens);

      const stored = await mockPreferences.get(`oauthTokens.${serverId}`);
      const afterSave = Date.now();

      expect((stored as any).issuedAt).toBeGreaterThanOrEqual(beforeSave);
      expect((stored as any).issuedAt).toBeLessThanOrEqual(afterSave);
    });
  });

  describe('getTokens', () => {
    it('should decrypt and return tokens', async () => {
      const serverId = 'test-server-4';
      const originalTokens = createMockTokens();

      await tokenStore.saveTokens(serverId, originalTokens);
      const retrieved = await tokenStore.getTokens(serverId);

      expect(retrieved).toBeDefined();
      expect(retrieved!.accessToken).toBe(originalTokens.accessToken);
      expect(retrieved!.refreshToken).toBe(originalTokens.refreshToken);
      expect(retrieved!.expiresAt).toBe(originalTokens.expiresAt);
      expect(retrieved!.tokenType).toBe('Bearer');
    });

    it('should return null if tokens do not exist', async () => {
      const serverId = 'non-existent-server';
      const tokens = await tokenStore.getTokens(serverId);

      expect(tokens).toBeNull();
    });

    it('should handle tokens without refresh token', async () => {
      const serverId = 'test-server-5';
      const originalTokens: OAuthTokens = {
        accessToken: 'test-access-token',
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens(serverId, originalTokens);
      const retrieved = await tokenStore.getTokens(serverId);

      expect(retrieved).toBeDefined();
      expect(retrieved!.refreshToken).toBeUndefined();
    });
  });

  describe('deleteTokens', () => {
    it('should delete tokens for a server', async () => {
      const serverId = 'test-server-6';
      const tokens = createMockTokens();

      await tokenStore.saveTokens(serverId, tokens);

      // Verify tokens exist
      let retrieved = await tokenStore.getTokens(serverId);
      expect(retrieved).toBeDefined();

      // Delete tokens
      await tokenStore.deleteTokens(serverId);

      // Verify tokens are gone
      retrieved = await tokenStore.getTokens(serverId);
      expect(retrieved).toBeNull();
    });

    it('should not throw if deleting non-existent tokens', async () => {
      const serverId = 'non-existent-server';

      await expect(tokenStore.deleteTokens(serverId)).resolves.not.toThrow();
    });
  });

  describe('isTokenExpired', () => {
    it('should return false for valid tokens', () => {
      const tokens = createMockTokens(3600); // 1 hour from now
      expect(tokenStore.isTokenExpired(tokens)).toBe(false);
    });

    it('should return true for expired tokens', () => {
      const tokens = createMockTokens(-10); // 10 seconds ago
      expect(tokenStore.isTokenExpired(tokens)).toBe(true);
    });

    it('should include 60 second buffer for clock skew', () => {
      const tokens = createMockTokens(30); // 30 seconds from now
      // Should be considered expired due to 60 second buffer
      expect(tokenStore.isTokenExpired(tokens)).toBe(true);
    });

    it('should handle tokens expiring exactly now', () => {
      const tokens: OAuthTokens = {
        accessToken: 'test',
        expiresAt: Date.now(),
        tokenType: 'Bearer',
      };
      expect(tokenStore.isTokenExpired(tokens)).toBe(true);
    });
  });

  describe('getAllTokenizedServers', () => {
    it('should return list of servers with tokens', async () => {
      await tokenStore.saveTokens('server-1', createMockTokens());
      await tokenStore.saveTokens('server-2', createMockTokens());
      await tokenStore.saveTokens('server-3', createMockTokens());

      const servers = await tokenStore.getAllTokenizedServers();

      expect(servers).toHaveLength(3);
      expect(servers).toContain('server-1');
      expect(servers).toContain('server-2');
      expect(servers).toContain('server-3');
    });

    it('should return empty array if no tokens exist', async () => {
      const servers = await tokenStore.getAllTokenizedServers();
      expect(servers).toEqual([]);
    });
  });

  describe('cleanExpiredTokens', () => {
    it('should remove expired tokens without refresh token', async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: 'expired',
        expiresAt: Date.now() - 10000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens('expired-server', expiredTokens);
      await tokenStore.saveTokens('valid-server', createMockTokens(3600));

      const cleanedCount = await tokenStore.cleanExpiredTokens();

      expect(cleanedCount).toBe(1);

      const expiredRetrieved = await tokenStore.getTokens('expired-server');
      const validRetrieved = await tokenStore.getTokens('valid-server');

      expect(expiredRetrieved).toBeNull();
      expect(validRetrieved).toBeDefined();
    });

    it('should keep expired tokens with refresh token', async () => {
      const expiredWithRefresh: OAuthTokens = {
        accessToken: 'expired',
        refreshToken: 'can-refresh',
        expiresAt: Date.now() - 10000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens('expired-but-refreshable', expiredWithRefresh);

      const cleanedCount = await tokenStore.cleanExpiredTokens();

      expect(cleanedCount).toBe(0);

      const retrieved = await tokenStore.getTokens('expired-but-refreshable');
      expect(retrieved).toBeDefined();
    });

    it('should return 0 if no expired tokens', async () => {
      await tokenStore.saveTokens('server-1', createMockTokens(3600));
      await tokenStore.saveTokens('server-2', createMockTokens(7200));

      const cleanedCount = await tokenStore.cleanExpiredTokens();
      expect(cleanedCount).toBe(0);
    });
  });

  describe('isEncryptionAvailable', () => {
    it('should return true when safeStorage is available', () => {
      expect(tokenStore.isEncryptionAvailable()).toBe(true);
    });

    it('should return false when safeStorage is not available', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false);
      expect(tokenStore.isEncryptionAvailable()).toBe(false);
    });
  });

  describe('encryption errors', () => {
    it('should throw when encryption is not available', async () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false);

      const serverId = 'test-server';
      const tokens = createMockTokens();

      await expect(tokenStore.saveTokens(serverId, tokens)).rejects.toThrow(
        OAuthTokenStoreError
      );
    });

    it('should throw on invalid encrypted format during decryption', async () => {
      const serverId = 'test-server';

      // Manually insert invalid encrypted data
      await mockPreferences.set(`oauthTokens.${serverId}`, {
        accessToken: 'INVALID_NO_PREFIX',
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
      });

      await expect(tokenStore.getTokens(serverId)).rejects.toThrow(
        OAuthTokenStoreError
      );
    });
  });

  describe('edge cases', () => {
    it('should handle very long tokens', async () => {
      const longToken = 'a'.repeat(10000);
      const tokens: OAuthTokens = {
        accessToken: longToken,
        refreshToken: longToken,
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens('long-token-server', tokens);
      const retrieved = await tokenStore.getTokens('long-token-server');

      expect(retrieved!.accessToken).toBe(longToken);
      expect(retrieved!.refreshToken).toBe(longToken);
    });

    it('should handle special characters in tokens', async () => {
      const specialToken = '!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      const tokens: OAuthTokens = {
        accessToken: specialToken,
        refreshToken: specialToken,
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens('special-char-server', tokens);
      const retrieved = await tokenStore.getTokens('special-char-server');

      expect(retrieved!.accessToken).toBe(specialToken);
      expect(retrieved!.refreshToken).toBe(specialToken);
    });

    it('should handle unicode tokens', async () => {
      const unicodeToken = '你好世界🌍🚀';
      const tokens: OAuthTokens = {
        accessToken: unicodeToken,
        expiresAt: Date.now() + 3600000,
        tokenType: 'Bearer',
      };

      await tokenStore.saveTokens('unicode-server', tokens);
      const retrieved = await tokenStore.getTokens('unicode-server');

      expect(retrieved!.accessToken).toBe(unicodeToken);
    });
  });
});
```

---

### Paso 6: Configurar Path de Tests

Asegurar que Vitest pueda encontrar los tests de OAuth.

**Archivo a verificar**: `vitest.config.ts`

Asegurar que incluye:

```typescript
export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
    ],
    // ... resto de configuración
  },
});
```

---

## Testing

### Ejecutar Tests

```bash
# Ejecutar todos los tests
pnpm test

# Ejecutar solo tests de OAuth
pnpm test src/main/services/oauth

# Ejecutar tests con UI
pnpm test:ui

# Ejecutar tests en modo watch
pnpm test --watch
```

### Cobertura Esperada

**Objetivo**: 70% de cobertura de código para OAuthTokenStore

**Casos cubiertos**:
- ✅ Encriptación y desencriptación de tokens
- ✅ Guardado y recuperación de tokens
- ✅ Eliminación de tokens
- ✅ Verificación de expiración
- ✅ Limpieza de tokens expirados
- ✅ Manejo de errores de encriptación
- ✅ Edge cases (tokens largos, caracteres especiales, unicode)
- ✅ Tokens sin refresh token
- ✅ Servidores no existentes

---

## Validación Final

### Checklist de Implementación

- [ ] **Tipos TypeScript creados** (`oauth/types.ts`)
- [ ] **OAuthTokenStore implementado** (`oauth/OAuthTokenStore.ts`)
- [ ] **Index exports configurado** (`oauth/index.ts`)
- [ ] **PreferencesService extendido** para soportar `oauthTokens`
- [ ] **Tests unitarios pasando** (70%+ cobertura)
- [ ] **Encriptación funcionando** con `safeStorage`
- [ ] **No hay warnings de TypeScript**
- [ ] **Logging configurado** correctamente

### Validación Manual

```typescript
// Script de validación manual (ejecutar en main process)
import { OAuthTokenStore } from './services/oauth';
import { PreferencesService } from './services/preferences/PreferencesService';

async function testOAuthTokenStore() {
  const prefs = new PreferencesService();
  await prefs.initialize();

  const tokenStore = new OAuthTokenStore(prefs);

  // 1. Verificar que encriptación está disponible
  console.log('Encryption available:', tokenStore.isEncryptionAvailable());

  // 2. Guardar tokens de prueba
  const testTokens = {
    accessToken: 'test-access-token-12345',
    refreshToken: 'test-refresh-token-67890',
    expiresAt: Date.now() + 3600000,
    tokenType: 'Bearer' as const,
    scope: 'mcp:read mcp:write',
  };

  await tokenStore.saveTokens('test-server-1', testTokens);
  console.log('✅ Tokens saved');

  // 3. Recuperar tokens
  const retrieved = await tokenStore.getTokens('test-server-1');
  console.log('✅ Tokens retrieved:', {
    accessToken: retrieved?.accessToken.substring(0, 10) + '...',
    hasRefreshToken: !!retrieved?.refreshToken,
    expiresAt: new Date(retrieved?.expiresAt || 0).toISOString(),
  });

  // 4. Verificar expiración
  const isExpired = tokenStore.isTokenExpired(retrieved!);
  console.log('✅ Token expired:', isExpired);

  // 5. Verificar encriptación en disco
  const allPrefs = await prefs.getAll();
  const storedToken = allPrefs.oauthTokens?.['test-server-1'];
  console.log('✅ Stored token is encrypted:',
    storedToken?.accessToken.startsWith('ENCRYPTED:')
  );

  // 6. Limpiar
  await tokenStore.deleteTokens('test-server-1');
  console.log('✅ Tokens deleted');

  const afterDelete = await tokenStore.getTokens('test-server-1');
  console.log('✅ Tokens are null after delete:', afterDelete === null);

  console.log('\n🎉 All validations passed!');
}

testOAuthTokenStore().catch(console.error);
```

### Verificación en Producción

**Ubicación del archivo**: `~/levante/ui-preferences.json`

**Estructura esperada**:
```json
{
  "oauthTokens": {
    "test-server-1": {
      "accessToken": "ENCRYPTED:SGVsbG8gV29ybGQ=...",
      "refreshToken": "ENCRYPTED:UmVmcmVzaCBUb2tlbg==...",
      "expiresAt": 1703980800000,
      "tokenType": "Bearer",
      "scope": "mcp:read mcp:write",
      "issuedAt": 1703977200000
    }
  }
}
```

**Verificaciones**:
1. ✅ Archivo `ui-preferences.json` existe
2. ✅ Sección `oauthTokens` existe
3. ✅ Tokens tienen prefix `ENCRYPTED:`
4. ✅ No hay tokens en plaintext
5. ✅ Formato JSON es válido

---

## Próximos Pasos

Una vez completada la Fase 1:

1. **Validar implementación** con checklist
2. **Ejecutar tests** y verificar cobertura
3. **Revisión de código** del equipo
4. **Merge a rama principal**
5. **Iniciar Fase 2**: OAuth Flow con PKCE

---

## Notas de Implementación

### Seguridad

- ⚠️ **Nunca loggear tokens completos** - solo primeros 8 caracteres
- ⚠️ **Validar safeStorage availability** antes de usar
- ⚠️ **60 segundos de buffer** para clock skew en expiración
- ⚠️ **Prefix ENCRYPTED:** obligatorio para valores encriptados

### Performance

- Token store es **síncrono después de inicialización**
- Cache de encryption availability
- Operaciones batch para limpieza

### Compatibilidad

- ✅ macOS: Keychain
- ✅ Windows: DPAPI
- ✅ Linux: libsecret (requiere instalación del usuario)

---

**Fin del Plan de Fase 1**

*Última actualización: 2025-12-21*
*Versión: 1.0*
