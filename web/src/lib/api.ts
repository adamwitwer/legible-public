async function req(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    // Declaring a JSON body and sending none makes Fastify reject the request
    // with FST_ERR_CTP_EMPTY_JSON_BODY before it reaches the route, so only
    // claim the content type when there is actually a body to parse.
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // message carries the reason a ceremony failed; error stays the slug that
    // callers switch on, so it remains the Error's message.
    throw Object.assign(new Error(body.error ?? res.statusText), {
      status: res.status,
      body,
      detail: body.message as string | undefined,
    });
  }
  return res.json();
}

export const api = {
  authState: () => req('/api/auth/state'),
  registerStart: (enrollCode?: string) =>
    req('/api/auth/register/start', { method: 'POST', body: JSON.stringify({ enrollCode }) }),
  registerFinish: (response: unknown, label?: string) =>
    req('/api/auth/register/finish', { method: 'POST', body: JSON.stringify({ response, label }) }),
  loginStart: () => req('/api/auth/login/start', { method: 'POST' }),
  loginFinish: (response: unknown) =>
    req('/api/auth/login/finish', { method: 'POST', body: JSON.stringify({ response }) }),
  logout: () => req('/api/auth/logout', { method: 'POST' }),
  credentials: () => req('/api/auth/credentials'),
  forgetCredential: (id: string) =>
    req(`/api/auth/credentials/${id}`, { method: 'DELETE' }),

  pull: (since: string) => req(`/api/sync?since=${encodeURIComponent(since)}`),
  push: (notes: unknown[]) => req('/api/notes', { method: 'POST', body: JSON.stringify({ notes }) }),
  revisions: (id: string) => req(`/api/notes/${id}/revisions`),
  splitNote: (id: string, at: number) =>
    req(`/api/notes/${id}/split`, { method: 'POST', body: JSON.stringify({ at }) }),

  // --- capture ---
  createBatch: () => req('/api/capture/batches', { method: 'POST' }),
  batch: (id: string) => req(`/api/capture/batches/${id}`),
  resegment: (id: string) => req(`/api/capture/batches/${id}/resegment`, { method: 'POST' }),
  commitBatch: (id: string, notes: unknown[]) =>
    req(`/api/capture/batches/${id}/commit`, { method: 'POST', body: JSON.stringify({ notes }) }),
  notePages: (id: string) => req(`/api/notes/${id}/pages`),

  async uploadPage(batchId: string, file: File, shotAt?: string) {
    const form = new FormData();
    if (shotAt) form.append('shot_at', shotAt);
    form.append('file', file);
    const res = await fetch(`/api/capture/batches/${batchId}/pages`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return res.json();
  },
};

export const pageImageUrl = (pageId: string) => `/api/pages/${pageId}/image`;
