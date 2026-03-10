import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ProposalStatus = {
  Pending: "pending",
  Disputed: "disputed",
  Finalized: "finalized",
} as const;

export type ProposalStatus =
  (typeof ProposalStatus)[keyof typeof ProposalStatus];

export const ProposalStatusSchema = z.enum([
  "pending",
  "disputed",
  "finalized",
]);

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface Proposal {
  /** Unique proposal identifier. */
  id: string;
  /** Market being resolved. */
  marketId: string;
  /** Index of the proposed winning outcome. */
  proposedOutcome: number;
  /** Address of the proposer. */
  proposer: string;
  /** ISO-8601 timestamp when the proposal was submitted. */
  proposedAt: string;
  /** Current status of the proposal. */
  status: ProposalStatus;
  /** Whether the proposal has been finalized on-chain. */
  finalized: boolean;
  /** ISO-8601 timestamp when the dispute period ends. */
  disputeDeadline: string;
}

export const ProposalSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  proposedOutcome: z.number().int().nonnegative(),
  proposer: z.string(),
  proposedAt: z.string().datetime(),
  status: ProposalStatusSchema,
  finalized: z.boolean(),
  disputeDeadline: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

export interface Dispute {
  /** Unique dispute identifier. */
  id: string;
  /** Proposal being disputed. */
  proposalId: string;
  /** Market the dispute is about. */
  marketId: string;
  /** Address of the disputer. */
  disputer: string;
  /** Reason for the dispute. */
  reason: string;
  /** ISO-8601 timestamp of the dispute. */
  disputedAt: string;
}

export const DisputeSchema = z.object({
  id: z.string(),
  proposalId: z.string(),
  marketId: z.string(),
  disputer: z.string(),
  reason: z.string().min(1),
  disputedAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// Resolution Events
// ---------------------------------------------------------------------------

export const ResolutionEventType = {
  ProposalSubmitted: "proposal_submitted",
  ProposalDisputed: "proposal_disputed",
  MarketResolved: "market_resolved",
  MarketVoided: "market_voided",
} as const;

export type ResolutionEventType =
  (typeof ResolutionEventType)[keyof typeof ResolutionEventType];

export const ResolutionEventTypeSchema = z.enum([
  "proposal_submitted",
  "proposal_disputed",
  "market_resolved",
  "market_voided",
]);

export interface ResolutionEvent {
  /** Unique event identifier. */
  id: string;
  /** Type of resolution event. */
  type: ResolutionEventType;
  /** Market the event pertains to. */
  marketId: string;
  /** On-chain transaction hash. */
  txHash: string;
  /** Block number. */
  blockNumber: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Event-specific payload. */
  payload: ProposalSubmittedPayload | ProposalDisputedPayload | MarketResolvedPayload | MarketVoidedPayload;
}

export interface ProposalSubmittedPayload {
  proposalId: string;
  proposer: string;
  proposedOutcome: number;
}

export interface ProposalDisputedPayload {
  proposalId: string;
  disputer: string;
  reason: string;
}

export interface MarketResolvedPayload {
  winningOutcome: number;
  proposalId: string;
}

export interface MarketVoidedPayload {
  reason: string;
}

export const ProposalSubmittedPayloadSchema = z.object({
  proposalId: z.string(),
  proposer: z.string(),
  proposedOutcome: z.number().int().nonnegative(),
});

export const ProposalDisputedPayloadSchema = z.object({
  proposalId: z.string(),
  disputer: z.string(),
  reason: z.string(),
});

export const MarketResolvedPayloadSchema = z.object({
  winningOutcome: z.number().int().nonnegative(),
  proposalId: z.string(),
});

export const MarketVoidedPayloadSchema = z.object({
  reason: z.string(),
});

export const ResolutionEventSchema = z.object({
  id: z.string(),
  type: ResolutionEventTypeSchema,
  marketId: z.string(),
  txHash: z.string(),
  blockNumber: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  payload: z.union([
    ProposalSubmittedPayloadSchema,
    ProposalDisputedPayloadSchema,
    MarketResolvedPayloadSchema,
    MarketVoidedPayloadSchema,
  ]),
});
