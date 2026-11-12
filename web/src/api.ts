export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
/** Called whenever the server says the session is gone, so the app can show the sign-in page. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith("/api/auth/login")) onUnauthorized?.();
  if (!res.ok) {
    let error: { code?: string; message?: string; issues?: { path: string; message: string }[] } = {};
    try {
      error = ((await res.json()) as { error?: typeof error }).error ?? {};
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, error.code ?? "ERROR", error.message ?? res.statusText, error.issues);
  }
  return res;
}

export async function api<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, method === "POST" && body === undefined ? {} : body);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const get = <T = unknown>(path: string) => api<T>("GET", path);
export const post = <T = unknown>(path: string, body?: unknown) => api<T>("POST", path, body);

/** Fetch a file and hand it to the browser as a download. Returns the response headers. */
export async function download(method: "GET" | "POST", path: string, body?: unknown): Promise<Headers> {
  const res = await send(method, path, method === "POST" && body === undefined ? {} : body);
  const blob = await res.blob();
  const name = /filename="?([^";]+)"?/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return res.headers;
}

/** The message to show a person for any error. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.issues?.length) return `${error.message}: ${error.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`;
    return error.message;
  }
  return "Could not reach the server. Check your connection and try again.";
}

const CHANGED = "erp:changed";
/** Tell the shell that something other pages may show (the approvals badge) has changed. */
export const announceChange = () => window.dispatchEvent(new Event(CHANGED));
/** Run `listener` whenever a page announces a change. Returns the function that stops listening. */
export function onChange(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
