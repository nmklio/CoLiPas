import { PreparedApiRequest } from '../../types';
import { parseHeaders, prepareApiRequest, toCurl } from '../../shared/apiRequest';

export { parseHeaders, prepareApiRequest, toCurl };

export interface ApiExecutionResult {
  ok: boolean;
  status: number;
  durationMs: number;
  bodyText: string;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function executePreparedRequest(request: PreparedApiRequest, fetcher: Fetcher = fetch): Promise<ApiExecutionResult> {
  const startedAt = performance.now();
  const response = await fetcher(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  return {
    ok: response.ok,
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
    bodyText: await response.text(),
  };
}
