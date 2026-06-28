import { describe, expect, it } from "vitest";
import { summarizeMayor } from "../src/mayor.js";

const sample = {
  resource: {
    lastUpdated: 1782221350084,
    mayor: {
      key: "jerry",
      name: "Jerry",
      perks: [{ name: "Perkpocalypse", description: "Activates all perks of another mayor every 18 SkyBlock days (6 hours)." }]
    },
    current: {
      year: 497,
      candidates: [
        { key: "fishing", name: "Marina", votes: 818101, perks: [{ name: "Fishing Festival", description: "§bspecial", minister: true }] },
        { key: "pets", name: "Diana", votes: 199265, perks: [{ name: "Pet XP Buff", description: "Gain §d35% §7more pet XP." }] }
      ]
    }
  }
};

describe("mayor summary", () => {
  it("extracts the active mayor, special flag, and election leader", () => {
    const summary = summarizeMayor(sample);
    expect(summary?.active && (summary.active as Record<string, unknown>).name).toBe("Jerry");
    expect(summary?.active && (summary.active as Record<string, unknown>).special).toBe(true);

    const election = summary?.election as Record<string, unknown>;
    const leader = election.leader as Record<string, unknown>;
    expect(leader.name).toBe("Marina");
    expect(leader.votes).toBe(818101);
    expect((election.candidates as unknown[]).length).toBe(2);
  });

  it("strips Minecraft formatting codes from perk descriptions", () => {
    const summary = summarizeMayor(sample);
    const election = summary?.election as Record<string, unknown>;
    const candidates = election.candidates as Array<Record<string, unknown>>;
    const diana = candidates.find((candidate) => candidate.name === "Diana");
    const perks = diana?.perks as Array<Record<string, unknown>>;
    expect(perks[0]?.description).toBe("Gain 35% more pet XP.");
  });

  it("flags only true special mayors (Marina is a regular mayor)", () => {
    const marina = summarizeMayor({ resource: { mayor: { key: "marina", name: "Marina" } } });
    expect((marina?.active as Record<string, unknown>).special).toBe(false);

    const scorpius = summarizeMayor({ resource: { mayor: { key: "scorpius", name: "Scorpius" } } });
    expect((scorpius?.active as Record<string, unknown>).special).toBe(true);
  });

  it("returns undefined when there is no election data", () => {
    expect(summarizeMayor({})).toBeUndefined();
    expect(summarizeMayor(undefined)).toBeUndefined();
  });
});
