import type {
  AgentQuestionDto,
  ApprovalDto,
  AuditEventDto,
  BriefDto,
  BudgetStatusDto,
  CodingRunDetailDto,
  CreateCodingRunRequest,
  CreateRepositoryRequest,
  DiscoverySessionDto,
  MorningReportDto,
  RepositoryDto,
  StartDiscoveryRequest,
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
  // --- Sprint 3 ---
  CreateMondayBoardRequest,
  EmailDeliveryDto,
  InvestigationDto,
  MondayBoardDto,
  MondayItemDto,
  MondayWriteDto,
  NightCandidateDto,
  NightDecisionDto,
  NightShiftDashboardDto,
  NightShiftDto,
  SecurityOverviewDto,
  UpdateMondayBoardRequest,
  WorkerTokenDto,
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

  // --- Repositories (Sprint 2) --------------------------------------------
  listRepositories: (projectId?: string) =>
    get<{ repositories: RepositoryDto[] }>(`/api/repositories${projectId ? `?projectId=${projectId}` : ''}`),
  createRepository: (body: CreateRepositoryRequest) =>
    post<{ repository: RepositoryDto }>('/api/repositories', body),
  approveRepository: (id: string, approved: boolean, notes?: string) =>
    post<{ repository: RepositoryDto }>(`/api/repositories/${id}/approve`, { approved, notes }),

  // --- Discovery and briefs (Sprint 2) -------------------------------------
  listDiscovery: (projectId?: string) =>
    get<{ sessions: DiscoverySessionDto[] }>(`/api/discovery${projectId ? `?projectId=${projectId}` : ''}`),
  getDiscovery: (id: string) => get<{ session: DiscoverySessionDto }>(`/api/discovery/${id}`),
  startDiscovery: (body: StartDiscoveryRequest) =>
    post<{ session: DiscoverySessionDto }>('/api/discovery', body),
  sendDiscoveryMessage: (id: string, message: string) =>
    post<{ session: DiscoverySessionDto }>(`/api/discovery/${id}/messages`, { message }),
  generateBrief: (id: string) =>
    post<{ session: DiscoverySessionDto; brief: BriefDto }>(`/api/discovery/${id}/brief`, {}),
  getBrief: (id: string) => get<{ brief: BriefDto }>(`/api/briefs/${id}`),
  getTaskBrief: (taskId: string) => get<{ brief: BriefDto | null }>(`/api/tasks/${taskId}/brief`),

  // --- Coding runs (Sprint 2) ----------------------------------------------
  createCodingRun: (body: CreateCodingRunRequest) => post<{ run: RunDto }>('/api/coding-runs', body),
  getCodingRun: (id: string) => get<{ detail: CodingRunDetailDto }>(`/api/runs/${id}/coding`),
  getRunQuestions: (id: string) => get<{ questions: AgentQuestionDto[] }>(`/api/runs/${id}/questions`),
  getRunReport: (id: string) => get<{ report: MorningReportDto }>(`/api/runs/${id}/report`),
  listReports: (since?: string) =>
    get<{ reports: MorningReportDto[] }>(`/api/reports${since ? `?since=${since}` : ''}`),

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

  // --- Night shift (Sprint 3) ----------------------------------------------
  nightShift: () => get<{ dashboard: NightShiftDashboardDto }>('/api/night-shift'),
  nightQueue: () => get<{ queue: NightCandidateDto[] }>('/api/night-shift/queue'),
  nightDecisions: (shiftId: string) =>
    get<{ decisions: NightDecisionDto[] }>(`/api/night-shift/${shiftId}/decisions`),
  startNightShift: (body: { cutoffAt?: string; notes?: string } = {}) =>
    post<{ shift: NightShiftDto }>('/api/night-shift/start', body),
  stopNightShift: (reason?: string) =>
    post<{ shift: NightShiftDto | null }>('/api/night-shift/stop', { reason }),
  tickNightShift: () => post<{ result: unknown }>('/api/night-shift/tick'),

  // --- monday.com (Sprint 3) -----------------------------------------------
  listMondayBoards: () => get<{ boards: MondayBoardDto[] }>('/api/monday/boards'),
  createMondayBoard: (body: CreateMondayBoardRequest) =>
    post<{ board: MondayBoardDto }>('/api/monday/boards', body),
  updateMondayBoard: (id: string, body: UpdateMondayBoardRequest) =>
    patch<{ board: MondayBoardDto }>(`/api/monday/boards/${id}`, body),
  approveMondayBoard: (id: string, approved: boolean, notes?: string) =>
    post<{ board: MondayBoardDto }>(`/api/monday/boards/${id}/approve`, { approved, notes }),
  syncMondayBoard: (id: string) => post<{ result: unknown }>(`/api/monday/boards/${id}/sync`),
  listMondayItems: (projectId?: string) =>
    get<{ items: MondayItemDto[] }>(`/api/monday/items${projectId ? `?projectId=${projectId}` : ''}`),
  listMondayWrites: (runId?: string) =>
    get<{ writes: MondayWriteDto[] }>(`/api/monday/writes${runId ? `?runId=${runId}` : ''}`),
  approveProjectNightShift: (projectId: string, approved: boolean) =>
    post<{ result: { projectId: string; approved: boolean } }>(
      `/api/projects/${projectId}/night-shift-approval`,
      { approved },
    ),

  // --- Security (Sprint 3) --------------------------------------------------
  security: () => get<{ security: SecurityOverviewDto }>('/api/security'),
  rotateWorkerToken: (workerId: string, reason?: string) =>
    post<{ rotationRequested: boolean }>(`/api/workers/${workerId}/rotate`, { reason }),
  revokeWorkerTokens: (workerId: string, reason: string) =>
    post<{ revoked: number }>(`/api/workers/${workerId}/revoke-tokens`, { reason }),
  listWorkerTokens: (workerId: string) => get<{ tokens: WorkerTokenDto[] }>(`/api/workers/${workerId}/tokens`),

  // --- Report delivery (Sprint 3) -------------------------------------------
  listDeliveries: () => get<{ deliveries: EmailDeliveryDto[] }>('/api/reports/deliveries'),
  retryDelivery: (id: string) => post<{ delivery: EmailDeliveryDto }>(`/api/reports/deliveries/${id}/retry`),

  // --- Investigations (Sprint 3) --------------------------------------------
  listInvestigations: (params: { taskId?: string; runId?: string }) => {
    const query = new URLSearchParams();
    if (params.taskId) query.set('taskId', params.taskId);
    if (params.runId) query.set('runId', params.runId);
    return get<{ investigations: InvestigationDto[] }>(`/api/investigations?${query.toString()}`);
  },
};
