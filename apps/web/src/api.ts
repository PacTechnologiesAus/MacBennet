import type {
  ApprovalDto,
  AuditEventDto,
  BudgetStatusDto,
  CreateProjectRequest,
  CreateRunRequest,
  CreateTaskRequest,
  CurrentUser,
  DashboardDto,
  EnrollmentTokenDto,
  JobDescriptor,
  ProjectDto,
  RunDto,
  RunLogDto,
  SettingsDto,
  TaskDto,
  UpdateProjectRequest,
  UpdateSettingsRequest,
  UpdateTaskRequest,
  WorkerDto,
} from '@mac/protocol';

/**
 * Typed API client.
 *
 * Every request and response type is imported from @mac/protocol, the same
 * package the server validates against — so an incompatible API change is a
 * compile error here rather than a runtime surprise in front of an operator.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    // The session cookie is HttpOnly, so it must be sent by the browser rather
    // than attached by this code — which is the point of it being HttpOnly.
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = (payload.error ?? {}) as { code?: string; message?: string; details?: unknown };
    throw new ApiError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? `Request failed (${response.status})`,
      error.details,
    );
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);

export const api = {
  // --- Auth ---------------------------------------------------------------
  login: (email: string, password: string) => post<{ user: CurrentUser }>('/api/auth/login', { email, password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  me: () => get<{ user: CurrentUser }>('/api/auth/me'),

  // --- Dashboard ----------------------------------------------------------
  dashboard: () => get<DashboardDto>('/api/dashboard'),

  // --- Projects -----------------------------------------------------------
  listProjects: () => get<{ projects: ProjectDto[] }>('/api/projects'),
  getProject: (id: string) => get<{ project: ProjectDto; tasks: TaskDto[] }>(`/api/projects/${id}`),
  createProject: (body: CreateProjectRequest) => post<{ project: ProjectDto }>('/api/projects', body),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    patch<{ project: ProjectDto }>(`/api/projects/${id}`, body),

  // --- Tasks --------------------------------------------------------------
  listTasks: (projectId?: string) =>
    get<{ tasks: TaskDto[] }>(`/api/tasks${projectId ? `?projectId=${projectId}` : ''}`),
  getTask: (id: string) => get<{ task: TaskDto; runs: RunDto[] }>(`/api/tasks/${id}`),
  createTask: (body: CreateTaskRequest) => post<{ task: TaskDto }>('/api/tasks', body),
  updateTask: (id: string, body: UpdateTaskRequest) => patch<{ task: TaskDto }>(`/api/tasks/${id}`, body),

  // --- Runs ---------------------------------------------------------------
  listRuns: (params: { taskId?: string; status?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.taskId) query.set('taskId', params.taskId);
    if (params.status) query.set('status', params.status);
    const suffix = query.toString();
    return get<{ runs: RunDto[] }>(`/api/runs${suffix ? `?${suffix}` : ''}`);
  },
  getRun: (id: string) =>
    get<{ run: RunDto; approvals: ApprovalDto[]; auditEvents: AuditEventDto[] }>(`/api/runs/${id}`),
  getRunLogs: (id: string, afterId?: number) =>
    get<{ logs: RunLogDto[]; cursor: number | null }>(
      `/api/runs/${id}/logs${afterId !== undefined ? `?afterId=${afterId}` : ''}`,
    ),
  createRun: (body: CreateRunRequest) => post<{ run: RunDto }>('/api/runs', body),
  submitRun: (id: string) => post<{ run: RunDto }>(`/api/runs/${id}/submit`),
  approveRun: (id: string, body: { notes?: string; acknowledgeBelowThreshold?: boolean }) =>
    post<{ run: RunDto }>(`/api/runs/${id}/approve`, body),
  rejectRun: (id: string, notes: string) => post<{ run: RunDto }>(`/api/runs/${id}/reject`, { notes }),
  cancelRun: (id: string, reason?: string) => post<{ run: RunDto }>(`/api/runs/${id}/cancel`, { reason }),
  forceCancelRun: (id: string, reason?: string) => post<{ run: RunDto }>(`/api/runs/${id}/force-cancel`, { reason }),
  jobCatalogue: () => get<{ jobs: JobDescriptor[] }>('/api/job-catalogue'),

  // --- Workers ------------------------------------------------------------
  listWorkers: () => get<{ workers: WorkerDto[] }>('/api/workers'),
  createEnrollmentToken: (label: string, expiresInHours: number) =>
    post<{ token: EnrollmentTokenDto }>('/api/worker-enrollment-tokens', { label, expiresInHours }),
  listEnrollmentTokens: () => get<{ tokens: EnrollmentTokenDto[] }>('/api/worker-enrollment-tokens'),

  // --- Settings, budget, audit -------------------------------------------
  getSettings: () => get<{ settings: SettingsDto }>('/api/settings'),
  updateSettings: (body: UpdateSettingsRequest) => patch<{ settings: SettingsDto }>('/api/settings', body),
  getBudget: () => get<{ budget: BudgetStatusDto }>('/api/budget'),
  listAudit: (params: { runId?: string; projectId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.runId) query.set('runId', params.runId);
    if (params.projectId) query.set('projectId', params.projectId);
    query.set('limit', String(params.limit ?? 100));
    return get<{ events: AuditEventDto[] }>(`/api/audit?${query.toString()}`);
  },
};
