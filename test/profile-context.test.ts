import { describe, expect, it } from "vitest";
import { loadProfileMember, getBazaar, getAuctions, getSkyblockBingo, resolvePlayer, summarizeMember } from "../src/skyblock.js";
import type { HypixelClient } from "../src/hypixelClient.js";
import type { JsonObject } from "../src/types.js";

const UUID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROFILE = "11111111111111111111111111111111";
const meta = { source: "fixture", cached: false, fetchedAt: new Date().toISOString() };
function clientWith(data: JsonObject): HypixelClient {
  return { hypixel: async () => ({ data, meta }) } as unknown as HypixelClient;
}

describe("explicit profile and member selection", () => {
  it("validates direct caller identities before requesting external data", async () => {
    await expect(resolvePlayer(clientWith({}), { uuid: "not-a-uuid" })).rejects.toThrow(/uuid/i);
    await expect(resolvePlayer(clientWith({}), { username: "../bad user" })).rejects.toThrow(/username/i);
  });

  it("rejects conflicting player identity forms instead of labeling one UUID as another username", async () => {
    await expect(resolvePlayer(clientWith({}), { username: "Alice", uuid: UUID })).rejects.toThrow(/either username or uuid/i);
  });

  it("rejects conflicting member identity forms instead of silently preferring the UUID", async () => {
    const client = clientWith({ profile: { profile_id: PROFILE, members: { [UUID]: {} } } });
    await expect(loadProfileMember(client, {
      profileId: PROFILE,
      memberUsername: "Alice",
      memberUuid: UUID
    })).rejects.toThrow(/either memberUsername or memberUuid/i);
  });

  it("rejects conflicting auction player identity forms before requesting upstream data", async () => {
    let requests = 0;
    const client = {
      mojangProfile: async () => ({ data: { id: UUID, name: "Alice" }, meta }),
      hypixel: async () => { requests += 1; return { data: { auctions: [] }, meta }; }
    } as unknown as HypixelClient;
    await expect(getAuctions(client, {
      mode: "lookup",
      playerUsername: "Alice",
      playerUuid: UUID
    })).rejects.toThrow(/either playerUsername or playerUuid/i);
    expect(requests).toBe(0);
  });
  it("rejects an unknown profile name instead of returning the selected profile", async () => {
    const client = clientWith({ profiles: [{ profile_id: PROFILE, cute_name: "Apple", selected: true, members: { [UUID]: {} } }] });
    await expect(loadProfileMember(client, { uuid: UUID, profileName: "Banana" })).rejects.toThrow(/profile/i);
  });

  it("rejects a member UUID absent from the selected co-op", async () => {
    const client = clientWith({ profile: { profile_id: PROFILE, members: { [UUID]: {} } } });
    await expect(loadProfileMember(client, { profileId: PROFILE, memberUuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).rejects.toThrow(/member/i);
  });

  it("does not silently replace a requested player with another member", async () => {
    const client = clientWith({ profile: { profile_id: PROFILE, members: { [UUID]: {} } } });
    await expect(loadProfileMember(client, { profileId: PROFILE, uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })).rejects.toThrow(/member/i);
  });

  it("validates explicit identity against direct profile responses", async () => {
    const client = clientWith({ profile: { profile_id: PROFILE, cute_name: "Apple", members: { [UUID]: {} } } });
    await expect(loadProfileMember(client, { profileId: "22222222222222222222222222222222" })).rejects.toThrow(/profile/i);
    await expect(loadProfileMember(client, { profileId: PROFILE, profileName: "Banana" })).rejects.toThrow(/profile/i);
  });

  it("still selects the most recent member when none was requested", async () => {
    const client = clientWith({ profile: { profile_id: PROFILE, members: { [UUID]: { last_save: 1 }, b: { last_save: 2 } } } });
    expect((await loadProfileMember(client, { profileId: PROFILE })).memberUuid).toBe("b");
  });
});

describe("market response provenance", () => {
  it("sorts volume by total outstanding buy and sell volume", async () => {
    const client = clientWith({ products: {
      LOW: { quick_status: { buyVolume: 2, sellVolume: 3 } },
      HIGH: { quick_status: { buyVolume: 100, sellVolume: 20 } }
    } });
    const response = await getBazaar(client, { sortBy: "volume" });
    expect((response.products as JsonObject[]).map((product) => product.productId)).toEqual(["HIGH", "LOW"]);
  });

  it.each([false, true])("retains upstream age and caveats in Bazaar raw=%s", async (includeRaw) => {
    const response = await getBazaar(clientWith({ lastUpdated: Date.now() - 600_000, products: {} }), { includeRaw });
    expect(response.freshness).toMatchObject({ staleWarning: expect.any(String), dataAgeSeconds: 600 });
    expect(response.caveats).toBeDefined();
  });

  it.each([false, true])("retains upstream age and caveats in auctions raw=%s", async (includeRaw) => {
    const response = await getAuctions(clientWith({ lastUpdated: Date.now() - 600_000, auctions: [] }), { includeRaw });
    expect(response.freshness).toMatchObject({ staleWarning: expect.any(String), dataAgeSeconds: 600 });
    expect(response.caveats).toBeDefined();
  });
});

describe("additional member context", () => {
  it("summarizes trophy catches without inventing missing catches", () => {
    const summary = summarizeMember({ trophy_fish: { total_caught: 9, rewards: [1, 2], blobfish: 9, blobfish_bronze: 6, blobfish_silver: 3 } });
    expect(summary.trophyFish).toMatchObject({ totalCaught: 9, rewardsClaimed: 2, fish: [{ id: "blobfish", totalCaught: 9, highestTier: "silver", catches: { bronze: 6, silver: 3 } }] });
    expect(summarizeMember({}).trophyFish).toBeUndefined();
  });

  it("adds compact Jacob contest data while preserving the existing raw field", () => {
    const raw = { medals_inv: { gold: 2 }, contests: { "100:1_1:WHEAT": { collected: 1200, claimed_rewards: true }, "100:1_2:WHEAT": { collected: 1500 }, "100:1_3:CARROT_ITEM": { collected: 900 } }, perks: { farming_level_cap: 2 } };
    const summary = summarizeMember({ jacob_contest: raw });
    expect(summary.jacobContest).toEqual(raw);
    expect(summary.farmingContests).toMatchObject({ contestCount: 3, rewardsClaimed: 1, medals: { gold: 2 }, bestByCrop: { WHEAT: 1500, CARROT_ITEM: 900 } });
  });

  it("exposes bounded complete pet detail and dungeon floor statistics", () => {
    const summary = summarizeMember({ pets_data: { pets: [{ type: "ROCK", tier: "COMMON", exp: 0, uuid: "pet-1" }] }, dungeons: { dungeon_types: { catacombs: { tier_completions: { 1: 2, 2: 3 }, fastest_time_s_plus: { 2: 25000 }, most_damage_berserk: { 2: 999 } } } } });
    expect(summary.pets).toMatchObject({ shownPets: 1, truncated: false, all: [{ uuid: "pet-1", type: "ROCK", level: 1 }] });
    expect(summary.dungeons).toMatchObject({ dungeonTypes: { catacombs: { totalCompletions: 5, fastestTimeSPlus: { 2: 25000 } } } });
  });

  it("summarizes Bingo events and joins only the matching event's goals", async () => {
    const client = { hypixel: async (path: string) => ({ meta, data: path.includes("resources")
      ? { success: true, id: 12, name: "Event 12", goals: [{ id: "A", name: "First" }, { id: "B", name: "Second" }] }
      : { success: true, events: [{ key: 11, points: 2, completed_goals: ["B"] }, { key: 12, points: 5, completed_goals: ["A"] }] }
    }) } as unknown as HypixelClient;
    const response = await getSkyblockBingo(client, { uuid: UUID });
    expect(response).toMatchObject({ eventCount: 2, truncated: false, events: [{ eventId: 12, points: 5, completedGoalCount: 1 }, { eventId: 11, points: 2 }] });
    expect(response.currentEvent).toMatchObject({ id: 12, goals: [{ id: "A", completed: true }, { id: "B", completed: false }] });
  });

  it("keeps Bingo history available when the current-event resource fails", async () => {
    const client = { hypixel: async (path: string) => {
      if (path.includes("resources")) throw new Error("offline");
      return { meta, data: { success: true, events: [{ key: 1, points: 0, completed_goals: [] }] } };
    } } as unknown as HypixelClient;
    const response = await getSkyblockBingo(client, { uuid: UUID, eventId: 1 });
    expect(response.events).toMatchObject([{ eventId: 1, points: 0 }]);
    expect(response.warnings).toEqual([expect.stringMatching(/offline/)]);
  });

  it.each([undefined, {}, [null], [{}]])("keeps missing or malformed Bingo history unknown (%j)", async (events) => {
    const client = { hypixel: async (path: string) => ({ meta, data: path.includes("resources")
      ? { success: true, id: 12, name: "Event 12", goals: [{ id: "A", name: "First" }] }
      : { success: true, events }
    }) } as unknown as HypixelClient;
    const response = await getSkyblockBingo(client, { uuid: UUID });
    expect(response.eventCount).toBeUndefined();
    expect(response.events).toBeUndefined();
    expect((response.currentEvent as JsonObject).participationReported).toBeUndefined();
    expect(response.warnings).toEqual([expect.stringMatching(/history.*unavailable/i)]);
  });

  it.each([
    { goals: [] },
    { id: 12 },
    { id: 12, goals: [null] },
    { id: 12, goals: [{}] }
  ])("keeps malformed current Bingo resources unavailable (%j)", async (currentEvent) => {
    const client = { hypixel: async (path: string) => ({ meta, data: path.includes("resources")
      ? { success: true, ...currentEvent }
      : { success: true, events: [] }
    }) } as unknown as HypixelClient;
    const response = await getSkyblockBingo(client, { uuid: UUID });
    expect(response).toMatchObject({ historyAvailable: true, eventCount: 0 });
    expect(response.events ?? []).toEqual([]);
    expect(response.currentEvent).toBeUndefined();
    expect(response.warnings).toEqual([expect.stringMatching(/current Bingo event.*malformed/i)]);
  });
});
