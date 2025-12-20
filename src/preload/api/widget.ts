import { ipcRenderer } from 'electron';

export interface WidgetStoreResult {
  success: boolean;
  url?: string;
  widgetId?: string;
  error?: string;
}

export interface WidgetRemoveResult {
  success: boolean;
  error?: string;
}

export interface WidgetProxyInfo {
  success: boolean;
  port?: number;
  secret?: string;
  error?: string;
}

export const widgetApi = {
  /**
   * Store widget HTML content and get proxy URL
   * Returns an http://127.0.0.1:{port}/widget/{id}?secret={token} URL
   * @param html - HTML content to store
   * @param baseUrl - Optional base URL for resolving relative paths (e.g., "https://arcade.xmcp.dev")
   */
  store: (html: string, baseUrl?: string): Promise<WidgetStoreResult> =>
    ipcRenderer.invoke('levante/widget/store', html, baseUrl),

  /**
   * Remove widget content from store
   */
  remove: (widgetId: string): Promise<WidgetRemoveResult> =>
    ipcRenderer.invoke('levante/widget/remove', widgetId),

  /**
   * Get proxy server info (port and secret)
   */
  getProxyInfo: (): Promise<WidgetProxyInfo> =>
    ipcRenderer.invoke('levante/widget/getProxyInfo'),
};
