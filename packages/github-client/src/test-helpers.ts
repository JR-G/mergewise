export type FetchMock = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchCall {
  input: string | URL;
  init?: RequestInit | undefined;
}

export function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
