import { suggestAccessoryUpgrades } from "./accessories.js";
import { AUCTION_CAVEATS } from "./caveats.js";
import { summarizeEquippedEssenceUpgrades } from "./essence-costs.js";
import type { EquippedGearPiece } from "./essence-costs.js";
import { summarizeEquippedGear } from "./gear.js";
import type { HypixelClient } from "./hypixelClient.js";
import { buildPriceBook } from "./pricing.js";
import type { PriceBasis } from "./pricing.js";
import { getSkyblockProfileContext } from "./skyblock.js";
import type { DecodedInventory, JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject } from "./utils.js";

/**
 * Upgrade sources the advisor knows about. Only the ones in SUPPORTED_SOURCES
 * can be turned into concrete, honestly-costed actions from the data this server
 * has today; the rest are surfaced as explicitly unsupported (with a reason)
 * rather than emitting vague filler advice or fabricated stat/cost numbers.
 */
export type UpgradeSource = "star" | "accessory" | "reforge" | "enchant" | "hotm" | "pet";

const SUPPORTED_SOURCES: readonly UpgradeSource[] = ["star", "accessory"];

const UNSUPPORTED_REASONS: Record<Exclude<UpgradeSource, "star" | "accessory">, string> = {
  reforge:
    "No reforge stat table is bundled, so stat-gain-per-coin cannot be computed without fabricating data. Use skyblock_item for a reforge stone's live price.",
  enchant:
    "No enchant target list or stat table is bundled, so missing enchants cannot be ranked honestly. Use skyblock_bazaar for ENCHANTMENT_* book prices.",
  hotm:
    "No per-perk powder cost table is bundled, so Heart of the Mountain perk levels cannot be costed. See skyblock_audit for current HOTM perk levels.",
  pet:
    "No pet-XP-to-coin model is bundled, so pet leveling cannot be costed reliably. See skyblock_audit for current pet levels."
};

export type UpgradeAdvisorOptions = {
  username?: string;
  uuid?: string;
  profileId?: string;
  profileName?: string;
  selectedOnly?: boolean;
  memberUsername?: string;
  memberUuid?: string;
  sources?: UpgradeSource[];
  priceBasis?: PriceBasis;
  budgetCoins?: number;
  limit?: number;
};

type UpgradeConfidence = "exact" | "estimate" | "descriptive";

type UpgradeEntry = {
  source: UpgradeSource;
  action: string;
  target: JsonObject;
  coinCost?: number;
  /** false when the coin figure leans on live-Bazaar/lowest-BIN estimates rather than exact game cost. */
  coinCostExact?: boolean;
  prerequisites?: string[];
  caveats?: string[];
  confidence: UpgradeConfidence;
};

export type UpgradeAdviceInputs = {
  primaryRole?: string;
  requestedSources: UpgradeSource[];
  /** Result of summarizeEquippedEssenceUpgrades (carries perPiece[]). */
  essenceUpgrades?: JsonObject;
  /** Strings from suggestAccessoryUpgrades, e.g. "Upgrade SPIDER_TALISMAN → SPIDER_ARTIFACT". */
  accessorySuggestions: string[];
  /** Uppercased SkyBlock-ID -> price map for accessory targets (Bazaar + optional lowest-BIN), or undefined. */
  accessoryPrices?: Map<string, number>;
  lowbinConfigured: boolean;
  budgetCoins?: number;
  limit: number;
};

/** Parses the stable "Upgrade FROM → TO" suggestion shape into its two item IDs. */
function parseAccessorySuggestion(suggestion: string): { from: string; to: string } | undefined {
  const match = /^Upgrade\s+(\S+)\s+→\s+(\S+)$/u.exec(suggestion.trim());
  if (!match) {
    return undefined;
  }
  return { from: match[1]!, to: match[2]! };
}

function starUpgrades(essenceUpgrades: JsonObject | undefined): UpgradeEntry[] {
  const entries: UpgradeEntry[] = [];
  for (const piece of asArray(essenceUpgrades?.perPiece) ?? []) {
    const record = asRecord(piece);
    if (!record) {
      continue;
    }

    const label = asString(record.name) ?? asString(record.skyblockId) ?? "item";
    const fromStar = asNumber(record.fromStar);
    const toStar = asNumber(record.toStar);
    const essenceType = asString(record.essenceType);

    entries.push(
      compactObject({
        source: "star",
        action: `Star ${label} ${fromStar ?? 0}★ → ${toStar ?? 0}★`,
        target: compactObject({
          skyblockId: asString(record.skyblockId),
          fromTier: fromStar,
          toTier: toStar
        }),
        coinCost: asNumber(record.estimatedCoins),
        coinCostExact: false,
        prerequisites: essenceType ? [`${essenceType} essence (farm via dungeons / Kuudra)`] : undefined,
        caveats: [
          "Coin portion is the exact game cost; the essence/material portion is a live-Bazaar estimate that moves with the market."
        ],
        confidence: "estimate"
      }) as UpgradeEntry
    );
  }
  return entries;
}

function accessoryUpgrades(
  suggestions: string[],
  prices: Map<string, number> | undefined,
  lowbinConfigured: boolean
): UpgradeEntry[] {
  const entries: UpgradeEntry[] = [];
  for (const suggestion of suggestions) {
    const parsed = parseAccessorySuggestion(suggestion);
    if (!parsed) {
      continue;
    }

    const cost = prices?.get(parsed.to.toUpperCase());
    const priced = cost !== undefined && cost > 0;

    entries.push(
      compactObject({
        source: "accessory",
        action: `Upgrade accessory ${parsed.from} → ${parsed.to}`,
        target: { skyblockId: parsed.to, fromTier: parsed.from },
        coinCost: priced ? cost : undefined,
        coinCostExact: priced ? false : undefined,
        caveats: priced
          ? [
              "Cost is the gross price of the target tier; selling the lower tier offsets part of it.",
              ...AUCTION_CAVEATS
            ]
          : [
              lowbinConfigured
                ? "Target tier has no live price right now; corroborate with skyblock_auctions."
                : "Target is an auction-only item and no lowest-BIN source is configured (set SKYBLOCK_LOWEST_BIN_URL), so there is no live price. Use skyblock_auctions to check cost."
            ],
        confidence: priced ? "estimate" : "descriptive"
      }) as UpgradeEntry
    );
  }
  return entries;
}

/**
 * Pure assembly + ranking of the upgrade advice payload. Kept free of any I/O so
 * it can be unit-tested with plain fixtures; the orchestrator below feeds it data
 * fetched from the live API.
 *
 * Ranking note: a true stat-gain-per-coin ordering is intentionally NOT attempted
 * because this server bundles no reforge/enchant/HOTM stat tables. Costable
 * upgrades are therefore ranked by coin cost ascending (cheapest, most accessible
 * first); cost-unknown ("descriptive") entries follow in discovery order.
 */
export function buildUpgradeAdvice(inputs: UpgradeAdviceInputs): JsonObject {
  const requested = inputs.requestedSources.length ? inputs.requestedSources : [...SUPPORTED_SOURCES];
  const wants = (source: UpgradeSource): boolean => requested.includes(source);

  const collected: UpgradeEntry[] = [];
  if (wants("star")) {
    collected.push(...starUpgrades(inputs.essenceUpgrades));
  }
  if (wants("accessory")) {
    collected.push(...accessoryUpgrades(inputs.accessorySuggestions, inputs.accessoryPrices, inputs.lowbinConfigured));
  }

  const budget = inputs.budgetCoins;
  const withinBudget = (entry: UpgradeEntry): boolean =>
    budget === undefined || entry.coinCost === undefined || entry.coinCost <= budget;

  const priced = collected
    .filter((entry) => entry.coinCost !== undefined && withinBudget(entry))
    .sort((a, b) => (a.coinCost ?? 0) - (b.coinCost ?? 0));
  const described = collected.filter((entry) => entry.coinCost === undefined);

  const ranked = [...priced, ...described].slice(0, Math.max(1, inputs.limit));

  const pricedSources = [...new Set(priced.map((entry) => entry.source))];
  const describedSources = [...new Set(described.map((entry) => entry.source))];
  const unsupportedSources = requested
    .filter((source): source is Exclude<UpgradeSource, "star" | "accessory"> => !SUPPORTED_SOURCES.includes(source))
    .map((source) => ({ source, reason: UNSUPPORTED_REASONS[source] }));

  const notes = [
    "Upgrades are ranked by coin cost ascending (most accessible first), NOT by stat impact: this server bundles no reforge/enchant/HOTM stat tables, so a stat-gain-per-coin ratio is not computed.",
    "confidence: 'estimate' = cost leans on live market prices and will drift; 'descriptive' = an available upgrade whose cost could not be priced here."
  ];
  if (budget !== undefined) {
    notes.push(
      "budgetCoins filtered out priced upgrades above the budget; 'descriptive' upgrades have unknown cost and are not filtered."
    );
  }

  // Note: structural fields (upgrades, coverage arrays) are kept even when empty
  // so the consumer can distinguish "nothing to recommend / nothing priceable"
  // from a missing field. Only primaryRole is dropped when unknown.
  const result: JsonObject = {
    coverage: {
      pricedSources,
      describedSources,
      unsupportedSources,
      lowbinConfigured: inputs.lowbinConfigured
    },
    upgrades: ranked,
    notes
  };
  if (inputs.primaryRole !== undefined) {
    result.primaryRole = inputs.primaryRole;
  }
  return result;
}

function collectEquippedPieces(equipped: JsonObject | undefined): EquippedGearPiece[] {
  if (!equipped) {
    return [];
  }

  const pieces: EquippedGearPiece[] = [];
  for (const key of ["armor", "equipment"] as const) {
    for (const item of asArray(equipped[key]) ?? []) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }
      pieces.push({
        skyblockId: asString(record.skyblockId),
        name: asString(record.name),
        dungeonStars: asNumber(record.dungeonStars)
      });
    }
  }
  return pieces;
}

/**
 * One-call upgrade advisor: ranks the gear/accessory upgrades available to a
 * profile that this server can honestly cost today, with an explicit coverage
 * block describing which requested sources are supported. Designed as a ranked,
 * budget-aware, structured action list for an LLM to act on (and to chain into
 * skyblock_essence_costs / skyblock_auctions for follow-up).
 */
export async function getUpgradeAdvisor(client: HypixelClient, options: UpgradeAdvisorOptions): Promise<JsonObject> {
  const basis: PriceBasis = options.priceBasis ?? "buy";
  const requested = options.sources?.length ? [...new Set(options.sources)] : [...SUPPORTED_SOURCES];

  const profileContext = await getSkyblockProfileContext(client, {
    ...options,
    decodeInventories: true,
    includeItemDetails: false,
    maxItemsPerInventory: 45,
    maxInventorySections: 32,
    inventorySectionTypes: ["armor", "equipment", "accessory_bag"],
    maxLoreLines: 0
  });

  const decodedInventories = asArray(profileContext.decodedInventories) as DecodedInventory[] | undefined;
  const equipped = summarizeEquippedGear(decodedInventories);
  const primaryRole = asString(equipped?.inferredRole);

  const wantsStar = requested.includes("star");
  const wantsAccessory = requested.includes("accessory");

  const accessoryBag = wantsAccessory
    ? decodedInventories?.find((section) => section.sectionType === "accessory_bag")
    : undefined;
  const accessorySuggestions = accessoryBag ? suggestAccessoryUpgrades(accessoryBag.items) : [];

  const lowbinConfigured = Boolean(process.env.SKYBLOCK_LOWEST_BIN_URL);

  const [essenceUpgrades, accessoryPriceBook] = await Promise.all([
    wantsStar
      ? summarizeEquippedEssenceUpgrades(client, collectEquippedPieces(equipped), { priceBasis: basis }).catch(
          () => undefined
        )
      : Promise.resolve(undefined),
    accessorySuggestions.length
      ? buildPriceBook(client, { basis, includeAuctionPrices: true }).catch(() => undefined)
      : Promise.resolve(undefined)
  ]);

  const advice = buildUpgradeAdvice({
    primaryRole,
    requestedSources: requested,
    essenceUpgrades: essenceUpgrades ?? undefined,
    accessorySuggestions,
    accessoryPrices: accessoryPriceBook?.prices,
    lowbinConfigured,
    budgetCoins: options.budgetCoins,
    limit: options.limit ?? 20
  });

  // advice already keeps empty structural arrays intentionally, so compact only
  // the envelope fields and merge the advice in unchanged.
  const envelope = compactObject({
    generatedAt: new Date().toISOString(),
    priceBasis: basis,
    meta: compactObject({
      profileSource: asRecord(profileContext.meta)?.profileSource
    }),
    privacy: profileContext.privacy
  });
  return { ...envelope, ...advice };
}
