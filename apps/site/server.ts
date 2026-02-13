import { extname, join, normalize } from "node:path";

const siteRootPath = join(import.meta.dir);
const defaultFileName = "index.html";

const contentTypeByExtension: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolves a request pathname to an absolute file path within the site root.
 *
 * @param requestPathName - URL pathname from the incoming request.
 * @returns Absolute local file path for static file lookup.
 */
function resolveRequestedFilePath(requestPathName: string): string {
  const normalizedPathName = normalize(requestPathName).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolvedPathName = normalizedPathName === "/" ? defaultFileName : normalizedPathName.slice(1);
  return join(siteRootPath, resolvedPathName);
}

/**
 * Maps a file path extension to an HTTP content type.
 *
 * @param filePath - Absolute file path to inspect.
 * @returns Content type header value.
 */
function getContentTypeForPath(filePath: string): string {
  const extensionName = extname(filePath);
  return contentTypeByExtension[extensionName] ?? "application/octet-stream";
}

/**
 * Builds a plain 404 response for unresolved site paths.
 *
 * @returns Not found response.
 */
function buildNotFoundResponse(): Response {
  return new Response("Not Found", { status: 404 });
}

const serverPort = Number.parseInt(process.env.SITE_PORT ?? "4173", 10);

Bun.serve({
  port: Number.isNaN(serverPort) ? 4173 : serverPort,
  async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const filePath = resolveRequestedFilePath(requestUrl.pathname);
    const fileHandle = Bun.file(filePath);

    if (!(await fileHandle.exists())) {
      if (requestUrl.pathname !== "/") {
        const fallbackHandle = Bun.file(join(siteRootPath, defaultFileName));
        if (await fallbackHandle.exists()) {
          return new Response(fallbackHandle, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
      }

      return buildNotFoundResponse();
    }

    return new Response(fileHandle, {
      headers: { "content-type": getContentTypeForPath(filePath) },
    });
  },
});

console.log(`mergewise site running at http://localhost:${Number.isNaN(serverPort) ? 4173 : serverPort}`);
