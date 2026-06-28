import { McpUserError } from "./errors.js";
import type { HypixelClient } from "./hypixelClient.js";
import {
  catacombsLevelFromXp,
  gardenLevelFromXp,
  petLevelFromExp,
  skyblockLevelFromExperience,
  slayerTierFromRecord,
  summarizeSkillLevels
} from "./levels.js";
import { buildPlayerRatings } from "./metrics.js";
import { summarizeMayor } from "./mayor.js";
import { decodeInventoriesFromMember, filterNbtDataLocations, findNbtDataLocations } from "./nbt.js";
import type { InventorySectionQuery } from "./nbt.js";
import { summarizeEssence, summarizeMuseumMember, summarizeProgression } from "./progression.js";
import { aggregateStorageSections, DEFAULT_STORAGE_SECTION_TYPES, extractSacksCounts } from "./storage.js";
import type { ApiResult, DecodedInventory, JsonObject, PlayerIdentity } from "./types.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  compactObject,
  dashedUuid,
  getPath,
  looksLikeUuid,
  normalizeUuid,
  numberOrZero,
  percent,
  pickPaths,
  sortByNumeric,
  stripMinecraftFormatting,
  takeEntries
} from "./utils.js";

type ProfileSelection = {
  profileId?: string;
  profileName?: string;
  selectedOnly?: boolean;
};

type ProfileFetchOptions = ProfileSelection & {
  username?: string;
  uuid?: string;
  memberUsername?: string;
  memberUuid?: string;
  decodeInventories?: boolean;
  includeRawMember?: boolean;
  includeRawProfile?: boolean;
  includeMuseum?: boolean;
  includeGarden?: boolean;
  maxItemsPerInventory?: number;
  maxInventorySections?: number;
  inventorySectionTypes?: string[];
  inventorySectionPaths?: string[];
  includeAllNbtData?: boolean;
  includeRawNbt?: boolean;
  includeItemDetails?: boolean;
  maxLoreLines?: number;
};

type InventoryFetchOptions = ProfileSelection & {
  username?: string;
  uuid?: string;
  memberUsername?: string;
  memberUuid?: string;
  maxSections?: number;
  maxItemsPerSection?: number;
  sectionTypes?: string[];
  sectionPaths?: string[];
  includeAllNbtData?: boolean;
  includeRawNbt?: boolean;
  includeItemDetails?: boolean;
  maxLoreLines?: number;
  includeRawMember?: boolean;
};

type StorageFetchOptions = ProfileSelection & {
  username?: string;
  uuid?: string;
  memberUsername?: string;
  memberUuid?: string;
  sectionTypes?: string[];
  sectionPaths?: string[];
  search?: string;
  skyblockIds?: string[];
  groupBySkyblockId?: boolean;
  maxSections?: number;
  maxItemsPerSection?: number;
  itemLimit?: number;
  includeItemDetails?: boolean;
  includeSections?: boolean;
};

type LoadedProfileMember = {
  player?: PlayerIdentity;
  profileResult: ApiResult<JsonObject>;
  profile: JsonObject;
  memberUuid?: string;
  member?: JsonObject;
};

type ResourceKind = "collections" | "skills" | "items" | "election" | "bingo" | "news";

export async function resolvePlayer(
  client: HypixelClient,
  input: { username?: string; uuid?: string }
): Promise<PlayerIdentity> {
  const supplied = input.uuid ?? input.username;

  if (!supplied) {
    throw new McpUserError("Provide either username or uuid.");
  }

  if (input.uuid || looksLikeUuid(supplied)) {
    const uuid = normalizeUuid(supplied);
    return {
      username: input.username && !looksLikeUuid(input.username) ? input.username : undefined,
      uuid,
      uuidDashed: dashedUuid(uuid)
    };
  }

  const result = await client.mojangProfile(supplied);
  return {
    username: result.data.name,
    uuid: normalizeUuid(result.data.id),
    uuidDashed: dashedUuid(result.data.id)
  };
}

export async function fetchProfilesForPlayer(
  client: HypixelClient,
  player: PlayerIdentity
): Promise<ApiResult<JsonObject>> {
  return client.hypixel<JsonObject>("/v2/skyblock/profiles", { uuid: player.uuid }, { requiresApiKey: true, ttlMs: 30_000 });
}

export async function fetchProfileById(client: HypixelClient, profileId: string): Promise<ApiResult<JsonObject>> {
  return client.hypixel<JsonObject>("/v2/skyblock/profile", { profile: profileId }, { requiresApiKey: true, ttlMs: 30_000 });
}

export async function getSkyblockProfileContext(client: HypixelClient, options: ProfileFetchOptions): Promise<JsonObject> {
  const { player, profileResult, profile, memberUuid, member } = await loadProfileMember(client, options);
  const decodedInventories =
    options.decodeInventories && member
      ? await decodeInventoriesFromMember(member, inventoryDecodeOptions(options))
      : undefined;

  const result: JsonObject = {
    meta: {
      profileSource: profileResult.meta,
      requestedPlayer: player,
      selectedMemberUuid: memberUuid,
      hasApiKey: client.hasApiKey()
    },
    profile: summarizeProfile(profile),
    member: member ? summarizeMember(member, memberUuid) : undefined,
    decodedInventories,
    privacy: privacyNotes(member, decodedInventories)
  };

  if (options.includeMuseum) {
    result.museum = await getOptionalProfileEndpoint(client, "/v2/skyblock/museum", profile.profile_id);
  }

  if (options.includeGarden) {
    result.garden = await getOptionalProfileEndpoint(client, "/v2/skyblock/garden", profile.profile_id);
  }

  if (options.includeRawProfile) {
    result.rawProfile = profile;
  }

  if (options.includeRawMember && member) {
    result.rawMember = member;
  }

  return compactObject(result);
}

export async function getSkyblockStorageContext(client: HypixelClient, options: StorageFetchOptions): Promise<JsonObject> {
  const { player, profileResult, profile, memberUuid, member } = await loadProfileMember(client, options);
  const sectionTypes = options.sectionTypes ?? [...DEFAULT_STORAGE_SECTION_TYPES];
  const query: InventorySectionQuery = {
    maxSections: options.maxSections ?? 120,
    maxItemsPerSection: options.maxItemsPerSection ?? 120,
    sectionTypes,
    sectionPaths: options.sectionPaths,
    includeItemDetails: options.includeItemDetails ?? true,
    maxLoreLines: 4
  };
  const decodedInventories = member ? await decodeInventoriesFromMember(member, query) : undefined;
  const aggregate = aggregateStorageSections(decodedInventories, extractSacksCounts(member), {
    search: options.search,
    skyblockIds: options.skyblockIds,
    sectionTypes,
    limit: options.itemLimit ?? 250,
    groupBySkyblockId: options.groupBySkyblockId ?? true
  });

  return compactObject({
    meta: {
      profileSource: profileResult.meta,
      requestedPlayer: player,
      selectedMemberUuid: memberUuid,
      hasApiKey: client.hasApiKey()
    },
    profile: summarizeProfile(profile),
    storage: compactObject({
      requested: compactObject({
        sectionTypes,
        sectionPaths: options.sectionPaths,
        search: options.search,
        skyblockIds: options.skyblockIds,
        groupBySkyblockId: options.groupBySkyblockId ?? true
      }),
      ...aggregate,
      sections: options.includeSections ? decodedInventories : undefined
    }),
    privacy: privacyNotes(member, decodedInventories)
  });
}

export async function getHypixelPlayer(
  client: HypixelClient,
  input: { username?: string; uuid?: string }
): Promise<JsonObject> {
  const player = await resolvePlayer(client, input);
  const result = await client.hypixel<JsonObject>("/v2/player", { uuid: player.uuid }, { requiresApiKey: true, ttlMs: 30_000 });
  const record = asRecord(result.data.player) ?? {};

  return compactObject({
    meta: {
      player,
      source: result.meta
    },
    player: compactObject({
      uuid: player.uuidDashed,
      displayName: record.displayname,
      rank: record.rank ?? record.newPackageRank ?? record.packageRank,
      packageRank: record.newPackageRank ?? record.packageRank,
      monthlyPackageRank: record.monthlyPackageRank,
      firstLogin: record.firstLogin,
      lastLogin: record.lastLogin,
      lastLogout: record.lastLogout,
      online:
        typeof record.lastLogin === "number" && typeof record.lastLogout === "number"
          ? record.lastLogin > record.lastLogout
          : undefined,
      karma: record.karma,
      achievementPoints: getPath(record, ["achievements", "achievementPoints"]),
      networkExp: record.networkExp,
      socialMedia: record.socialMedia,
      stats: compactObject({
        skyblock: asRecord(getPath(record, ["stats", "SkyBlock"])),
        bedwars: summarizeNetworkMode(getPath(record, ["stats", "Bedwars"])),
        duels: summarizeNetworkMode(getPath(record, ["stats", "Duels"]))
      })
    })
  });
}

function summarizeNetworkMode(stats: unknown): JsonObject | undefined {
  const record = asRecord(stats);
  if (!record) {
    return undefined;
  }

  return compactObject({
    experience: record.Experience ?? record.experience,
    wins: record.wins,
    kills: record.kills,
    deaths: record.deaths
  });
}

export async function getSkyblockMuseumContext(
  client: HypixelClient,
  options: ProfileSelection & { username?: string; uuid?: string; memberUsername?: string; memberUuid?: string }
): Promise<JsonObject> {
  const { player, profileResult, profile, memberUuid } = await loadProfileMember(client, options);
  const museum = await getOptionalProfileEndpoint(client, "/v2/skyblock/museum", profile.profile_id);

  return compactObject({
    meta: {
      profileSource: profileResult.meta,
      requestedPlayer: player,
      selectedMemberUuid: memberUuid,
      hasApiKey: client.hasApiKey()
    },
    profile: summarizeProfile(profile),
    museum,
    summary: summarizeMuseumMember(museum, memberUuid)
  });
}

export async function getSkyblockGardenContext(
  client: HypixelClient,
  options: ProfileSelection & { username?: string; uuid?: string; memberUsername?: string; memberUuid?: string }
): Promise<JsonObject> {
  const { player, profileResult, profile, memberUuid } = await loadProfileMember(client, options);
  const garden = await getOptionalProfileEndpoint(client, "/v2/skyblock/garden", profile.profile_id);
  const gardenData = asRecord(asRecord(garden.data)?.garden);

  return compactObject({
    meta: {
      profileSource: profileResult.meta,
      requestedPlayer: player,
      selectedMemberUuid: memberUuid,
      hasApiKey: client.hasApiKey()
    },
    profile: summarizeProfile(profile),
    garden,
    summary: gardenData
      ? compactObject({
          experience: gardenData.garden_experience,
          level: (() => {
            const xp = asNumber(gardenData.garden_experience);
            return xp !== undefined ? gardenLevelFromXp(xp) : undefined;
          })(),
          unlockedPlots: asArray(gardenData.unlocked_plots_ids)?.length,
          totalPlots: 24,
          commissionsCompleted: getPath(gardenData, ["commission_data", "total_completed"]),
          uniqueNpcsServed: getPath(gardenData, ["commission_data", "unique_npcs_served"]),
          activeCommissions: Object.keys(asRecord(gardenData.active_commissions) ?? {}).length,
          cropUpgrades: gardenData.crop_upgrade_levels,
          composterUpgrades: getPath(gardenData, ["composter_data", "upgrades"])
        })
      : undefined
  });
}

export async function getSkyblockInventoryContext(client: HypixelClient, options: InventoryFetchOptions): Promise<JsonObject> {
  const { player, profileResult, profile, memberUuid, member } = await loadProfileMember(client, options);
  const query = inventoryFetchDecodeOptions(options);
  const availableLocations = member ? findNbtDataLocations(member, [], { includeAllNbtData: options.includeAllNbtData }) : [];
  const matchedLocations = filterNbtDataLocations(availableLocations, {
    sectionTypes: options.sectionTypes,
    sectionPaths: options.sectionPaths
  });
  const decodedInventories = member ? await decodeInventoriesFromMember(member, query) : undefined;

  return compactObject({
    meta: {
      profileSource: profileResult.meta,
      requestedPlayer: player,
      selectedMemberUuid: memberUuid,
      hasApiKey: client.hasApiKey()
    },
    profile: summarizeProfile(profile),
    inventory: compactObject({
      requested: compactObject({
        sectionTypes: options.sectionTypes,
        sectionPaths: options.sectionPaths,
        includeAllNbtData: options.includeAllNbtData,
        maxSections: query.maxSections,
        maxItemsPerSection: query.maxItemsPerSection
      }),
      availableSections: summarizeNbtLocations(availableLocations),
      matchedSections: summarizeNbtLocations(matchedLocations).slice(0, query.maxSections ?? 40),
      decodedInventories
    }),
    privacy: privacyNotes(member, decodedInventories),
    rawMember: options.includeRawMember && member ? member : undefined
  });
}

export async function listSkyblockProfiles(
  client: HypixelClient,
  input: { username?: string; uuid?: string; decodeInventories?: boolean; includeRaw?: boolean }
): Promise<JsonObject> {
  const player = await resolvePlayer(client, input);
  const result = await fetchProfilesForPlayer(client, player);
  const profiles = asArray(result.data.profiles)?.map((profile) => summarizeProfile(asRecord(profile) ?? {})) ?? [];

  return compactObject({
    meta: {
      player,
      profileSource: result.meta
    },
    profiles,
    rawProfiles: input.includeRaw ? result.data.profiles : undefined
  });
}

export async function getSkyblockResource(
  client: HypixelClient,
  input: {
    kind: ResourceKind;
    search?: string;
    ids?: string[];
    category?: string;
    tier?: string;
    limit?: number;
    includeRaw?: boolean;
  }
): Promise<JsonObject> {
  const limit = clampLimit(input.limit, 100, 500);
  const result = await client.hypixel<JsonObject>(resourcePath(input.kind), undefined, {
    requiresApiKey: input.kind === "news",
    ttlMs: input.kind === "news" ? 60_000 : 10 * 60_000
  });

  if (input.includeRaw) {
    return {
      meta: result.meta,
      resource: result.data
    };
  }

  if (input.kind === "items") {
    return {
      meta: result.meta,
      items: filterItems(asArray(result.data.items) ?? [], input, limit)
    };
  }

  if (input.kind === "collections") {
    return {
      meta: result.meta,
      collections: filterRecordBySearch(asRecord(result.data.collections), input.search, limit)
    };
  }

  if (input.kind === "skills") {
    return {
      meta: result.meta,
      skills: filterRecordBySearch(asRecord(result.data.skills), input.search, limit)
    };
  }

  if (input.kind === "news") {
    return {
      meta: result.meta,
      items: (asArray(result.data.items) ?? []).slice(0, limit)
    };
  }

  return {
    meta: result.meta,
    resource: result.data
  };
}

export async function getBazaar(
  client: HypixelClient,
  input: {
    productIds?: string[];
    search?: string;
    sortBy?: "margin" | "marginPercent" | "volume" | "movingWeek" | "buyPrice" | "sellPrice";
    limit?: number;
    includeOrders?: boolean;
    includeRaw?: boolean;
  }
): Promise<JsonObject> {
  const result = await client.hypixel<JsonObject>("/v2/skyblock/bazaar", undefined, { ttlMs: 30_000 });
  const products = asRecord(result.data.products) ?? {};

  if (input.includeRaw) {
    return {
      meta: result.meta,
      products
    };
  }

  const summarized = Object.entries(products)
    .map(([productId, product]) => summarizeBazaarProduct(productId, product, Boolean(input.includeOrders)))
    .filter((product) => matchesBazaarFilter(product, input));
  const sortBy = input.sortBy ?? "movingWeek";
  const sorted = sortByNumeric(summarized, (product) => asNumber(product[sortBy]), "desc").slice(0, clampLimit(input.limit, 30, 200));

  return {
    meta: result.meta,
    sortBy,
    products: sorted
  };
}

export async function getAuctions(
  client: HypixelClient,
  input: {
    mode?: "active_page" | "ended_recent" | "lookup";
    page?: number;
    auctionUuid?: string;
    playerUuid?: string;
    playerUsername?: string;
    profileId?: string;
    search?: string;
    tier?: string;
    category?: string;
    binOnly?: boolean;
    limit?: number;
    includeRaw?: boolean;
  }
): Promise<JsonObject> {
  const mode = input.mode ?? (input.auctionUuid || input.playerUuid || input.playerUsername || input.profileId ? "lookup" : "active_page");
  const limit = clampLimit(input.limit, 50, 500);

  if (mode === "ended_recent") {
    const result = await client.hypixel<JsonObject>("/v2/skyblock/auctions_ended", undefined, { ttlMs: 30_000 });
    return formatAuctionResult(result, input, limit, "auctions");
  }

  if (mode === "lookup") {
    const player = input.playerUsername
      ? await resolvePlayer(client, { username: input.playerUsername })
      : input.playerUuid
        ? await resolvePlayer(client, { uuid: input.playerUuid })
        : undefined;
    const query = compactObject({
      uuid: input.auctionUuid,
      player: player?.uuid,
      profile: input.profileId
    }) as Record<string, string>;

    if (Object.keys(query).length !== 1) {
      throw new McpUserError("Auction lookup requires exactly one of auctionUuid, playerUuid/playerUsername, or profileId.");
    }

    const result = await client.hypixel<JsonObject>("/v2/skyblock/auction", query, { requiresApiKey: true, ttlMs: 15_000 });
    return formatAuctionResult(result, input, limit, "auctions");
  }

  const result = await client.hypixel<JsonObject>(
    "/v2/skyblock/auctions",
    { page: input.page ?? 0 },
    { ttlMs: 30_000 }
  );
  return formatAuctionResult(result, input, limit, "auctions");
}

export async function getGuideContext(
  client: HypixelClient,
  input: ProfileFetchOptions & {
    goals?: string[];
    includeEconomy?: boolean;
    includeMayor?: boolean;
    includeMuseum?: boolean;
    includeGarden?: boolean;
  }
): Promise<JsonObject> {
  const profile = await getSkyblockProfileContext(client, {
    ...input,
    decodeInventories: input.decodeInventories ?? false,
    includeMuseum: input.includeMuseum ?? false,
    includeGarden: input.includeGarden ?? true,
    maxItemsPerInventory: input.maxItemsPerInventory ?? 40,
    maxInventorySections: input.maxInventorySections ?? 12
  });
  const [mayor, bazaar] = await Promise.all([
    input.includeMayor === false
      ? Promise.resolve(undefined)
      : getSkyblockResource(client, { kind: "election", includeRaw: true }).catch((error) => formatOptionalError(error)),
    input.includeEconomy === false
      ? Promise.resolve(undefined)
      : getBazaar(client, { sortBy: "movingWeek", limit: 12 }).catch((error) => formatOptionalError(error))
  ]);

  return compactObject({
    generatedAt: new Date().toISOString(),
    requestedGoals: input.goals,
    guideInstructions: [
      "Use this context to make specific SkyBlock recommendations.",
      "Mention missing/private API sections before relying on them.",
      "Prefer concrete next actions tied to the profile's skills, collections, equipment, purse, bank, dungeons, slayers, garden, and current mayor/economy data.",
      "Do not claim precise inventory/accessory state when decodedInventories is empty or privacy notes report missing data."
    ],
    profile,
    mayor: summarizeMayor(mayor),
    bazaarSignals: bazaar
  });
}

export async function loadProfileMember(
  client: HypixelClient,
  options: ProfileSelection & {
    username?: string;
    uuid?: string;
    memberUsername?: string;
    memberUuid?: string;
  }
): Promise<LoadedProfileMember> {
  const player =
    options.uuid || options.username ? await resolvePlayer(client, { username: options.username, uuid: options.uuid }) : undefined;
  const profileResult = options.profileId
    ? await fetchProfileById(client, options.profileId)
    : await fetchProfilesForPlayer(client, requirePlayer(player));
  const selectedProfile = selectProfileFromEnvelope(profileResult.data, options);
  const profile = await hydrateSelectedProfile(client, selectedProfile, profileResult.data);
  const memberIdentity = await resolveMemberIdentity(client, options, player);
  const memberUuid = chooseMemberUuid(profile, memberIdentity?.uuid ?? player?.uuid);
  const member = memberUuid ? asRecord(asRecord(profile.members)?.[memberUuid]) : undefined;

  return {
    player,
    profileResult,
    profile,
    memberUuid,
    member
  };
}

function inventoryDecodeOptions(options: ProfileFetchOptions): InventorySectionQuery {
  return {
    maxSections: options.maxInventorySections,
    maxItemsPerSection: options.maxItemsPerInventory ?? 60,
    sectionTypes: options.inventorySectionTypes,
    sectionPaths: options.inventorySectionPaths,
    includeAllNbtData: options.includeAllNbtData,
    includeRawNbt: options.includeRawNbt,
    includeItemDetails: options.includeItemDetails,
    maxLoreLines: options.maxLoreLines
  };
}

function inventoryFetchDecodeOptions(options: InventoryFetchOptions): InventorySectionQuery {
  return {
    maxSections: options.maxSections ?? 40,
    maxItemsPerSection: options.maxItemsPerSection ?? 100,
    sectionTypes: options.sectionTypes,
    sectionPaths: options.sectionPaths,
    includeAllNbtData: options.includeAllNbtData,
    includeRawNbt: options.includeRawNbt,
    includeItemDetails: options.includeItemDetails,
    maxLoreLines: options.maxLoreLines
  };
}

function summarizeNbtLocations(locations: { path: string; sectionType: string }[]): JsonObject[] {
  return locations.map((location) => ({
    path: location.path,
    sectionType: location.sectionType
  }));
}

export function summarizeProfile(profile: JsonObject): JsonObject {
  const members = asRecord(profile.members) ?? {};
  const banking = summarizeBanking(profile);
  const memberSummaries = Object.entries(members).map(([uuid, member]) => {
    const memberRecord = asRecord(member) ?? {};
    return compactObject({
      uuid,
      lastSave: findFirstNumber(memberRecord, [
        ["profile", "last_save"],
        ["last_save"]
      ]),
      purse: findFirstNumber(memberRecord, [
        ["currencies", "coin_purse"],
        ["coin_purse"],
        ["profile", "coin_purse"]
      ]),
      skyblockLevelXp: findFirstNumber(memberRecord, [
        ["leveling", "experience"],
        ["profile", "leveling", "experience"]
      ]),
      skyblockLevel: (() => {
        const xp = findFirstNumber(memberRecord, [
          ["leveling", "experience"],
          ["profile", "leveling", "experience"]
        ]);
        return xp !== undefined ? skyblockLevelFromExperience(xp).level : undefined;
      })()
    });
  });

  return compactObject({
    profileId: asString(profile.profile_id) ?? asString(profile.profileId),
    cuteName: asString(profile.cute_name) ?? asString(profile.cuteName),
    selected: asBoolean(profile.selected),
    gameMode: asString(profile.game_mode) ?? asString(profile.gameMode),
    bank: asNumber(banking?.balance),
    banking,
    members: memberSummaries,
    memberCount: memberSummaries.length
  });
}

export function summarizeMember(member: JsonObject, uuid?: string): JsonObject {
  const experiences = collectSkillExperience(member);
  const slayer = asRecord(getPath(member, ["slayer", "slayer_bosses"])) ?? asRecord(member.slayer_bosses);
  const dungeons = asRecord(member.dungeons);
  const pets = getPets(member);
  const collections = asRecord(member.collection) ?? asRecord(getPath(member, ["player_data", "collection"]));
  const currencies = asRecord(member.currencies);
  const objectives = asRecord(member.objectives);
  const quests = asRecord(member.quests);
  const sbXp = findFirstNumber(member, [
    ["leveling", "experience"],
    ["profile", "leveling", "experience"]
  ]);
  const skillLevels = summarizeSkillLevels(
    Object.fromEntries(
      Object.entries(experiences)
        .map(([skill, value]) => [skill, asNumber(value)])
        .filter((entry): entry is [string, number] => entry[1] !== undefined)
    )
  );
  const dungeonSummary = summarizeDungeons(dungeons);
  const slayerSummary = summarizeSlayers(slayer);
  const ratings = buildPlayerRatings({
    skillLevels,
    slayers: slayerSummary,
    catacombsLevel: asNumber(dungeonSummary?.catacombsLevel),
    magicalPower: asNumber(getPath(member, ["accessory_bag_storage", "highest_magical_power"])),
    skyblockLevel: sbXp !== undefined ? skyblockLevelFromExperience(sbXp).level : undefined
  });

  return compactObject({
    uuid,
    lastSave: findFirstNumber(member, [
      ["profile", "last_save"],
      ["last_save"]
    ]),
    firstJoin: findFirstNumber(member, [
      ["profile", "first_join"],
      ["first_join"]
    ]),
    purse: findFirstNumber(member, [
      ["currencies", "coin_purse"],
      ["coin_purse"],
      ["profile", "coin_purse"]
    ]),
    skyblockLevelXp: sbXp,
    skyblockLevel: sbXp !== undefined ? skyblockLevelFromExperience(sbXp).level : undefined,
    skills: experiences,
    skillLevels,
    ratings,
    progression: summarizeProgression(member),
    slayers: slayerSummary,
    dungeons: dungeonSummary,
    pets: summarizePets(pets),
    collections: summarizeCollections(collections),
    currencies: summarizeCurrencies(currencies),
    essence: summarizeEssence(member),
    jacobContest: member.jacob_contest,
    accessoryBag: pickPaths(member, {
      tuning: ["accessory_bag_storage", "tuning"],
      selectedPower: ["accessory_bag_storage", "selected_power"],
      highestMagicalPower: ["accessory_bag_storage", "highest_magical_power"],
      unlockedPowers: ["accessory_bag_storage", "unlocked_powers"]
    }),
    objectives: takeEntries(objectives as Record<string, unknown> | undefined, 20),
    quests: takeEntries(quests as Record<string, unknown> | undefined, 20)
  });
}

function summarizeCollections(collections: JsonObject | undefined): JsonObject | undefined {
  if (!collections) {
    return undefined;
  }

  const entries = Object.entries(collections);
  const top = sortByNumeric(
    entries.map(([key, value]) => ({ key, value: asNumber(value) ?? 0 })),
    (entry) => entry.value,
    "desc"
  ).slice(0, 40);

  return compactObject({
    totalKinds: entries.length,
    top: Object.fromEntries(top.map((entry) => [entry.key, entry.value]))
  });
}

function summarizeCurrencies(currencies: JsonObject | undefined): JsonObject | undefined {
  if (!currencies) {
    return undefined;
  }

  return compactObject({
    coinPurse: asNumber(currencies.coin_purse),
    motesPurse: asNumber(currencies.motes_purse),
    essence: summarizeEssence({ currencies } as JsonObject)
  });
}

function resourcePath(kind: ResourceKind): string {
  switch (kind) {
    case "collections":
      return "/v2/resources/skyblock/collections";
    case "skills":
      return "/v2/resources/skyblock/skills";
    case "items":
      return "/v2/resources/skyblock/items";
    case "election":
      return "/v2/resources/skyblock/election";
    case "bingo":
      return "/v2/resources/skyblock/bingo";
    case "news":
      return "/v2/skyblock/news";
  }
}

function selectProfileFromEnvelope(envelope: JsonObject, selection: ProfileSelection): JsonObject {
  const directProfile = asRecord(envelope.profile);
  if (directProfile) {
    return directProfile;
  }

  const profiles = (asArray(envelope.profiles) ?? []).map((profile) => asRecord(profile)).filter((profile): profile is JsonObject => Boolean(profile));

  if (profiles.length === 0) {
    throw new McpUserError("No SkyBlock profiles were returned for this player.");
  }

  if (selection.profileId) {
    const found = profiles.find((profile) => normalizeUuid(String(profile.profile_id ?? "")) === normalizeUuid(selection.profileId!));
    if (found) {
      return found;
    }
  }

  if (selection.profileName) {
    const wanted = selection.profileName.toLowerCase();
    const found = profiles.find((profile) => asString(profile.cute_name)?.toLowerCase() === wanted);
    if (found) {
      return found;
    }
  }

  if (selection.selectedOnly !== false) {
    const selected = profiles.find((profile) => profile.selected === true);
    if (selected) {
      return selected;
    }
  }

  const sorted = sortByNumeric(profiles, (profile) => latestMemberSave(profile), "desc");
  return sorted[0] ?? profiles[0]!;
}

async function hydrateSelectedProfile(
  client: HypixelClient,
  selectedProfile: JsonObject,
  originalEnvelope: JsonObject
): Promise<JsonObject> {
  if (asRecord(originalEnvelope.profile)) {
    return selectedProfile;
  }

  const profileId = asString(selectedProfile.profile_id) ?? asString(selectedProfile.profileId);
  if (!profileId) {
    return selectedProfile;
  }

  try {
    const detailResult = await fetchProfileById(client, profileId);
    const detailProfile = selectProfileFromEnvelope(detailResult.data, { profileId, selectedOnly: false });
    return mergeProfileRecords(selectedProfile, detailProfile);
  } catch {
    return selectedProfile;
  }
}

function mergeProfileRecords(listProfile: JsonObject, detailProfile: JsonObject): JsonObject {
  const listBanking = asRecord(listProfile.banking);
  const detailBanking = asRecord(detailProfile.banking);
  const banking =
    findFirstNumber(detailProfile, [["banking", "balance"]]) !== undefined
      ? detailBanking
      : findFirstNumber(listProfile, [["banking", "balance"]]) !== undefined
        ? listBanking
        : detailBanking ?? listBanking;

  return compactObject({
    ...listProfile,
    ...detailProfile,
    profile_id: asString(detailProfile.profile_id) ?? asString(listProfile.profile_id),
    cute_name: asString(detailProfile.cute_name) ?? asString(listProfile.cute_name),
    selected: asBoolean(detailProfile.selected) ?? asBoolean(listProfile.selected),
    game_mode: asString(detailProfile.game_mode) ?? asString(listProfile.game_mode),
    banking,
    members: asRecord(detailProfile.members) ?? asRecord(listProfile.members)
  });
}

function requirePlayer(player: PlayerIdentity | undefined): PlayerIdentity {
  if (!player) {
    throw new McpUserError("Provide username or uuid when profileId is not supplied.");
  }

  return player;
}

async function resolveMemberIdentity(
  client: HypixelClient,
  options: ProfileFetchOptions,
  player: PlayerIdentity | undefined
): Promise<PlayerIdentity | undefined> {
  if (options.memberUuid) {
    return resolvePlayer(client, { uuid: options.memberUuid });
  }

  if (options.memberUsername) {
    return resolvePlayer(client, { username: options.memberUsername });
  }

  return player;
}

function chooseMemberUuid(profile: JsonObject, preferredUuid: string | undefined): string | undefined {
  const members = asRecord(profile.members);
  if (!members) {
    return undefined;
  }

  if (preferredUuid && members[normalizeUuid(preferredUuid)]) {
    return normalizeUuid(preferredUuid);
  }

  const sorted = sortByNumeric(Object.entries(members), ([, member]) => {
    const memberRecord = asRecord(member) ?? {};
    return findFirstNumber(memberRecord, [
      ["profile", "last_save"],
      ["last_save"]
    ]);
  });

  return sorted[0]?.[0];
}

function latestMemberSave(profile: JsonObject): number | undefined {
  const members = asRecord(profile.members);
  if (!members) {
    return undefined;
  }

  const values = Object.values(members)
    .map((member) =>
      findFirstNumber(asRecord(member) ?? {}, [
        ["profile", "last_save"],
        ["last_save"]
      ])
    )
    .filter((value): value is number => value !== undefined);

  return values.length > 0 ? Math.max(...values) : undefined;
}

function findFirstNumber(object: unknown, paths: string[][]): number | undefined {
  for (const path of paths) {
    const value = asNumber(getPath(object, path));
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function summarizeBanking(profile: JsonObject): JsonObject | undefined {
  const banking = asRecord(profile.banking);
  const balance = findFirstNumber(profile, [
    ["banking", "balance"],
    ["bank", "balance"],
    ["profile", "banking", "balance"],
    ["profile", "bank", "balance"]
  ]);

  if (!banking && balance === undefined) {
    return {
      available: false
    };
  }

  const transactions = asArray(banking?.transactions);
  return compactObject({
    available: balance !== undefined || banking !== undefined,
    balance,
    transactionCount: transactions?.length,
    latestTransaction: asRecord(transactions?.[0])
  });
}

function collectSkillExperience(member: JsonObject): JsonObject {
  const result: JsonObject = {};
  const explicitExperience =
    asRecord(getPath(member, ["player_data", "experience"])) ??
    asRecord(getPath(member, ["player", "experience"])) ??
    asRecord(member.experience);

  if (explicitExperience) {
    for (const [key, value] of Object.entries(explicitExperience)) {
      if (typeof value === "number") {
        result[cleanSkillKey(key)] = value;
      }
    }
  }

  for (const [key, value] of Object.entries(member)) {
    if (key.startsWith("experience_skill_") && typeof value === "number") {
      result[cleanSkillKey(key.replace("experience_skill_", ""))] = value;
    }
  }

  return result;
}

function cleanSkillKey(value: string): string {
  return value.replace(/^SKILL_/, "").toLowerCase();
}

function summarizeSlayers(slayer: JsonObject | undefined): JsonObject | undefined {
  if (!slayer) {
    return undefined;
  }

  const result: JsonObject = {};
  for (const [boss, value] of Object.entries(slayer)) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }

    result[boss] = compactObject({
      xp: asNumber(record.xp),
      tier: slayerTierFromRecord(asRecord(record.claimed_levels)),
      claimedLevels: record.claimed_levels,
      bossesKilled: takeEntries(asRecord(record.boss_kills) as Record<string, unknown> | undefined, 5)
    });
  }

  return result;
}

function summarizeDungeonBestRuns(bestRuns: JsonObject | undefined): JsonObject | undefined {
  if (!bestRuns) {
    return undefined;
  }

  const result: JsonObject = {};

  for (const [tier, runs] of Object.entries(bestRuns)) {
    const runList = asArray(runs);
    if (!runList?.length) {
      continue;
    }

    const best = runList[0];
    result[tier] = best;
  }

  return result;
}

function summarizeDungeons(dungeons: JsonObject | undefined): JsonObject | undefined {
  if (!dungeons) {
    return undefined;
  }

  const playerClasses = asRecord(dungeons.player_classes);
  const classLevels: JsonObject = {};

  for (const [name, value] of Object.entries(playerClasses ?? {})) {
    const xp = asNumber(asRecord(value)?.experience);
    if (xp !== undefined) {
      classLevels[name] = catacombsLevelFromXp(xp).level;
    }
  }

  const catacombs = asRecord(asRecord(dungeons.dungeon_types)?.catacombs);
  const catacombsXp = asNumber(catacombs?.experience);

  return compactObject({
    selectedClass: dungeons.selected_dungeon_class,
    catacombsLevel: catacombsXp !== undefined ? catacombsLevelFromXp(catacombsXp).level : undefined,
    classLevels,
    dungeonTypes: Object.fromEntries(
      Object.entries(asRecord(dungeons.dungeon_types) ?? {}).map(([name, value]) => {
        const record = asRecord(value) ?? {};
        return [
          name,
          compactObject({
            experience: asNumber(record.experience),
            highestTierCompleted: asNumber(record.highest_tier_completed),
            tierCompletions: record.tier_completions,
            fastestTime: record.fastest_time,
            bestRuns: summarizeDungeonBestRuns(asRecord(record.best_runs))
          })
        ];
      })
    ),
    playerClasses
  });
}

function getPets(member: JsonObject): unknown[] | undefined {
  return (
    asArray(getPath(member, ["pets_data", "pets"])) ??
    asArray(member.pets) ??
    asArray(getPath(member, ["profile", "pets"]))
  );
}

function summarizePets(pets: unknown[] | undefined): JsonObject | undefined {
  if (!pets) {
    return undefined;
  }

  const sorted = sortByNumeric(
    pets.map((pet) => asRecord(pet)).filter((pet): pet is JsonObject => Boolean(pet)),
    (pet) => asNumber(pet.exp),
    "desc"
  );

  return {
    count: pets.length,
    active: (() => {
      const pet = sorted.find((entry) => entry.active === true);
      if (!pet) {
        return undefined;
      }

      const exp = asNumber(pet.exp);
      const tier = asString(pet.tier) ?? "COMMON";

      return compactObject({
        type: pet.type,
        tier: pet.tier,
        exp: pet.exp,
        active: pet.active,
        heldItem: pet.heldItem,
        candyUsed: pet.candyUsed,
        skin: pet.skin,
        level: exp !== undefined ? petLevelFromExp(exp, tier, asString(pet.type)).level : undefined
      });
    })(),
    topByExp: sorted.slice(0, 10).map((pet) => {
      const exp = asNumber(pet.exp);
      const tier = asString(pet.tier) ?? "COMMON";

      return compactObject({
        type: pet.type,
        tier: pet.tier,
        exp: pet.exp,
        active: pet.active,
        heldItem: pet.heldItem,
        candyUsed: pet.candyUsed,
        skin: pet.skin,
        level: exp !== undefined ? petLevelFromExp(exp, tier, asString(pet.type)).level : undefined
      });
    })
  };
}

function privacyNotes(member: JsonObject | undefined, decodedInventories: DecodedInventory[] | undefined): string[] {
  const notes: string[] = [];

  if (!member) {
    notes.push("No matching member object was returned for the selected profile.");
    return notes;
  }

  if (!Object.keys(collectSkillExperience(member)).length) {
    notes.push("Skill experience is missing or private.");
  }

  if (!asRecord(member.inventory) && !decodedInventories?.length) {
    notes.push("Inventory data is missing or private.");
  }

  if (!getPets(member)?.length) {
    notes.push("Pet data is missing or private.");
  }

  if (!asRecord(member.collection) && !asRecord(getPath(member, ["player_data", "collection"]))) {
    notes.push("Collection data is missing or private.");
  }

  return notes;
}

async function getOptionalProfileEndpoint(client: HypixelClient, path: string, profileId: unknown): Promise<JsonObject> {
  const profile = asString(profileId);
  if (!profile) {
    return { error: "Selected profile has no profile_id." };
  }

  try {
    const result = await client.hypixel<JsonObject>(path, { profile }, { requiresApiKey: true, ttlMs: 60_000 });
    return { meta: result.meta, data: result.data };
  } catch (error) {
    return formatOptionalError(error);
  }
}

function formatOptionalError(error: unknown): JsonObject {
  return {
    error: error instanceof Error ? error.message : String(error)
  };
}

function filterItems(items: unknown[], input: { search?: string; ids?: string[]; category?: string; tier?: string }, limit: number): JsonObject[] {
  const ids = new Set(input.ids?.map((id) => id.toUpperCase()));
  const search = input.search?.toLowerCase();
  const category = input.category?.toUpperCase();
  const tier = input.tier?.toUpperCase();

  return items
    .map((item) => asRecord(item))
    .filter((item): item is JsonObject => Boolean(item))
    .filter((item) => {
      const id = asString(item.id)?.toUpperCase();
      const name = asString(item.name)?.toLowerCase();
      if (ids.size > 0 && (!id || !ids.has(id))) return false;
      if (search && !id?.toLowerCase().includes(search) && !name?.includes(search)) return false;
      if (category && asString(item.category)?.toUpperCase() !== category) return false;
      if (tier && asString(item.tier)?.toUpperCase() !== tier) return false;
      return true;
    })
    .slice(0, limit)
    .map((item) =>
      compactObject({
        id: item.id,
        name: item.name,
        tier: item.tier,
        category: item.category,
        material: item.material,
        stats: item.stats,
        npcSellPrice: item.npc_sell_price,
        museum: item.museum,
        soulbound: item.soulbound
      })
    );
}

function filterRecordBySearch(record: JsonObject | undefined, search: string | undefined, limit: number): JsonObject {
  const needle = search?.toLowerCase();
  const entries = Object.entries(record ?? {}).filter(([key]) => !needle || key.toLowerCase().includes(needle)).slice(0, limit);
  return Object.fromEntries(entries);
}

function summarizeBazaarProduct(productId: string, product: unknown, includeOrders: boolean): JsonObject {
  const record = asRecord(product) ?? {};
  const quick = asRecord(record.quick_status) ?? {};
  const sellPrice = asNumber(quick.sellPrice);
  const buyPrice = asNumber(quick.buyPrice);
  const margin = buyPrice !== undefined && sellPrice !== undefined ? buyPrice - sellPrice : undefined;
  const marginPercent = margin !== undefined && sellPrice ? percent(margin, sellPrice) : undefined;

  return compactObject({
    productId,
    sellPrice,
    buyPrice,
    margin,
    marginPercent,
    sellVolume: asNumber(quick.sellVolume),
    buyVolume: asNumber(quick.buyVolume),
    movingWeek: numberOrZero(quick.sellMovingWeek) + numberOrZero(quick.buyMovingWeek),
    sellOrders: asNumber(quick.sellOrders),
    buyOrders: asNumber(quick.buyOrders),
    sellSummary: includeOrders ? record.sell_summary : undefined,
    buySummary: includeOrders ? record.buy_summary : undefined
  });
}

function matchesBazaarFilter(product: JsonObject, input: { productIds?: string[]; search?: string }): boolean {
  const productId = asString(product.productId);
  if (!productId) {
    return false;
  }

  if (input.productIds?.length) {
    const ids = new Set(input.productIds.map((id) => id.toUpperCase()));
    if (!ids.has(productId.toUpperCase())) {
      return false;
    }
  }

  if (input.search && !productId.toLowerCase().includes(input.search.toLowerCase())) {
    return false;
  }

  return true;
}

function formatAuctionResult(
  result: ApiResult<JsonObject>,
  input: {
    search?: string;
    tier?: string;
    category?: string;
    binOnly?: boolean;
    includeRaw?: boolean;
  },
  limit: number,
  auctionField: string
): JsonObject {
  const auctions = asArray(result.data[auctionField]) ?? asArray(result.data.auctions) ?? [];

  if (input.includeRaw) {
    return {
      meta: result.meta,
      raw: result.data
    };
  }

  return {
    meta: result.meta,
    page: result.data.page,
    totalPages: result.data.totalPages,
    totalAuctions: result.data.totalAuctions,
    lastUpdated: result.data.lastUpdated,
    auctions: auctions.map(summarizeAuction).filter((auction) => matchesAuctionFilter(auction, input)).slice(0, limit)
  };
}

function summarizeAuction(auction: unknown): JsonObject {
  const record = asRecord(auction) ?? {};
  return compactObject({
    uuid: record.uuid,
    auctioneer: record.auctioneer,
    profileId: record.profile_id,
    itemName: asString(record.item_name) ? stripMinecraftFormatting(asString(record.item_name)!) : record.item_name,
    itemLore: asString(record.item_lore)?.split("\n").slice(0, 10).map(stripMinecraftFormatting),
    category: record.category,
    tier: record.tier,
    bin: record.bin,
    startingBid: record.starting_bid,
    highestBidAmount: record.highest_bid_amount,
    bids: asArray(record.bids)?.length,
    start: record.start,
    end: record.end,
    claimed: record.claimed
  });
}

function matchesAuctionFilter(auction: JsonObject, input: { search?: string; tier?: string; category?: string; binOnly?: boolean }): boolean {
  if (input.binOnly && auction.bin !== true) {
    return false;
  }

  if (input.tier && asString(auction.tier)?.toUpperCase() !== input.tier.toUpperCase()) {
    return false;
  }

  if (input.category && asString(auction.category)?.toUpperCase() !== input.category.toUpperCase()) {
    return false;
  }

  if (input.search) {
    const itemName = asString(auction.itemName)?.toLowerCase();
    if (!itemName?.includes(input.search.toLowerCase())) {
      return false;
    }
  }

  return true;
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(value), max));
}
