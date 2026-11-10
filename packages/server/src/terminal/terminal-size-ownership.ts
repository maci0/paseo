import type { TerminalSession } from "./terminal.js";

interface TerminalSizeRequest {
  rows: number;
  cols: number;
  intent?: "claim" | "update";
}

// Each claim is a fresh object. The terminal holds its current claim and each owner weakly knows
// the claims it made, so a terminal never keeps its owner alive. scriptc has no `WeakRef`.
const terminalSizeClaims = new WeakMap<TerminalSession, object>();
const ownerSizeClaims = new WeakMap<object, WeakSet<object>>();

export function applyTerminalSize(
  terminal: TerminalSession,
  owner: object,
  request: TerminalSizeRequest,
): boolean {
  const intent = resolveTerminalSizeIntent(request.intent);
  if (intent === "update" && !ownsTerminalSize(terminal, owner)) {
    return false;
  }

  if (intent === "claim") {
    const claim = {};
    terminalSizeClaims.set(terminal, claim);
    let claims = ownerSizeClaims.get(owner);
    if (!claims) {
      claims = new WeakSet();
      ownerSizeClaims.set(owner, claims);
    }
    claims.add(claim);
  }

  const currentSize = terminal.getSize();
  if (currentSize.rows !== request.rows || currentSize.cols !== request.cols) {
    terminal.send({ type: "resize", rows: request.rows, cols: request.cols });
  }
  return true;
}

function ownsTerminalSize(terminal: TerminalSession, owner: object): boolean {
  const claim = terminalSizeClaims.get(terminal);
  return claim !== undefined && ownerSizeClaims.get(owner)?.has(claim) === true;
}

function resolveTerminalSizeIntent(intent: TerminalSizeRequest["intent"]): "claim" | "update" {
  if (intent) {
    return intent;
  }
  // COMPAT(terminalSizeOwnership): added in v0.2.6, remove after 2027-02-02 once the client floor sends resize intent.
  return "claim";
}
