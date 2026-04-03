/**
 * HTTP client for communicating with the Degen Terminal REST API.
 * Handles JWT token management and automatic header injection.
 */

let apiUrl = process.env.API_URL || 'http://localhost:4000';
let authToken: string | null = null;
let tokenExpiresAt = 0;

export function setApiUrl(url: string) {
  apiUrl = url;
}

export function setAuthToken(token: string, expiresAt: number) {
  authToken = token;
  // API returns expiresAt as unix seconds; normalize to milliseconds for Date.now() comparison
  tokenExpiresAt = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

export function clearAuthToken() {
  authToken = null;
  tokenExpiresAt = 0;
}

export function isAuthenticated(): boolean {
  return !!authToken && Date.now() < tokenExpiresAt;
}

export function getAuthToken(): string | null {
  return authToken;
}

async function request<T = any>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, apiUrl);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json() as any;

  if (!res.ok) {
    const errMsg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(`API error (${res.status}): ${errMsg}`);
  }

  return json as T;
}

export const api = {
  get: <T = any>(path: string, params?: Record<string, string>) =>
    request<T>('GET', path, undefined, params),

  post: <T = any>(path: string, body?: unknown) =>
    request<T>('POST', path, body),

  delete: <T = any>(path: string, body?: unknown) =>
    request<T>('DELETE', path, body),
};
