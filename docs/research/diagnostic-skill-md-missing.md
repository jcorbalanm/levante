# Diagnóstico: SKILL.md no aparece en la instalación de skills

**Fecha:** 2026-02-22
**Síntoma:** Al instalar una skill en un proyecto, los archivos compañeros (`rules/*.md`) sí aparecen en disco, pero el archivo principal `SKILL.md` no está dentro del directorio de la skill.

---

## Conclusión principal

**El problema está 100% en Levante, no en la API.**

La API devuelve todos los datos correctamente. El bug es que Levante escribe el contenido de `SKILL.md` en la ruta incorrecta y con el nombre incorrecto.

---

## Pregunta clave: ¿la API devuelve el nombre del archivo principal?

**No.** La API devuelve el contenido del archivo principal en el campo `bundle.content` (string plano), sin nombre de archivo ni ruta. Solo los archivos compañeros en `bundle.files` tienen nombre (la clave del objeto es la ruta relativa).

Esto significa que cualquier nombre que demos al archivo principal (`SKILL.md`, `{name}.md`, etc.) lo estamos inventando nosotros, no copiando de la API. El estándar de nombre (`SKILL.md`) lo sabemos por la convención que se ve en `.agents/skills/`, no porque el API lo indique.

**Implicación:** No podemos "descargar el archivo tal cual viene con su nombre" para el archivo principal porque la API no nos da ese nombre. Para los companion files (`bundle.files`) sí podemos usarlo directamente ya que la clave es la ruta relativa.

---

## Evidencia: qué devuelve la API

De los logs de `getBundle`:

```json
{
  "bundleId": "development/remotion-best-practices",
  "bundleContentLength": 3925,
  "bundleContentPreview": "## When to use\n\nUse this skills whenever you are dealing with Remotion code...",
  "bundleFilesKeys": [
    "rules/3d.md",
    "rules/animations.md",
    "rules/assets.md",
    "rules/audio.md",
    "...39 archivos más..."
  ],
  "bundleTopLevelKeys": [
    "id", "name", "description", "category",
    "content",                          ← aquí está SKILL.md
    "author", "version", "tags", "allowedTools",
    "model", "userInvocable", "dependencies", "files"
  ]
}
```

**La API NO incluye `SKILL.md` dentro de `bundle.files`.** Lo envía como el campo `bundle.content` del objeto raíz. Esto es correcto y esperado — el contenido principal de la skill viaja en `content`, y los archivos compañeros en `files`.

---

## Estructura estándar esperada (`.agents/skills/`)

```
remotion-best-practices/
├── SKILL.md          ← archivo principal (= bundle.content)
└── rules/
    ├── 3d.md
    ├── animations.md
    └── ... (39 archivos)
```

---

## Qué hace Levante actualmente (`installSkill` en `skillsService.ts`)

### Paso 1 — Archivo principal

`buildInstalledPath(baseDir, bundle.id)` genera:

```
filePath = {baseDir}/{category}/{name}.md
         = .levante/skills/development/remotion-best-practices.md
```

Escribe el contenido de `bundle.content` en esa ruta. Resultado:

```
.levante/skills/development/remotion-best-practices.md   ← AQUÍ (nivel categoría, nombre incorrecto)
```

### Paso 2 — Archivos compañeros

```typescript
companionDir = path.join(baseDir, category, name);
// = .levante/skills/development/remotion-best-practices/
```

Escribe cada entrada de `bundle.files` dentro de `companionDir`. Resultado:

```
.levante/skills/development/remotion-best-practices/rules/3d.md
.levante/skills/development/remotion-best-practices/rules/animations.md
...
```

### Estructura real en disco tras la instalación

```
.levante/skills/development/
├── remotion-best-practices.md        ← archivo principal (MAL: nivel categoría, nombre incorrecto)
└── remotion-best-practices/
    └── rules/
        ├── 3d.md
        ├── animations.md
        └── ...
```

---

## Los dos errores concretos

### Error 1 — Nombre incorrecto

El archivo principal se llama `remotion-best-practices.md` en lugar de `SKILL.md`.

**Origen:** `buildInstalledPath` en `skillsService.ts:99`

```typescript
// Actual (incorrecto):
const filePath = path.join(baseDir, category, `${name}.md`);

// Correcto:
const filePath = path.join(baseDir, category, name, 'SKILL.md');
```

### Error 2 — Nivel incorrecto

El archivo principal queda en `{category}/` en lugar de dentro de `{category}/{name}/`.

Consecuencia: el usuario mira dentro de `remotion-best-practices/` (el companion dir) y no encuentra ningún `SKILL.md` ahí. El `.md` existe pero como hermano del directorio, no dentro de él.

---

## Por qué el archivo principal "no se ve"

Cuando el usuario navega a `.levante/skills/development/remotion-best-practices/` solo ve `rules/`. El `remotion-best-practices.md` está un nivel por encima (`development/`), no dentro. El usuario espera encontrar `SKILL.md` dentro del directorio de la skill, siguiendo el estándar.

---

## Qué hay que cambiar

Solo en `src/main/services/skillsService.ts`:

| Función | Cambio necesario |
|---|---|
| `buildInstalledPath` | Cambiar ruta de `{category}/{name}.md` → `{category}/{name}/SKILL.md` |
| `installSkill` | Companion dir ya apunta a `{category}/{name}/` — solo eliminar la separación actual |
| `scanSkillsDir` | Buscar `SKILL.md` dentro de subdirectorios de categoría, en lugar de `.md` a nivel categoría |
| `uninstallSkill` | Borrar el directorio `{category}/{name}/` completo (más simple) |
| `isInstalled` | Buscar `{category}/{name}/SKILL.md` en lugar de `{category}/{name}.md` |

Los tests en `skillsService.test.ts` también necesitan actualizar las rutas esperadas.

---

## Resumen

| | Estado |
|---|---|
| API devuelve `bundle.content` con el contenido de SKILL.md | ✅ Correcto |
| API devuelve `bundle.files` con los archivos de `rules/` | ✅ Correcto |
| Levante escribe el contenido principal en la ruta correcta | ❌ Ruta y nombre incorrectos |
| Levante escribe los companion files en la ruta correcta | ⚠️ Estructura relativa correcta, pero parent incorrecto |
