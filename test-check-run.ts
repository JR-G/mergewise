/**
 * Throwaway file to verify Mergewise check runs appear on PRs.
 * Delete this file after confirming.
 */

/* eslint-disable @typescript-eslint/prefer-for-of, id-length, no-restricted-syntax, @typescript-eslint/no-non-null-assertion */

function processItems(items: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i] !== undefined) {
      if (items[i]!.length > 0) {
        if (!items[i]!.startsWith("_")) {
          result.push(items[i]!.toUpperCase());
        }
      }
    }
  }
  return result;
}

export { processItems };
