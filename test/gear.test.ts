import { describe, expect, it } from "vitest";
import { summarizeEquippedGear, summarizeGearQuality } from "../src/gear.js";
import type { DecodedInventory } from "../src/types.js";

function armorSection(prefix: string, stars: number[] = [5, 5, 5, 5]): DecodedInventory {
  return { path: "inventory.inv_armor", sectionType: "armor", itemCount: 4, shownItems: 4, truncated: false, items: ["HELMET", "CHESTPLATE", "LEGGINGS", "BOOTS"].map((slot, index) => ({ skyblockId: `${prefix}_${slot}`, dungeonStars: stars[index] || undefined })) };
}

describe("gear evidence", () => {
  it.each([["POWER_WITHER", "NECRON"], ["WISE_WITHER", "STORM"], ["TANK_WITHER", "GOLDOR"], ["SPEED_WITHER", "MAXOR"]])("recognizes canonical %s item IDs", (prefix, armorSet) => {
    const equipped = summarizeEquippedGear([armorSection(prefix)]);
    expect(equipped?.armorSet).toBe(armorSet);
    expect(summarizeGearQuality(equipped, { combat: { level: 50 } })?.dungeons).toBe("strong");
  });

  it("does not mark a farmer's unequipped combat gear weak", () => {
    const equipped = summarizeEquippedGear([armorSection("FERMENTO")]);
    const quality = summarizeGearQuality(equipped, { farming: { level: 50 }, combat: { level: 50 } });
    expect(quality?.farming).toBe("strong");
    expect(quality?.combat).toBeUndefined();
  });

  it("counts unstarred armor when assessing the average", () => {
    const equipped = summarizeEquippedGear([armorSection("POWER_WITHER", [5, 0, 0, 0])]);
    expect(summarizeGearQuality(equipped, { combat: { level: 50 } })?.dungeons).toBe("mid");
  });

  it("does not fabricate equipped gear when only a bag was decoded", () => {
    expect(summarizeEquippedGear([{ path: "inventory.talisman_bag", sectionType: "accessory_bag", items: [], itemCount: 0, shownItems: 0, truncated: false }])).toBeUndefined();
  });
});
