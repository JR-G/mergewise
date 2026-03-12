import { rmSync } from "node:fs"

function cleanupTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.error("Failed to clean up temp directory", error)
  }
}
