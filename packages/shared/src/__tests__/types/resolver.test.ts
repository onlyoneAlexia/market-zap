import { describe, it, expect } from "vitest";
import {
  ProposalSchema,
  ProposalStatusSchema,
  DisputeSchema,
  ResolutionEventSchema,
  ResolutionEventTypeSchema,
} from "../../types/resolver";

// ---------------------------------------------------------------------------
// ProposalStatusSchema
// ---------------------------------------------------------------------------

describe("ProposalStatusSchema", () => {
  it.each(["pending", "disputed", "finalized"])(
    "accepts %s",
    (status) => {
      expect(ProposalStatusSchema.safeParse(status).success).toBe(true);
    },
  );

  it("rejects invalid", () => {
    expect(ProposalStatusSchema.safeParse("rejected").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProposalSchema
// ---------------------------------------------------------------------------

describe("ProposalSchema", () => {
  const validProposal = {
    id: "p1",
    marketId: "m1",
    proposedOutcome: 0,
    proposer: "0xadmin",
    proposedAt: "2025-01-01T00:00:00Z",
    status: "pending",
    finalized: false,
    disputeDeadline: "2025-01-02T00:00:00Z",
  };

  it("accepts a valid proposal", () => {
    expect(ProposalSchema.safeParse(validProposal).success).toBe(true);
  });

  it("rejects negative proposedOutcome", () => {
    expect(ProposalSchema.safeParse({ ...validProposal, proposedOutcome: -1 }).success).toBe(false);
  });

  it("rejects invalid datetime", () => {
    expect(ProposalSchema.safeParse({ ...validProposal, proposedAt: "bad-date" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DisputeSchema
// ---------------------------------------------------------------------------

describe("DisputeSchema", () => {
  const validDispute = {
    id: "d1",
    proposalId: "p1",
    marketId: "m1",
    disputer: "0xuser",
    reason: "Incorrect resolution",
    disputedAt: "2025-01-01T12:00:00Z",
  };

  it("accepts a valid dispute", () => {
    expect(DisputeSchema.safeParse(validDispute).success).toBe(true);
  });

  it("rejects empty reason", () => {
    expect(DisputeSchema.safeParse({ ...validDispute, reason: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ResolutionEventTypeSchema
// ---------------------------------------------------------------------------

describe("ResolutionEventTypeSchema", () => {
  it.each([
    "proposal_submitted",
    "proposal_disputed",
    "market_resolved",
    "market_voided",
  ])("accepts %s", (type) => {
    expect(ResolutionEventTypeSchema.safeParse(type).success).toBe(true);
  });

  it("rejects invalid", () => {
    expect(ResolutionEventTypeSchema.safeParse("cancelled").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ResolutionEventSchema
// ---------------------------------------------------------------------------

describe("ResolutionEventSchema", () => {
  it("accepts a proposal_submitted event", () => {
    const event = {
      id: "ev1",
      type: "proposal_submitted",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: 12345,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        proposalId: "p1",
        proposer: "0xadmin",
        proposedOutcome: 0,
      },
    };
    expect(ResolutionEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a market_resolved event", () => {
    const event = {
      id: "ev2",
      type: "market_resolved",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: 12346,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        winningOutcome: 0,
        proposalId: "p1",
      },
    };
    expect(ResolutionEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a market_voided event", () => {
    const event = {
      id: "ev3",
      type: "market_voided",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: 12347,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        reason: "No valid resolution",
      },
    };
    expect(ResolutionEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts a proposal_disputed event", () => {
    const event = {
      id: "ev4",
      type: "proposal_disputed",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: 12348,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        proposalId: "p1",
        disputer: "0xuser",
        reason: "Wrong outcome",
      },
    };
    expect(ResolutionEventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects negative blockNumber", () => {
    const event = {
      id: "ev1",
      type: "proposal_submitted",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: -1,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        proposalId: "p1",
        proposer: "0xadmin",
        proposedOutcome: 0,
      },
    };
    expect(ResolutionEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts event with mismatched type/payload (union is loose)", () => {
    // Zod union accepts any payload that matches ANY variant — verify this behavior
    const event = {
      id: "ev5",
      type: "market_voided",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: 100,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        // This is a ProposalSubmittedPayload, not MarketVoidedPayload
        proposalId: "p1",
        proposer: "0xadmin",
        proposedOutcome: 0,
      },
    };
    // The union accepts this because the payload matches ProposalSubmittedPayloadSchema
    const result = ResolutionEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects payload matching no union variant", () => {
    const event = {
      id: "ev6",
      type: "market_resolved",
      marketId: "m1",
      txHash: "0xhash",
      blockNumber: 100,
      timestamp: "2025-01-01T00:00:00Z",
      payload: {
        unknownField: "not valid for any variant",
      },
    };
    expect(ResolutionEventSchema.safeParse(event).success).toBe(false);
  });
});
