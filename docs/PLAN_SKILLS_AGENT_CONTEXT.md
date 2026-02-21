# Plan de implementación: Skills en el contexto del agente

**Objetivo:** Hacer que las skills instaladas por el usuario (`~/levante/skills/{category}/{name}.md`) sean visibles para el agente al inicio de cada conversación (system prompt) y ejecutables por él mediante una tool dedicada, tanto cuando el usuario las invoca explícitamente como cuando el agente decide usarlas de forma autónoma.

**Estado actual:** Las skills ya se instalan y listan correctamente. No llegan al agente.

---

## 1. Qué ya existe y se reutiliza

Todo lo necesario para leer skills del disco ya está implementado. No hay que reescribirlo.

| Componente existente | Archivo | Líneas |
|---|---|---|
| `parseFrontmatter()` | `src/main/services/skillsService.ts` | 98–119 |
| `listInstalledSkills()` | `src/main/services/skillsService.ts` | 274–333 |
| `skillsService` (singleton) | `src/main/services/skillsService.ts` | 336 |
| `InstalledSkill` type | `src/types/skills.ts` | 34–37 |
| `SkillDescriptor` type | `src/types/skills.ts` | 1–20 |
| Directorio `~/levante/skills/` | `src/main/services/directoryService.ts` | `getSubdirPath('skills')` |

`listInstalledSkills()` ya:
- Escanea `~/levante/skills/{category}/{name}.md`
- Parsea frontmatter YAML (`id`, `name`, `description`, `userInvocable`, `content`, etc.)
- Retorna `InstalledSkill[]` ordenados por id
- Maneja errores silenciosamente (carpeta vacía → array vacío)

---

## 2. Arquitectura de la solución

### Dos canales, igual que en el diseño de referencia

```
SYSTEM PROMPT                         TOOL DESCRIPTION
─────────────────                     ─────────────────
# Available Skills                    "Execute a skill to complete the
- coding/git-commit: Crea commits...  user's task. When users reference
- writing/email-pro: Redacta...       a skill by name or ask to use one,
                                      call this tool immediately."

          │                                    │
          ▼                                    ▼
Claude razona: "hay una skill         Claude decide: el usuario pidió
relevante para esta tarea"            explícitamente una skill
          │                                    │
          └──────────────┬────────────────────┘
                         ▼
            Claude llama: skill_execute({ skill: "coding/git-commit" })
                         │
                         ▼
            Tool lee el content del skill instalado
            Lo retorna como tool result
                         │
                         ▼
            Claude lee las instrucciones y las ejecuta
```

### Archivos a crear y modificar

```
CREAR (nuevo):
src/main/services/ai/skillsContextBuilder.ts

MODIFICAR (cambios mínimos y quirúrgicos):
src/main/services/ai/builtInTools.ts       — añadir skill tool
src/main/services/ai/systemPromptBuilder.ts — añadir sección de skills
src/main/services/aiService.ts             — cargar skills y pasarlas
```

---

## 3. Paso 1 — Crear `skillsContextBuilder.ts`

**Ruta:** `src/main/services/ai/skillsContextBuilder.ts`

Este módulo es el núcleo de la implementación. Dos responsabilidades:
1. Generar el fragmento del system prompt con la lista de skills
2. Crear la tool `skill_execute` para el Vercel AI SDK

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { InstalledSkill } from '../../../types/skills';
import { getLogger } from '../logging';

const logger = getLogger();

// Presupuesto máximo de tokens para la sección de skills en el system prompt.
// ~2% del contexto de 200k. Cada entrada: "- id: description\n" ≈ 4 chars/token.
const SKILLS_TOKEN_BUDGET = 4000;

/**
 * Genera la sección "# Available Skills" para el system prompt.
 * Incluye todas las skills instaladas (el usuario las instaló para usarlas).
 * Respeta el presupuesto de tokens para no saturar el contexto.
 */
export function buildSkillsContext(skills: InstalledSkill[]): string {
  // En Levante no filtramos por userInvocable:
  // - Todas las skills instaladas deben llegar al agente (el usuario las instaló para usarlas)
  // - El campo userInvocable viene de open-claude-code donde servía para ocultar sub-skills
  //   del menú de slash commands visible al humano — concepto que no existe en Levante
  // - Además, en Levante el default del campo es false (por parseo), lo que excluiría
  //   la mayoría de skills sin motivo
  if (skills.length === 0) return '';

  let usedTokens = 0;
  const entries: string[] = [];

  for (const skill of skills) {
    // Usa description del frontmatter; si no existe, primeros 100 chars del content
    const desc = skill.description?.trim() || skill.content.slice(0, 100).replace(/\n/g, ' ');
    const entry = `- ${skill.id}: ${desc}`;
    const tokens = Math.ceil(entry.length / 4);

    if (usedTokens + tokens > SKILLS_TOKEN_BUDGET) break;

    entries.push(entry);
    usedTokens += tokens;
  }

  if (entries.length === 0) return '';

  return `\n# Available Skills\nThe following skills are available. Use the skill_execute tool to load and follow a skill's instructions when relevant:\n${entries.join('\n')}\n`;
}

/**
 * Crea la tool `skill_execute` para el Vercel AI SDK.
 *
 * El agente la usa en dos situaciones:
 * 1. El usuario invoca una skill explícitamente (e.g., "usa la skill git-commit")
 * 2. El agente detecta que una skill disponible es relevante para la tarea
 *
 * La tool retorna el content completo del skill (el body del .md tras el frontmatter).
 * El agente lee esas instrucciones y las sigue en el siguiente turno.
 */
export function createSkillTool(skills: InstalledSkill[]) {
  return tool({
    description: `Execute a skill to help complete the user's task.

Use this tool when:
- The user explicitly asks to use a skill by name or ID (e.g., "use the git-commit skill", "run coding/email-pro")
- You identify that an available skill matches the user's request and would help complete it more effectively

How to identify the right skill:
- Match by exact skill ID (e.g., "coding/git-commit")
- Match by skill name (case insensitive)
- Match by the name segment after "/" (e.g., "git-commit" matches "coding/git-commit")

Important:
- When a skill is relevant, invoke this tool IMMEDIATELY as your first action
- After receiving the skill content, read and follow its instructions carefully
- Do not invoke a skill that is already running in the current turn`,

    inputSchema: z.object({
      skill: z.string().describe(
        'The skill ID (e.g., "coding/git-commit") or name (e.g., "git-commit"). Use the exact ID from the Available Skills list when possible.'
      ),
      args: z.string().optional().describe(
        'Optional arguments or context to pass to the skill'
      ),
    }),

    execute: async ({ skill, args }) => {
      logger.aiSdk.info('Skill tool invoked', { skill, hasArgs: !!args });

      // Estrategia de búsqueda en cascada (igual que en la implementación de referencia)
      let found: InstalledSkill | undefined;

      // 1. ID exacto (e.g., "coding/git-commit")
      found = skills.find(s => s.id === skill);

      // 2. Nombre exacto (case insensitive)
      if (!found) {
        found = skills.find(s => s.name.toLowerCase() === skill.toLowerCase());
      }

      // 3. Solo el segmento de nombre tras "/" (e.g., "git-commit")
      if (!found) {
        const namePart = skill.includes('/') ? skill.split('/').pop()! : skill;
        found = skills.find(s => {
          const idName = s.id.split('/').pop() ?? '';
          return (
            idName.toLowerCase() === namePart.toLowerCase() ||
            s.name.toLowerCase() === namePart.toLowerCase()
          );
        });
      }

      if (!found) {
        const available = skills.map(s => `${s.id} ("${s.name}")`).join(', ');
        logger.aiSdk.warn('Skill not found', { requested: skill });
        return {
          error: `Skill "${skill}" not found.`,
          availableSkills: available || 'No skills installed',
        };
      }

      logger.aiSdk.info('Skill loaded', { skillId: found.id, contentLength: found.content.length });

      return {
        skillId: found.id,
        skillName: found.name,
        instructions: found.content,
        ...(args ? { args } : {}),
      };
    },
  });
}
```

---

## 4. Paso 2 — Modificar `builtInTools.ts`

**Ruta:** `src/main/services/ai/builtInTools.ts`

Añadir el campo `skills` al config y registrar la tool cuando hay skills instaladas.

### Cambio en la interfaz `BuiltInToolsConfig` (línea 12)

```typescript
// ANTES:
export interface BuiltInToolsConfig {
    mermaidValidation: boolean;
    mcpDiscovery: boolean;
}

// DESPUÉS:
import type { InstalledSkill } from '../../../types/skills';

export interface BuiltInToolsConfig {
    mermaidValidation: boolean;
    mcpDiscovery: boolean;
    skills?: InstalledSkill[];   // ← añadir
}
```

### Cambio en `getBuiltInTools()` (línea 44)

```typescript
// ANTES:
export async function getBuiltInTools(config?: BuiltInToolsConfig): Promise<Record<string, any>> {
    const tools: Record<string, any> = {};

    if (config?.mermaidValidation !== false) { ... }
    if (config?.mcpDiscovery !== false) { ... }

    logger.aiSdk.debug('Built-in tools created', { ... });
    return tools;
}

// DESPUÉS:
import { createSkillTool } from './skillsContextBuilder';   // añadir import

export async function getBuiltInTools(config?: BuiltInToolsConfig): Promise<Record<string, any>> {
    const tools: Record<string, any> = {};

    if (config?.mermaidValidation !== false) { ... }   // sin cambios
    if (config?.mcpDiscovery !== false) { ... }        // sin cambios

    // Añadir skill tool si hay skills instaladas
    if (config?.skills && config.skills.length > 0) {
        tools['skill_execute'] = createSkillTool(config.skills);
        logger.aiSdk.debug('Skill tool registered', { skillCount: config.skills.length });
    }

    logger.aiSdk.debug('Built-in tools created', {
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools)
    });

    return tools;
}
```

---

## 5. Paso 3 — Modificar `systemPromptBuilder.ts`

**Ruta:** `src/main/services/ai/systemPromptBuilder.ts`

Añadir el parámetro `skills` y la sección en el prompt.

### Cambio en la firma de `buildSystemPrompt()` (línea 9)

```typescript
// ANTES:
export async function buildSystemPrompt(
  webSearch: boolean,
  enableMCP: boolean,
  toolCount: number,
  mermaidValidation: boolean = true,
  mcpDiscoveryEnabled: boolean = true,
  projectDescription?: string
): Promise<string> {

// DESPUÉS:
import type { InstalledSkill } from '../../../types/skills';   // añadir import
import { buildSkillsContext } from './skillsContextBuilder';    // añadir import

export async function buildSystemPrompt(
  webSearch: boolean,
  enableMCP: boolean,
  toolCount: number,
  mermaidValidation: boolean = true,
  mcpDiscoveryEnabled: boolean = true,
  projectDescription?: string,
  skills?: InstalledSkill[]    // ← añadir al final (opcional para no romper llamadas existentes)
): Promise<string> {
```

### Añadir sección de skills antes del debug log (tras línea 211, antes del return)

```typescript
  // Añadir contexto de skills instaladas (si las hay)
  const skillsSection = buildSkillsContext(skills ?? []);
  if (skillsSection) {
    systemPrompt += skillsSection;
  }

  // Debug log (ya existente, línea 213)
  logger.aiSdk.debug('Final system prompt generated', { ... });

  return systemPrompt;
```

---

## 6. Paso 4 — Modificar `aiService.ts`

**Ruta:** `src/main/services/aiService.ts`

Cargar las skills instaladas y pasarlas a `getBuiltInTools` y `buildSystemPrompt`.

### Añadir import en la sección de imports (línea ~21)

```typescript
import { skillsService } from './skillsService';
```

### Modificar `streamChat()` — cargar skills antes de tools (tras línea 1033)

```typescript
// ── Antes de getBuiltInTools (línea 1033):

// AÑADIR: Cargar skills instaladas
let installedSkills: InstalledSkill[] = [];
try {
  installedSkills = await skillsService.listInstalledSkills();
  this.logger.aiSdk.debug('Loaded installed skills for agent context', {
    count: installedSkills.length,
    ids: installedSkills.map(s => s.id),
  });
} catch (error) {
  this.logger.aiSdk.warn('Failed to load installed skills', {
    error: error instanceof Error ? error.message : String(error),
  });
}

// YA EXISTE (sin cambios):
const { getBuiltInTools } = await import('./ai/builtInTools');
const builtInToolsConfig = await this.getBuiltInToolsConfig();

// MODIFICAR: pasar skills al config
const builtInTools = await getBuiltInTools({
  ...builtInToolsConfig,
  skills: installedSkills,    // ← añadir
});
```

### Modificar la llamada a `buildSystemPrompt()` (línea 1173)

```typescript
// ANTES:
system: await buildSystemPrompt(
  webSearch,
  enableMCP,
  Object.keys(tools).length,
  builtInToolsConfig.mermaidValidation,
  builtInToolsConfig.mcpDiscovery,
  projectDescription
),

// DESPUÉS:
system: await buildSystemPrompt(
  webSearch,
  enableMCP,
  Object.keys(tools).length,
  builtInToolsConfig.mermaidValidation,
  builtInToolsConfig.mcpDiscovery,
  projectDescription,
  installedSkills    // ← añadir
),
```

> **Nota:** Hay una segunda llamada a `buildSystemPrompt` en `aiService.ts` alrededor de la línea 1933 (para inference tasks). Aplicar el mismo cambio allí si se quiere consistencia completa. La prioridad es la llamada de `streamChat` (línea 1173).

---

## 7. Flujo completo resultado

```
streamChat() inicia
    │
    ├── skillsService.listInstalledSkills()
    │       └── Lee ~/levante/skills/{category}/{name}.md
    │           Parsea frontmatter → InstalledSkill[]
    │
    ├── getBuiltInTools({ mermaidValidation, mcpDiscovery, skills })
    │       └── createSkillTool(skills) → tool 'skill_execute'
    │
    ├── buildSystemPrompt(..., skills)
    │       └── buildSkillsContext(skills)
    │               └── "# Available Skills\n- coding/git-commit: ...\n..."
    │
    └── streamText({
          model,
          system: "...# Available Skills\n- coding/git-commit: ...",
          tools: { builtin_validate_mermaid, mcp_discovery, skill_execute, ...mcpTools },
          messages,
        })

Cuando el agente llama a skill_execute({ skill: "coding/git-commit" }):
    └── execute() busca la skill por id/nombre
        └── Retorna { skillId, skillName, instructions: content }
            Claude lee `instructions` y las ejecuta en el siguiente turno
```

---

## 8. Ejemplo de sección en el system prompt

Si el usuario tiene instaladas tres skills:

```
# Available Skills
The following skills are available. Use the skill_execute tool to load and follow a skill's instructions when relevant:
- coding/git-commit: Crea commits de git con mensajes descriptivos siguiendo conventional commits
- writing/email-pro: Redacta emails profesionales estructurados y concisos
- productivity/daily-standup: Genera el resumen de standup diario a partir de los cambios del día
```

---

## 9. Ejemplo de tool result que recibe el agente

Cuando llama a `skill_execute({ skill: "coding/git-commit" })`:

```json
{
  "skillId": "coding/git-commit",
  "skillName": "Git Commit",
  "instructions": "Analiza los cambios staged con `git diff --staged`.\n\nSigue el formato conventional commits:\n- feat: nueva funcionalidad\n- fix: corrección de bug\n- docs: documentación\n\nGenera el mensaje y ejecuta el commit."
}
```

El agente lee `instructions` y sigue ese flujo en la conversación.

---

## 10. Import de tipo en `aiService.ts`

Añadir el import del tipo si no existe ya:

```typescript
import type { InstalledSkill } from '../../types/skills';
```

---

## TODO: Soporte de skills a nivel de proyecto

> **TODO — Implementación futura**
>
> Actualmente el sistema solo lee skills del directorio global del usuario: `~/levante/skills/{category}/{name}.md`.
>
> En el futuro, también se deberá leer del directorio de skills del proyecto activo. La lógica de precedencia sería:
>
> 1. Skills globales del usuario (`~/levante/skills/`) — se cargan primero
> 2. Skills del proyecto (`.levante/skills/` relativo al CWD o al proyecto activo) — sobrescriben las globales si tienen el mismo `id`
>
> Implementación sugerida en `skillsContextBuilder.ts`:
>
> ```typescript
> // FUTURO: función que combina global + proyecto con precedencia
> export async function discoverAllSkills(projectDir?: string): Promise<InstalledSkill[]> {
>   const global = await skillsService.listInstalledSkills();
>   if (!projectDir) return global;
>
>   const projectSkillsDir = path.join(projectDir, '.levante', 'skills');
>   const projectSkills = await readSkillsFromDir(projectSkillsDir, 'project');
>
>   // Las skills de proyecto sobrescriben las globales con el mismo id
>   const merged = new Map(global.map(s => [s.id, s]));
>   for (const s of projectSkills) merged.set(s.id, s);
>
>   return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
> }
> ```
>
> Para este TODO se necesita además:
> - Saber cuál es el directorio del proyecto activo (exponer `projectStore` o `request.projectDir` al backend)
> - Adaptar `streamChat()` para recibir y pasar `projectDir` a `discoverAllSkills()`

---

## 11. Resumen de cambios por archivo

| Archivo | Tipo | Cambio |
|---|---|---|
| `src/main/services/ai/skillsContextBuilder.ts` | **CREAR** | `buildSkillsContext()` + `createSkillTool()` |
| `src/main/services/ai/builtInTools.ts` | modificar | Añadir `skills?` a config; registrar `skill_execute` |
| `src/main/services/ai/systemPromptBuilder.ts` | modificar | Añadir param `skills?`; llamar `buildSkillsContext()` |
| `src/main/services/aiService.ts` | modificar | Cargar skills; pasarlas a tools y system prompt |

**Archivos que NO se tocan:**
- `src/main/services/skillsService.ts` — ya funciona perfectamente
- `src/types/skills.ts` — tipos ya existen y son suficientes
- `src/main/services/directoryService.ts` — ya gestiona el directorio
- Cualquier código del renderer — este cambio es puramente del proceso main
