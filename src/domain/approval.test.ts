import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { type Member, approvalChain, canCommit, canDecide, nextInChain, planApproval } from "./approval";

const owner: Member = { userId: "owner", role: "owner", limitPaise: 0 };
const admin: Member = { userId: "admin", role: "admin", limitPaise: 500_000 };
const buyerP: Member = { userId: "p-buyer", role: "purchase", limitPaise: 100_000 };
const buyerQ: Member = { userId: "q-buyer", role: "purchase", limitPaise: 100_000 };
const viewer: Member = { userId: "viewer", role: "viewer", limitPaise: 9_000_000_000 };
const clerk: Member = { userId: "clerk", role: "accountant", limitPaise: 0 };
const everyone = [owner, admin, buyerP, buyerQ, viewer, clerk];

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain: ${String(e)}`;
  }
  return undefined;
}

describe("canCommit", () => {
  it("lets an owner commit any amount", () => {
    expect(canCommit(owner, 99_000_000_000)).toBe(true);
  });

  it("holds everyone else to their limit, inclusive", () => {
    expect(canCommit(buyerP, 100_000)).toBe(true);
    expect(canCommit(buyerP, 100_001)).toBe(false);
    expect(canCommit(clerk, 1)).toBe(false);
    expect(canCommit(clerk, 0)).toBe(true);
  });

  it("never lets a viewer commit, whatever their limit says", () => {
    expect(canCommit(viewer, 1)).toBe(false);
  });
});

describe("approvalChain", () => {
  it("climbs from the lowest sufficient limit to the owner, leaving out the requester", () => {
    // Rs 1,500: the buyers' Rs 1,000 limit is too low, the viewer cannot, the clerk has none
    expect(approvalChain(150_000, buyerP.userId, everyone).map((m) => m.userId)).toEqual(["admin", "owner"]);
    expect(approvalChain(150_000, admin.userId, everyone).map((m) => m.userId)).toEqual(["owner"]);
  });

  it("includes peers whose limit is high enough, ordered by limit then id", () => {
    expect(approvalChain(50_000, buyerP.userId, everyone).map((m) => m.userId)).toEqual(["q-buyer", "admin", "owner"]);
    expect(approvalChain(50_000, "someone-else", everyone).map((m) => m.userId)).toEqual(["p-buyer", "q-buyer", "admin", "owner"]);
  });
});

describe("planApproval", () => {
  it("approves at once within the requester's own limit", () => {
    expect(planApproval({ amountPaise: 50_000, requester: buyerP, members: everyone })).toEqual({ auto: true });
    expect(planApproval({ amountPaise: 9_999_999_999, requester: owner, members: everyone })).toEqual({ auto: true });
  });

  it("assigns the next person with enough authority when it is above the requester's limit", () => {
    const plan = planApproval({ amountPaise: 150_000, requester: buyerP, members: everyone });
    expect(plan).toMatchObject({ auto: false, assignee: { userId: "admin" } });
    const higher = planApproval({ amountPaise: 600_000, requester: buyerP, members: everyone });
    expect(higher).toMatchObject({ auto: false, assignee: { userId: "owner" } });
  });

  it("fails clearly when nobody can approve", () => {
    expect(codeOf(() => planApproval({ amountPaise: 150_000, requester: buyerP, members: [buyerP, viewer, clerk] }))).toBe("NO_APPROVER");
  });
});

describe("canDecide", () => {
  const ask = { requesterId: buyerP.userId, amountPaise: 150_000 };

  it("allows someone with enough authority", () => {
    expect(canDecide({ actor: admin, ...ask })).toBe(true);
    expect(canDecide({ actor: owner, ...ask })).toBe(true);
  });

  it("refuses the requester, someone under the limit, and a viewer", () => {
    expect(canDecide({ actor: buyerP, ...ask })).toBe(false);
    expect(canDecide({ actor: buyerQ, ...ask })).toBe(false);
    expect(canDecide({ actor: viewer, ...ask })).toBe(false);
  });
});

describe("nextInChain", () => {
  const chain = [admin, owner];
  it("moves one step up, and stops at the top", () => {
    expect(nextInChain(chain, "admin")?.userId).toBe("owner");
    expect(nextInChain(chain, "owner")).toBeUndefined();
    expect(nextInChain(chain, null)?.userId).toBe("admin");
  });
});
