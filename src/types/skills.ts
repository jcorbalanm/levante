export interface SkillDescriptor {
  /** Formato obligatorio: "category/name" */
  id: string;
  name: string;
  description: string;
  category: string;
  author?: string;
  version?: string;
  license?: string;
  tags?: string[];
  allowedTools?: string;
  model?: string;
  userInvocable?: boolean;
  dependencies?: string[];
  source?: string;
  repo?: string;
  metadata?: Record<string, unknown>;
  /** Markdown sin frontmatter */
  content: string;
}

export interface SkillCategory {
  category: string;
  displayName: string;
  count: number;
}

export interface SkillsCatalogResponse {
  version: string;
  total: number;
  skills: SkillDescriptor[];
}

export interface InstalledSkill extends SkillDescriptor {
  installedAt: string; // ISO 8601
  filePath: string; // ~/levante/skills/{category}/{name}.md
  companionDir?: string; // ~/levante/skills/{category}/{name}/ (si hay archivos compañeros)
  fileKeys?: string[]; // rutas relativas de los archivos compañeros instalados
}

/**
 * Respuesta del endpoint GET /api/skills/:category/:name/bundle
 * Incluye todos los archivos compañeros de la skill (rules/, scripts/, etc.)
 */
export interface SkillBundleResponse extends SkillDescriptor {
  /**
   * Clave: ruta relativa desde la raíz de la skill (e.g. "rules/animations.md", "scripts/setup.sh")
   * Valor: contenido íntegro del archivo
   * Objeto vacío si la skill no tiene archivos compañeros.
   */
  files: Record<string, string>;
}

export type IPCResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };
