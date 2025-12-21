import type { UIPreferences } from '../../../types/preferences';

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
export interface UIPreferencesWithOAuth extends UIPreferences {
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
