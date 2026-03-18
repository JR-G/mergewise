import type {
  CodebaseContext,
  DiffHunk,
  FileDiff,
  PullRequestMetadata,
} from "@mergewise/shared-types";
import {
  toFilePath,
  toInstallationId,
  toPRNumber,
  toRepoFullName,
  toSHA,
} from "@mergewise/shared-types";

export function makeHunk(header: string, lines: string[]): DiffHunk {
  return { header, lines };
}

export function makeDiff(filePath: string, hunks: DiffHunk[]): FileDiff {
  return { filePath: toFilePath(filePath), previousPath: null, hunks };
}

export const PULL_REQUEST_METADATA: PullRequestMetadata = {
  repo: toRepoFullName("acme/widget"),
  prNumber: toPRNumber(42),
  headSha: toSHA("a".repeat(40)),
  installationId: toInstallationId(1),
};

export function makeMockCodebaseContext(files: Record<string, string> = {}): CodebaseContext {
  return {
    symbols: [],
    conventions: new Map(),
    readFile: (path: string) => Promise.resolve(files[path] ?? null),
  };
}

export async function withMockFetch(
  handler: (request: Request) => Promise<Response> | Response,
  action: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const mockFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const requestInput = input instanceof URL ? input.toString() : input;
    const request = requestInput instanceof Request
      ? requestInput
      : new Request(requestInput, init);
    return await handler(request);
  };
  const patchedFetch = Object.assign(mockFetch, originalFetch);
  globalThis.fetch = patchedFetch;
  try {
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function buildCompletionResponse(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });
}
