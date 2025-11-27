import { ipcMain } from "electron";
import { RuntimeManager } from "../../services/runtime/runtimeManager";
import { getLogger } from "../../services/logging";

const logger = getLogger();
const runtimeManager = new RuntimeManager();

export function registerRuntimeHandlers() {
    ipcMain.handle("mcp:get-runtimes", async () => {
        try {
            return await runtimeManager.getInstalledRuntimes();
        } catch (error) {
            logger.mcp.error("Failed to get runtimes", { error });
            throw error;
        }
    });

    ipcMain.handle("mcp:cleanup-runtimes", async () => {
        try {
            // await runtimeManager.cleanupUnusedRuntimes();
        } catch (error) {
            logger.mcp.error("Failed to cleanup runtimes", { error });
            throw error;
        }
    });

    // For testing purposes
    ipcMain.handle("mcp:install-runtime", async (_, { type, version }) => {
        try {
            return await runtimeManager.installRuntime(type, version);
        } catch (error) {
            logger.mcp.error("Failed to install runtime", { error });
            throw error;
        }
    });
}
