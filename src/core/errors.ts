// Typed errors. One table drives CLI exit codes and HTTP status codes (spec §5).

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  conflict: 3,
  leaseHeld: 4,
  checkFailed: 5,
  notFound: 6,
  busy: 7,
  state: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const HTTP: Record<string, number> = {
  USAGE: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  LEASE_HELD: 409,
  SYNC_CONFLICT: 409,
  REVERT_CONFLICT: 409,
  INVALID_STATE: 409,
  NOTHING_TO_SUBMIT: 409,
  TRUNK_RED: 409,
  QUEUE_BUSY: 429,
  BUDGET_EXCEEDED: 429,
  WAIT_TIMEOUT: 429,
  COORDINATOR_BUSY: 503,
  TRUNK_MOVED: 503,
  UPSTREAM_ARTIFACTS: 502,
  UPSTREAM_RUNNER: 502,
  INTERNAL: 500,
};

export class WeftError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly retryable: boolean;
  readonly hint: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { exitCode?: ExitCode; retryable?: boolean; hint?: string | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "WeftError";
    this.code = code;
    this.exitCode = opts.exitCode ?? EXIT.internal;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint ?? null;
    this.details = opts.details ?? {};
  }

  get status(): number {
    return HTTP[this.code] ?? 500;
  }

  toJSON(): { code: string; message: string; retryable: boolean; hint: string | null; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, retryable: this.retryable, hint: this.hint, details: this.details };
  }
}

export const usage = (message: string, hint: string | null = null): WeftError =>
  new WeftError("USAGE", message, { exitCode: EXIT.usage, hint });

export const notFound = (what: string, id: string, hint: string | null = null): WeftError =>
  new WeftError("NOT_FOUND", `${what} not found: ${id}`, { exitCode: EXIT.notFound, hint, details: { what, id } });

export const invalidState = (message: string, hint: string | null = null): WeftError =>
  new WeftError("INVALID_STATE", message, { exitCode: EXIT.state, hint });

export const unauthenticated = (message: string): WeftError =>
  new WeftError("UNAUTHENTICATED", message, { exitCode: EXIT.usage, hint: "set WEFT_TOKEN to an agent token from `weft agent register`" });

export const forbidden = (message: string): WeftError => new WeftError("FORBIDDEN", message, { exitCode: EXIT.usage });

export const toWeftError = (err: unknown): WeftError => {
  if (err instanceof WeftError) return err;
  if (isWeftErrorShape(err)) {
    return new WeftError(err.code, err.message, { retryable: err.retryable, hint: err.hint, details: err.details });
  }
  if (err instanceof Error) return new WeftError("INTERNAL", err.message);
  return new WeftError("INTERNAL", String(err));
};

// Errors crossing a Durable Object RPC boundary arrive as plain Errors; we tag the message
// with a JSON payload so the code survives the hop.
const TAG = "WEFT_ERROR::";

export const encodeForRpc = (e: WeftError): Error => new Error(`${TAG}${JSON.stringify(e.toJSON())}`);

export const decodeFromRpc = (err: unknown): WeftError => {
  if (err instanceof Error && err.message.includes(TAG)) {
    const raw = err.message.slice(err.message.indexOf(TAG) + TAG.length);
    try {
      const j = JSON.parse(raw) as { code: string; message: string; retryable: boolean; hint: string | null; details: Record<string, unknown> };
      return new WeftError(j.code, j.message, { retryable: j.retryable, hint: j.hint, details: j.details, exitCode: exitFor(j.code) });
    } catch (parseErr: unknown) {
      return new WeftError("INTERNAL", `undecodable RPC error: ${String(parseErr)}`);
    }
  }
  return toWeftError(err);
};

export const exitFor = (code: string): ExitCode => {
  switch (code) {
    case "USAGE":
    case "UNAUTHENTICATED":
    case "FORBIDDEN":
      return EXIT.usage;
    case "SYNC_CONFLICT":
    case "REVERT_CONFLICT":
    case "CONFLICT_MARKERS":
      return EXIT.conflict;
    case "LEASE_HELD":
      return EXIT.leaseHeld;
    case "TRUNK_RED":
    case "RECIPE_FAILED":
      return EXIT.checkFailed;
    case "BUDGET_EXCEEDED":
    case "WAIT_TIMEOUT":
      return EXIT.busy;
    case "NOT_FOUND":
      return EXIT.notFound;
    case "QUEUE_BUSY":
    case "COORDINATOR_BUSY":
    case "TRUNK_MOVED":
      return EXIT.busy;
    case "INVALID_STATE":
    case "NOTHING_TO_SUBMIT":
    case "ALREADY_EXISTS":
      return EXIT.state;
    default:
      return EXIT.internal;
  }
};

const isWeftErrorShape = (
  v: unknown,
): v is { code: string; message: string; retryable: boolean; hint: string | null; details: Record<string, unknown> } =>
  typeof v === "object" && v !== null && "code" in v && "message" in v && typeof (v as { code: unknown }).code === "string";
