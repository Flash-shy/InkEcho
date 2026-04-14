/** Vite proxy prefix → backend (see vite.config). */
export const INKECHO_API_PREFIX = "/api";

export async function parseJsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${body}`);
  }
  return r.json() as Promise<T>;
}

