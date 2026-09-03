import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import type { SkillSource } from '@shared/types'
import type { SkillScanRoot } from '../config'

export interface SkillFile {
  /** Directory name under the scan root - the fallback id. */
  dirName: string
  /** Absolute path to SKILL.md. */
  file: string
  source: SkillSource
}

export interface ScanResult {
  files: SkillFile[]
  warnings: string[]
}

/**
 * Immediate subdirectories, following symlinks. Skill folders are very often
 * symlinks into a shared store (`~/.claude/skills/x -> ~/.agents/skills/x`) and
 * `Dirent.isDirectory()` is false for those, which would silently hide most of
 * a user's skills.
 */
async function subdirectories(dir: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // A missing scan root is normal, not a warning: most workspaces have no
    // `.claude/skills` until the first skill is written.
    return []
  }

  const names = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return entry.name
      if (!entry.isSymbolicLink()) return null
      try {
        return (await fs.stat(path.join(dir, entry.name))).isDirectory() ? entry.name : null
      } catch {
        return null
      }
    })
  )
  return names.filter((name): name is string => name !== null).sort()
}

/**
 * Find every `<root>/<dir>/SKILL.md`. Roots are scanned in order and the result
 * preserves that order, so a later root's skill overrides an earlier one during
 * indexing (系统设计文档 §9: one bad entry must never abort the sweep).
 */
export async function scanSkillFiles(roots: SkillScanRoot[]): Promise<ScanResult> {
  const files: SkillFile[] = []
  const warnings: string[] = []

  for (const root of roots) {
    const dirs = await subdirectories(root.dir)
    for (const dirName of dirs) {
      const file = path.join(root.dir, dirName, 'SKILL.md')
      try {
        await fs.access(file)
      } catch {
        // A subdirectory without SKILL.md is not a skill (references/, templates/).
        continue
      }
      files.push({ dirName, file, source: root.source })
    }
  }

  return { files, warnings }
}
