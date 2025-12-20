/**
 * Widgets Module
 *
 * Provides widget utilities for MCP tools.
 * - HTML data injection for server-provided templates
 * - OpenAI Apps SDK bridge for ChatGPT compatibility
 *
 * Note: Widget HTML content should be provided by MCP servers, not generated client-side.
 * This module only provides utilities to enhance server-provided HTML.
 */

// HTML utilities
export { escapeHtml, injectDataIntoHtml } from './htmlUtils';

// OpenAI Apps SDK bridge injection
export { injectAppsSdkBridge } from './appsSdkBridge';
export type { AppsSdkBridgeOptions } from './appsSdkBridge';
