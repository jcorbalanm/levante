/**
 * ToolApprovalInline - UI para aprobar/denegar ejecución de herramientas
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ShieldCheck,
  Wrench,
  X,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { CodeBlock } from './code-block';

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

interface ToolApprovalInlineProps {
  /** Nombre de la herramienta (formato: serverId_toolName) */
  toolName: string;
  /** Argumentos que se van a pasar a la herramienta */
  input: Record<string, unknown>;
  /** ID de aprobación del AI SDK */
  approvalId: string;
  /** Callback cuando el usuario aprueba */
  onApprove: () => void;
  /** Callback cuando el usuario deniega */
  onDeny: () => void;
  /** Clases CSS adicionales */
  className?: string;
}

// ═══════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════

export function ToolApprovalInline({
  toolName,
  input,
  approvalId,
  onApprove,
  onDeny,
  className,
}: ToolApprovalInlineProps) {
  const [showDetails, setShowDetails] = useState(false);

  // Extraer nombre de herramienta sin prefijo del servidor
  // Formato: serverId_toolName → toolName
  const displayToolName = toolName.includes('_')
    ? toolName.split('_').slice(1).join('_')
    : toolName;

  // Extraer serverId
  const serverId = toolName.includes('_')
    ? toolName.split('_')[0]
    : 'unknown';

  return (
    <div
      className={cn(
        'rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-4 space-y-3',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-yellow-500" />
        <span className="font-medium">Tool Approval Required</span>
      </div>

      {/* Tool Info */}
      <div className="flex items-center gap-2 text-sm">
        <Wrench className="w-4 h-4 text-muted-foreground" />
        <span className="font-mono font-medium">{displayToolName}</span>
        <Badge variant="outline" className="text-xs">
          {serverId}
        </Badge>
      </div>

      {/* Toggle Parameters */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showDetails ? (
          <>
            <ChevronUp className="w-3 h-3" />
            Hide parameters
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" />
            Show parameters
          </>
        )}
      </button>

      {/* Parameters */}
      {showDetails && (
        <div className="rounded-md border overflow-hidden">
          <CodeBlock
            code={JSON.stringify(input, null, 2)}
            language="json"
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onDeny}
          className="gap-1"
        >
          <X className="w-3 h-3" />
          Deny
        </Button>
        <Button
          size="sm"
          onClick={onApprove}
          className="gap-1"
        >
          <Check className="w-3 h-3" />
          Approve
        </Button>
      </div>
    </div>
  );
}
