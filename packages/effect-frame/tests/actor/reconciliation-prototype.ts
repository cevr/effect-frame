/* oxlint-disable effect/noNullish -- The prototype models unobserved evidence explicitly. */

/**
 * Private issue-67 prototype. This file is test evidence, not package API.
 *
 * The classifier treats a receipt as settlement evidence. A stream projection
 * supplies a committed base only. It never supplies command identity.
 */

export type Membership = "included" | "excluded" | "unknown";

export interface ReceiptAnchor {
  readonly commandId: string;
  readonly admitted: number;
  readonly revision: number;
}

export interface Candidate<State> {
  readonly revision: number;
  readonly state: State;
}

export interface PendingOverlay<State> {
  readonly commandId: string;
  /** Undefined means that the client has not observed admission yet. */
  readonly admitted: number | undefined;
  readonly predict: (state: State) => State;
}

export interface Reconciliation<State> {
  readonly base: Candidate<State>;
  readonly visible: State;
  readonly held: Candidate<State> | undefined;
}

export const exactMembership = (receiptRevision: number, candidateRevision: number): Membership => {
  if (receiptRevision <= candidateRevision) return "included";
  return "excluded";
};

/**
 * Classifies another admission using one exact receipt anchor.
 *
 * The anchor proves the prefix through its own admission when its revision is
 * in the candidate. If the anchor is newer than the candidate, it proves the
 * suffix after its admission is absent. The interval after an older anchor is
 * unknown because autonomous revisions and later commands may have advanced
 * the candidate independently.
 */
export const anchoredMembership = (
  anchor: Pick<ReceiptAnchor, "admitted" | "revision"> | undefined,
  candidateRevision: number,
  admission: number | undefined,
): Membership => {
  if (anchor === undefined || admission === undefined) return "unknown";
  if (anchor.revision > candidateRevision) return "excluded";
  if (admission <= anchor.admitted) return "included";
  if (anchor.revision === candidateRevision) return "excluded";
  return "unknown";
};

const membershipFor = <State>(
  pending: PendingOverlay<State>,
  candidateRevision: number,
  receipts: ReadonlyMap<string, ReceiptAnchor>,
  anchor: ReceiptAnchor | undefined,
): Membership => {
  const receipt = receipts.get(pending.commandId);
  if (receipt !== undefined) {
    return exactMembership(receipt.revision, candidateRevision);
  }
  return anchoredMembership(anchor, candidateRevision, pending.admitted);
};

/**
 * Publishes a candidate only when every overlay is classified. Unknown
 * membership keeps the previous coherent view and retains the candidate as a
 * single conflated held value.
 */
export const reconcile = <State>(
  previous: Reconciliation<State>,
  candidate: Candidate<State>,
  pending: ReadonlyArray<PendingOverlay<State>>,
  receipts: ReadonlyMap<string, ReceiptAnchor>,
  anchor: ReceiptAnchor | undefined,
): Reconciliation<State> => {
  if (candidate.revision < previous.base.revision) return previous;

  let visible = candidate.state;
  let held: Candidate<State> | undefined;
  for (const item of pending) {
    const membership = membershipFor(item, candidate.revision, receipts, anchor);
    if (membership === "unknown") {
      held = candidate;
      break;
    }
    if (membership === "excluded") {
      visible = item.predict(visible);
    }
  }

  if (held !== undefined) {
    return { base: previous.base, visible: previous.visible, held };
  }
  return { base: candidate, visible, held: undefined };
};

export type CommandIdentity = "generated" | "supplied";
export type PredictionPolicy = "predict-immediately" | "await-receipt";

export const predictionPolicy = (identity: CommandIdentity): PredictionPolicy => {
  if (identity === "generated") return "predict-immediately";
  return "await-receipt";
};

export type RefusalAfterAdmission = "uncertain" | "rejected";

/** A later refusal cannot erase the possibility that an earlier request committed. */
export const classifyRefusalAfterPossibleAdmission = (
  possibleAdmission: boolean,
): RefusalAfterAdmission => {
  if (possibleAdmission) return "uncertain";
  return "rejected";
};
