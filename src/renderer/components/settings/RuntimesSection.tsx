import React, { useEffect, useState } from 'react';
import { SettingsSection } from './SettingsSection';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RuntimeInfo } from '@/types/runtime';
import { Trash2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const RuntimesSection = () => {
    const { t } = useTranslation();
    const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
    const [loading, setLoading] = useState(false);

    const fetchRuntimes = async () => {
        setLoading(true);
        try {
            // @ts-ignore - IPC types not yet updated
            const data = await window.electron.ipcRenderer.invoke('mcp:get-runtimes');
            setRuntimes(data);
        } catch (error) {
            console.error('Failed to fetch runtimes:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleCleanup = async () => {
        try {
            setLoading(true);
            // @ts-ignore
            await window.electron.ipcRenderer.invoke('mcp:cleanup-runtimes');
            await fetchRuntimes();
        } catch (error) {
            console.error('Failed to cleanup runtimes:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleInstall = async (type: 'node' | 'python') => {
        try {
            setLoading(true);
            // @ts-ignore
            await window.electron.ipcRenderer.invoke('mcp:install-runtime', {
                type,
                version: type === 'node' ? '22.11.0' : '3.13.0'
            });
            await fetchRuntimes();
        } catch (error) {
            console.error('Failed to install runtime:', error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchRuntimes();
    }, []);

    return (
        <SettingsSection title="Runtimes" description="Manage installed runtimes for MCP servers">
            <div className="space-y-4">
                <div className="flex justify-between items-center">
                    <p className="text-sm text-muted-foreground">
                        Levante automatically manages these runtimes.
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleInstall('node')} disabled={loading}>
                            Install Node
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => handleInstall('python')} disabled={loading}>
                            Install Python
                        </Button>
                        <Button variant="outline" size="sm" onClick={fetchRuntimes} disabled={loading}>
                            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                            Refresh
                        </Button>
                        <Button variant="destructive" size="sm" onClick={handleCleanup} disabled={loading}>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Cleanup Unused
                        </Button>
                    </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    {runtimes.map((runtime) => (
                        <Card key={`${runtime.type}-${runtime.version}`}>
                            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium capitalize">
                                    {runtime.type}
                                </CardTitle>
                                <Badge variant="secondary">v{runtime.version}</Badge>
                            </CardHeader>
                            <CardContent>
                                <div className="text-xs text-muted-foreground break-all">
                                    {runtime.path}
                                </div>
                                <div className="mt-2 text-xs text-muted-foreground">
                                    Source: <span className="capitalize">{runtime.source}</span>
                                </div>
                            </CardContent>
                        </Card>
                    ))}

                    {runtimes.length === 0 && !loading && (
                        <div className="col-span-2 text-center py-8 text-muted-foreground text-sm border rounded-lg border-dashed">
                            No runtimes installed yet. They will be installed automatically when needed.
                        </div>
                    )}
                </div>
            </div>
        </SettingsSection>
    );
};
