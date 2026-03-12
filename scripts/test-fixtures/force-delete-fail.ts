import { rmSync } from "node:fs"

function cleanupTemp(path: string): void {
  rmSync(path, { recursive: true, force: true })
}
