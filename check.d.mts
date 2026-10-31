export const DESK: string;
export const FREE_LEADERBOARD: string;
export const CLAIM_URL: string;
export const DEFAULT_MAX_USDC: number;
export const GRADE_FORMULA_TEXT: string;

export type PaidDoor = {
  id: string;
  title: string;
  path: string;
  samplePath: string | null;
  amountAtomic: number;
  why: string;
  query: (t: Extract<Target, { ok: true }>) => Record<string, string>;
  localOk?: boolean;
};

export const PAID_DOORS: PaidDoor[];
export const OPTIONAL_DOORS: Array<{
  id: string;
  title: string;
  path: string;
  samplePath: string | null;
  amountAtomic: number;
  why: string;
}>;

export const GRADE_FORMULA: {
  paid_ok_pts: number;
  settled_pts: number;
  real_content_pts: number;
  latency_pts: number;
  uptime_streak_pts: number;
  latency_cap_ms: number;
  streak_cap_days: number;
  content_y: number;
  content_partial: number;
  content_n: number;
};

export type Target =
  | { ok: true; host: string; origin: string; endpoint: string; input: string }
  | { ok: false; error: string };

export type DoorCandidate = {
  url: string;
  listedUrl?: string;
  method?: string;
  http_status: number | null;
  elapsed_ms: number;
  amountAtomic: string | null;
  priceUsd: string | null;
  payTo: string | null;
  network: string | null;
  scheme: string | null;
  works: boolean;
  usable?: boolean;
  reason: string;
};

export type ExactRequest = {
  ok: boolean;
  missing: string[];
  url: string;
  method: string;
  body: unknown;
  source: string;
};

export type BazaarInput = {
  method: string | null;
  queryParams: Record<string, string> | null;
  body: unknown;
  requiredQuery: string[];
};

export type FullQuote = {
  ocp: ReturnType<typeof quotePaidDoors>;
  seller: {
    url: string;
    amountAtomic: number | null;
    priceUsd: string;
    payTo: string | null;
  } | null;
  maxUsdc: number;
  maxUsdcLabel: string;
  overCap: boolean;
  wouldPaySeller: boolean;
  refused_reason: string | null;
  totalAtomic: number;
  totalUsd: string;
};

export type GradeComponent = {
  status: "measured" | "unread";
  pts: number | null;
  value: unknown;
  why: string;
  tx_hash?: string | null;
};

export type ComputedGrade = {
  formula: typeof GRADE_FORMULA;
  grade: number | null;
  measured_pts: number | null;
  omitted: string[];
  note: string;
  components: {
    paid_ok: GradeComponent;
    settled: GradeComponent;
    real_content: GradeComponent;
    latency: GradeComponent;
    uptime_streak: GradeComponent;
  };
};

export function atomicToUsd(atomic: number | string): number | null;
export function formatUsd(n: number | null | undefined): string;
export function quotePaidDoors(doors?: PaidDoor[]): {
  doors: Array<{ id: string; title: string; path: string; amountAtomic: number; priceUsd: string }>;
  totalAtomic: number;
  totalUsd: string;
};
export function parseMaxUsdc(raw: string | number | null | undefined, fallback?: number): number | null;
export function quoteFullRun(opts?: {
  ocpDoors?: PaidDoor[];
  seller?: { url?: string; amountAtomic?: string | number | null; payTo?: string | null } | null;
  maxUsdc?: number;
}): FullQuote;
export function classifyPaidContent(input: {
  status?: number | null;
  contentType?: string | null;
  bodyText?: string;
  body?: unknown;
}): { class: "y" | "partial" | "n" | null; status: "measured" | "unread"; why: string };
export function parsePaidWrapper(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  exitCode: number,
): {
  exitCode: number;
  http_status: number | null;
  tx_hash: string | null;
  settled: { status: "measured" | "unread"; value: boolean | null; why: string; tx_hash?: string | null };
  elapsed_ms: number | null;
  latency_source: "wrapper_json" | "unpaid_402_probe" | "unread";
  latency_field: string | null;
  body: Record<string, unknown>;
  bodyText: string;
};
export const PAID_LATENCY_FIELDS: string[];
export function pickPaidLatency(input?: {
  wrapperJson?: unknown;
  nested?: unknown;
  unpaidProbeMs?: number | null;
}): { ms: number | null; source: "wrapper_json" | "unpaid_402_probe" | "unread"; field: string | null };
export function streakFromLeaderboard(row: unknown): number | null;
export function computeGrade(input?: {
  paid_ok?: boolean | null;
  settled?: boolean | null;
  settled_why?: string;
  tx_hash?: string | null;
  content?: "y" | "partial" | "n" | null;
  content_why?: string;
  latency_ms?: number | null;
  streak_days?: number | null;
}): ComputedGrade;
export function formatGrade(grade: ComputedGrade | null | undefined): string;
export function paidBodyForContent(parsed: ReturnType<typeof parsePaidWrapper>): {
  status: number | null;
  contentType: string;
  bodyText: string;
  body: Record<string, unknown> | null;
};
export function gradeFromPaidSeller(input: {
  parsed: ReturnType<typeof parsePaidWrapper>;
  elapsed_ms: number;
  streak_days: number | null;
}): { not_graded: boolean; reason: string | null; report: string; grade: ComputedGrade | null };
export function bazaarInputFrom402(body: unknown): BazaarInput;
export function openapiSamplesForPath(
  spec: unknown,
  doorUrl: string,
): { method: string | null; queryParams: Record<string, string> | null; requiredQuery: string[] };
export function sameDoorPath(a: string, b: string): boolean;
export function applyQueryParams(url: string, params: Record<string, string> | null | undefined): string;
export function mergeExactRequest(input: {
  doorUrl: string;
  listedMethod?: string;
  bazaar?: BazaarInput | null;
  leaderboardUrl?: string | null;
  openapi?: unknown;
}): ExactRequest;
export function isInvalidTargetStatus(status: number | null | undefined): boolean;
export function invalidTargetReason(input?: { status?: number | null; bodyText?: string }): string | null;
export function listedPaidDoors(origin: string, body: unknown): Array<{ url: string; method: string }>;
export function plannedFormulaFill(fullQuote: FullQuote): Record<string, { would: string; how: string }>;
export function parseTarget(raw: string | undefined): Target;
export function parse402Quote(
  body: unknown,
  status: number,
): {
  http_status: number;
  x402Version: unknown;
  serviceName: string | null;
  amountAtomic: string | null;
  priceUsd: string;
  network: string | null;
  scheme: string | null;
  facilitator: string | null;
  payTo: string | null;
};
export function listedPaidDoorUrls(origin: string, body: unknown): string[];
export function pickCheapestWorking(candidates: DoorCandidate[]): DoorCandidate | null;
export function pickCheapestUsable(candidates: DoorCandidate[]): DoorCandidate | null;
export function matchLeaderboardSeller(doc: unknown, host: string): Record<string, unknown> | null;
export function plannedCalls(
  target: Extract<Target, { ok: true }>,
  doors?: PaidDoor[],
  deskBase?: string,
  opts?: { seller?: DoorCandidate | null; maxUsdc?: number },
): {
  target: Extract<Target, { ok: true }>;
  deskBase: string;
  quote: ReturnType<typeof quotePaidDoors>;
  fullQuote: FullQuote;
  formulaFill: Record<string, { would: string; how: string }>;
  maxUsdc: number;
  free: Array<{ method: string; url: string; why: string }>;
  paid: Array<{
    id: string;
    title: string;
    method: string;
    url: string;
    sampleUrl: string | null;
    amountAtomic: number;
    priceUsd: string;
    why: string;
    desk: boolean;
  }>;
  optional: Array<{ id: string; url: string; sampleUrl: string | null; priceUsd: string; why: string }>;
};
export function formatDryRun(
  plan: unknown,
  hits: unknown[],
  extra?: { grade?: ComputedGrade | null; not_graded?: string | null },
): string;
export function compareSellerDoors(
  origin: string,
  opts?: { leaderboardUrl?: string | null; openapi?: unknown },
): Promise<{
  wellKnown: { url: string; status: number | null; body: unknown; error?: string; elapsed_ms: number };
  listed_n: number;
  capped: boolean;
  candidates: DoorCandidate[];
  cheapest: DoorCandidate | null;
  abort_reason: string | null;
}>;
export function runDryRun(
  target: Extract<Target, { ok: true }>,
  deskBase?: string,
  maxUsdc?: number,
): Promise<{ plan: unknown; hits: unknown[]; compared: unknown; grade: ComputedGrade | null; text: string }>;
export function main(
  argv?: string[],
  io?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void; exit: (code: number) => void },
): Promise<void>;
