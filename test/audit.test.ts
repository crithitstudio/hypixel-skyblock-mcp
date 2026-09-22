import * as nbt from "prismarine-nbt";
import { describe, expect, it } from "vitest";
import { getSkyblockAudit } from "../src/audit.js";
import { analyzeAccessoryBag } from "../src/accessories.js";
import type { HypixelClient } from "../src/hypixelClient.js";
import type { JsonObject } from "../src/types.js";

const PROFILE = "11111111111111111111111111111111";
const UUID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function auditClient(member: JsonObject, overrides: Record<string, JsonObject | Error> = {}): HypixelClient {
  return {
    hasApiKey: () => true,
    hypixel: async (path: string) => {
      const value = overrides[path];
      if (value instanceof Error) throw value;
      const data = value ?? (path.endsWith("/profile") ? { success: true, profile: { profile_id: PROFILE, members: { [UUID]: member } } } : { success: true });
      return { data, meta: { source: path, fetchedAt: new Date().toISOString(), cached: false } };
    }
  } as unknown as HypixelClient;
}
const baseOptions = { profileId: PROFILE, includeMayor: false, includeEconomy: false };

describe("evidence-based profile audits", () => {
  it("does not invent slayer levels or advice when only XP was shared", async () => {
    const audit = await getSkyblockAudit(auditClient({ slayer_bosses: { blaze: { xp: 100_000 }, enderman: { xp: 100_000 } } }), { ...baseOptions, focus: ["slayers"] });
    expect(audit.gaps ?? []).toEqual([]);
    expect(audit.progression).toMatchObject({ slayerTiers: { blaze: { xp: 100_000 }, enderman: { xp: 100_000 } } });
    expect(((audit.progression as JsonObject).slayerTiers as Record<string, JsonObject>).blaze?.tier).toBeUndefined();
    expect((audit.slayers as Record<string, JsonObject>).enderman?.tier).toBeUndefined();
    expect((audit.ratings as JsonObject).totalSlayerLevels).toBeUndefined();
    expect((audit.ratings as JsonObject).totalSlayerXp).toBe(200_000);
  });

  it("distinguishes explicit empty claimed levels from missing level data", async () => {
    const audit = await getSkyblockAudit(auditClient({ slayer_bosses: { blaze: { xp: 0, claimed_levels: {} }, enderman: { xp: 0, claimed_levels: {} } } }), { ...baseOptions, focus: ["slayers"] });
    expect((audit.gaps as JsonObject[]).map((gap) => gap.evidence)).toEqual([{ boss: "blaze", tier: 0 }, { boss: "enderman", tier: 0 }]);
    expect((audit.ratings as JsonObject).totalSlayerLevels).toBe(0);
  });

  it("does not turn a private profile into zero-valued progression findings", async () => {
    const audit = await getSkyblockAudit(auditClient({}), baseOptions);
    expect(audit.gaps ?? []).toEqual([]);
    expect(audit.nextActions ?? []).toEqual([]);
    expect(audit.privacy).toContain("Skill experience is missing or private.");
  });

  it("reports known zeros while leaving unknown accessory power absent", async () => {
    expect(analyzeAccessoryBag({ accessoryBag: { selectedPower: "fortuitous" } })?.magicalPower).toBeUndefined();
    const audit = await getSkyblockAudit(auditClient({ currencies: { coin_purse: 0 }, player_data: { experience: { SKILL_COMBAT: 0 } } }), baseOptions);
    expect((audit.gaps as JsonObject[]).map((gap) => gap.area)).toEqual(["combat", "money"]);
  });

  it("does not infer Garden level zero when its optional endpoint failed", async () => {
    const audit = await getSkyblockAudit(auditClient({ player_data: { experience: { SKILL_FARMING: 60_000_000 } } }, { "/v2/skyblock/garden": new Error("unavailable") }), { ...baseOptions, focus: ["farming"] });
    expect(audit.gaps ?? []).toEqual([]);
    expect(audit.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/garden.*unavailable/i)]));
  });

  it("does not recommend an accessory upgrade already in slot 21", async () => {
    const ids = ["WOLF_TALISMAN", ...Array.from({ length: 19 }, (_, index) => `OTHER_${index}`), "WOLF_RING"];
    const node = nbt.comp({ i: nbt.list(nbt.comp(ids.map((id) => ({ tag: nbt.comp({ ExtraAttributes: nbt.comp({ id: nbt.string(id) }) }) })))) });
    const data = nbt.writeUncompressed(node as never).toString("base64");
    const audit = await getSkyblockAudit(auditClient({ inventory: { bag_contents: { talisman_bag: { data } } }, accessory_bag_storage: { highest_magical_power: 800 } }), { ...baseOptions, focus: ["accessories"] });
    expect((audit.accessories as JsonObject)?.upgradeSuggestions ?? []).toEqual([]);
    expect((audit.accessories as JsonObject)?.inventoryComplete).toBe(true);
  });

  it("uses collection IDs for personalized prices", async () => {
    const audit = await getSkyblockAudit(auditClient({ collection: { WHEAT: 500 } }, { "/v2/skyblock/bazaar": { success: true, products: { ENCHANTED_WHEAT: { quick_status: { buyPrice: 50, sellPrice: 40 } } } } }), { ...baseOptions, includeEconomy: true });
    expect((audit.economy as JsonObject).bazaarSignals).toMatchObject({ basedOnCollections: ["ENCHANTED_WHEAT"], products: [{ productId: "ENCHANTED_WHEAT", buyPrice: 50 }] });
  });

  it("returns the profile when optional pricing fails, with an explicit warning", async () => {
    const audit = await getSkyblockAudit(auditClient({ collection: { WHEAT: 500 } }, { "/v2/skyblock/bazaar": new Error("market unavailable") }), { ...baseOptions, includeEconomy: true });
    expect(audit.summary).toBeDefined();
    expect(audit.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/bazaar.*market unavailable/i)]));
  });

  it("honors focus when other progression facts exist", async () => {
    const audit = await getSkyblockAudit(auditClient({ fairy_soul: { total_collected: 20 } }), { ...baseOptions, focus: ["money"] });
    expect(audit.gaps ?? []).toEqual([]);
  });

  it("reports incomplete accessory data instead of asserting absent upgrades", async () => {
    const audit = await getSkyblockAudit(auditClient({ inventory: { talisman_bag: { data: "A".repeat(48) } } }), { ...baseOptions, focus: ["accessories"] });
    expect(audit.accessories).toMatchObject({ inventoryComplete: false });
    expect(audit.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/could not be decoded/)]));
  });

  it("keeps remaining-star advice when prices are incomplete without claiming a total", async () => {
    const node = nbt.comp({ i: nbt.list(nbt.comp([{ tag: nbt.comp({ ExtraAttributes: nbt.comp({ id: nbt.string("POWER_WITHER_CHESTPLATE") }) }) }])) });
    const member = { inventory: { inv_armor: { data: nbt.writeUncompressed(node as never).toString("base64") } } };
    const audit = await getSkyblockAudit(auditClient(member, { "/v2/skyblock/bazaar": { success: true, products: {} } }), { ...baseOptions, focus: ["dungeons"], includeEconomy: true });
    expect(audit.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ area: "dungeons", evidence: expect.objectContaining({ pricingComplete: false, unpriced: ["ESSENCE_WITHER"] }) })]));
    expect((audit.gaps as JsonObject[]).some((gap) => /costs about 0/.test(String(gap.message)))).toBe(false);
  });

  it("bases mayor guidance on returned perks, without fixed bonuses inferred from the name", async () => {
    const audit = await getSkyblockAudit(auditClient({}, { "/v2/resources/skyblock/election": { success: true, mayor: { name: "Derpy", key: "derpy", perks: [{ name: "Extra XP", description: "Gain more skill experience." }] } } }), { ...baseOptions, includeMayor: true });
    expect((audit.nextActions as string[]).join(" ")).toContain("Extra XP");
    expect((audit.nextActions as string[]).join(" ")).not.toContain("2x");
  });
});
