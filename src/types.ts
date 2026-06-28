export type JsonObject = Record<string, unknown>;
export type JsonArray = unknown[];
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export type RateLimitInfo = {
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
};

export type RequestMeta = {
  cached: boolean;
  fetchedAt: string;
  rateLimit?: RateLimitInfo;
  source: string;
};

export type ApiResult<T> = {
  data: T;
  meta: RequestMeta;
};

export type HypixelEnvelope = {
  success?: boolean;
  cause?: string;
  [key: string]: unknown;
};

export type PlayerIdentity = {
  username?: string;
  uuid: string;
  uuidDashed: string;
};

export type DecodedInventoryItem = {
  slot?: number;
  skyblockId?: string;
  minecraftId?: string;
  name?: string;
  count?: number;
  rarity?: string;
  reforge?: string;
  enchantments?: Record<string, number>;
  attributes?: Record<string, number>;
  gems?: JsonObject;
  hotPotatoCount?: number;
  rarityUpgrades?: number;
  dungeonStars?: number;
  itemUuid?: string;
  timestamp?: string;
  extraAttributes?: JsonObject;
  lore?: string[];
};

export type DecodedInventory = {
  path: string;
  sectionType?: string;
  itemCount: number;
  shownItems: number;
  items: DecodedInventoryItem[];
  truncated: boolean;
  raw?: unknown;
  error?: string;
};
