import { describe, expect, it } from "vitest";
import { computeBubble, tierOf, tierThresholds } from "./compute.js";

const ME = "did:plc:me";

describe("computeBubble", () => {
  it("counts how many of my follows follow each second-degree account", () => {
    const lists = new Map([
      ["did:plc:a", ["did:plc:x", "did:plc:y"]],
      ["did:plc:b", ["did:plc:x"]],
    ]);

    const members = computeBubble(ME, lists);

    const byDid = new Map(members.map((m) => [m.did, m]));
    expect(byDid.get("did:plc:x")?.commonCount).toBe(2);
    expect(byDid.get("did:plc:y")?.commonCount).toBe(1);
  });

  it("excludes myself and accounts I already follow", () => {
    const lists = new Map([
      ["did:plc:a", ["did:plc:b", ME, "did:plc:x"]],
      ["did:plc:b", ["did:plc:a"]],
    ]);

    expect(computeBubble(ME, lists).map((m) => m.did)).toEqual(["did:plc:x"]);
  });

  it("weights follows from selective accounts higher (Adamic-Adar)", () => {
    const manyFollows = Array.from({ length: 999 }, (_, i) => `did:plc:n${i}`);
    const lists = new Map([
      // Follows only 2 accounts: strong signal for x
      ["did:plc:picky", ["did:plc:x", "did:plc:z"]],
      // Follows 1000 accounts: weak signal for y
      ["did:plc:everyone", ["did:plc:y", ...manyFollows]],
    ]);

    const byDid = new Map(computeBubble(ME, lists).map((m) => [m.did, m]));

    expect(byDid.get("did:plc:x")!.score).toBeCloseTo(1 / Math.log(3));
    expect(byDid.get("did:plc:x")!.score).toBeGreaterThan(
      byDid.get("did:plc:y")!.score,
    );
  });

  it("ignores duplicate entries within one follow list", () => {
    const lists = new Map([["did:plc:a", ["did:plc:x", "did:plc:x"]]]);
    expect(computeBubble(ME, lists)[0].commonCount).toBe(1);
  });

  it("returns an empty bubble for users who follow nobody", () => {
    expect(computeBubble(ME, new Map())).toEqual([]);
  });
});

describe("tiers", () => {
  it("uses 10% of the follows for the inner circle", () => {
    expect(tierThresholds(577)).toEqual({ inner: 58, bubble: 3, edge: 1 });
    expect(tierOf(58, 577)).toBe("inner");
    expect(tierOf(57, 577)).toBe("bubble");
    expect(tierOf(3, 577)).toBe("bubble");
    expect(tierOf(2, 577)).toBe("edge");
    expect(tierOf(1, 577)).toBe("edge");
  });

  it("keeps the inner circle above the bubble for small accounts", () => {
    expect(tierThresholds(20).inner).toBe(5);
    expect(tierOf(4, 20)).toBe("bubble");
    expect(tierOf(5, 20)).toBe("inner");
  });
});
