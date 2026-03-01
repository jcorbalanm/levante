import { useMemo } from 'react';
import { usePreferences } from './usePreferences';
import type { Model, ProviderType } from '../../types/models';

interface UseToolApprovalWarningResult {
  /** True si el proveedor del modelo actual tiene tool approval deshabilitado */
  showWarning: boolean;
  /** Nombre del proveedor (para mostrar en el mensaje) */
  providerName: string | null;
}

/**
 * Hook que determina si se debe mostrar un warning de tool approval
 * basándose en el modelo actual y las preferencias del usuario.
 */
export function useToolApprovalWarning(
  currentModelInfo: Model | undefined
): UseToolApprovalWarningResult {
  const { preferences } = usePreferences();

  return useMemo(() => {
    // Si no hay modelo seleccionado, no mostrar warning
    if (!currentModelInfo?.provider) {
      return { showWarning: false, providerName: null };
    }

    const providerType = currentModelInfo.provider as ProviderType;
    const providersWithoutApproval = preferences?.ai?.providersWithoutToolApproval ?? [];

    // Verificar si el proveedor está en la lista de proveedores sin approval
    const isProviderWithoutApproval = providersWithoutApproval.includes(providerType);

    return {
      showWarning: isProviderWithoutApproval,
      providerName: isProviderWithoutApproval ? currentModelInfo.provider : null,
    };
  }, [currentModelInfo?.provider, preferences?.ai?.providersWithoutToolApproval]);
}
