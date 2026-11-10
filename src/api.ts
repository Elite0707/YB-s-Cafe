export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = `Something went wrong (${response.status})`;
    try {
      const body = await response.json();
      message = body.error || body.message || message;
    } catch { /* Response may be empty */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function jsonBody(value: unknown) { return JSON.stringify(value); }

export async function uploadImage(file: File): Promise<{ url: string }> {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");
  const response = await fetch("/api/admin/uploads", { method: "POST", credentials: "same-origin", headers: { "Content-Type": file.type }, body: file });
  if (!response.ok) {
    let message = `Image upload failed (${response.status})`;
    try { const body = await response.json(); message = body.error || body.message || message; } catch { /* Keep the status message */ }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<{ url: string }>;
}

export function friendlyError(error: unknown) {
  return error instanceof Error ? error.message : "Unable to reach the cafe service. Check your connection and try again.";
}
