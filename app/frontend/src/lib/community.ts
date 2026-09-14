const CORE = "/api/v1";

export type User = { id: number; email: string; display_name: string; created_at: string };
export type Project = { slug: string; name: string; category: string; summary: string; github_url: string; deepwiki_url?: string | null; language: string; stars: number; loc: number; loc_delta: number };
export type Note = { id: number; title: string; body: string; tags: string[]; project_slug?: string | null; created_at: string; updated_at: string };
type Auth = { token: string; user: User };

const token = () => localStorage.getItem("hiremind_token");
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${CORE}${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...init.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.detail === "string" ? body.detail : "请检查输入，或稍后重试"); }
  return response.status === 204 ? undefined as T : response.json();
}
export const community = {
  projects: (category?: string) => call<Project[]>(`/projects${category && category !== "全部" ? `?category=${encodeURIComponent(category)}` : ""}`),
  categories: () => call<string[]>("/projects/categories"),
  register: (body: { email: string; password: string; display_name: string }) => call<Auth>("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  login: (body: { email: string; password: string }) => call<Auth>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
  me: () => call<User>("/auth/me"),
  preparation: () => call<Preparation & { revision: number }>("/preparation"),
  savePreparation: (body: Preparation & { revision: number }) => call<{ revision: number }>("/preparation", { method: "PUT", body: JSON.stringify(body) }),
  importLocal: (body: Preparation) => call<Preparation & { revision: number }>("/preparation/import-local", { method: "POST", body: JSON.stringify(body) }),
  endSession: () => call("/auth/logout", { method: "POST" }),
  notes: () => call<Note[]>("/notes"),
  saveNote: (body: Partial<Note> & { title: string }) => call<Note>(body.id ? `/notes/${body.id}` : "/notes", { method: body.id ? "PUT" : "POST", body: JSON.stringify({ title: body.title, body: body.body || "", tags: body.tags || [], project_slug: body.project_slug || null }) }),
  deleteNote: (id: number) => call<void>(`/notes/${id}`, { method: "DELETE" }),
  persist(auth: Auth) { localStorage.removeItem("hiremind_token"); localStorage.setItem("hiremind_user", JSON.stringify(auth.user)); },
  logout() { localStorage.removeItem("hiremind_token"); localStorage.removeItem("hiremind_user"); },
  cachedUser(): User | null { try { return JSON.parse(localStorage.getItem("hiremind_user") || "null"); } catch { return null; } },
};

export type PrepNote = { id: string; title: string; body: string; tag: string };
export type Preparation = { saved: string[]; notes: PrepNote[]; tasks: { id: string; text: string; done: boolean }[]; drafts: PrepNote[] };
