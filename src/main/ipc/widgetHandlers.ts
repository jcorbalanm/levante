/**
 * Widget Proxy IPC Handlers Module
 *
 * Handles IPC communication for the widget HTTP proxy:
 * - Store widget HTML content and get proxy URL
 * - Remove widget content when no longer needed
 * - Get proxy server info (port, secret)
 */

import { ipcMain, IpcMainInvokeEvent } from "electron";
import { getLogger } from "../services/logging";
import { widgetProxyService } from "../services/widgetProxy";

const logger = getLogger();

/**
 * Register all widget proxy IPC handlers
 */
export function setupWidgetHandlers(): void {
  // Store widget content and get proxy URL
  ipcMain.handle("levante/widget/store", handleStoreWidget);

  // Remove widget content
  ipcMain.handle("levante/widget/remove", handleRemoveWidget);

  // Get proxy server info
  ipcMain.handle("levante/widget/getProxyInfo", handleGetProxyInfo);

  logger.core.info("Widget handlers registered successfully");
}

/**
 * Store widget HTML content and return proxy URL
 * @param html - HTML content to store
 * @param baseUrl - Optional base URL for resolving relative paths (extracted from resource URI)
 */
function handleStoreWidget(
  _event: IpcMainInvokeEvent,
  html: string,
  baseUrl?: string
): { success: boolean; url?: string; widgetId?: string; error?: string } {
  try {
    const port = widgetProxyService.getPort();
    if (!port) {
      return {
        success: false,
        error: "Widget proxy server not running",
      };
    }

    const widgetId = widgetProxyService.generateId();
    const url = widgetProxyService.store(widgetId, html, baseUrl);

    logger.mcp.debug("Widget content stored via IPC", {
      widgetId,
      url,
      size: html.length,
      baseUrl,
    });

    return { success: true, url, widgetId };
  } catch (error) {
    logger.mcp.error("Error storing widget content", {
      error: error instanceof Error ? error.message : error,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Remove widget content from store
 */
function handleRemoveWidget(
  _event: IpcMainInvokeEvent,
  widgetId: string
): { success: boolean; error?: string } {
  try {
    widgetProxyService.remove(widgetId);
    logger.mcp.debug("Widget content removed via IPC", { widgetId });
    return { success: true };
  } catch (error) {
    logger.mcp.error("Error removing widget content", {
      widgetId,
      error: error instanceof Error ? error.message : error,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get proxy server info (port and secret)
 */
function handleGetProxyInfo(
  _event: IpcMainInvokeEvent
): { success: boolean; port?: number; secret?: string; error?: string } {
  try {
    const port = widgetProxyService.getPort();
    const secret = widgetProxyService.getSecret();

    if (!port || !secret) {
      return {
        success: false,
        error: "Widget proxy server not running",
      };
    }

    return { success: true, port, secret };
  } catch (error) {
    logger.mcp.error("Error getting proxy info", {
      error: error instanceof Error ? error.message : error,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
