/**
 * Static, structural guardrails attached to live-market tool output so the
 * consuming agent reasons about prices correctly instead of treating any single
 * number as guaranteed profit or guaranteed liquidation value.
 *
 * These are intentionally timeless: they describe how the SkyBlock economy works
 * (tax, volume limits, liquidity, single-listing noise), not the current meta or
 * specific items/strategies, so they do not themselves go stale.
 */

export const BAZAAR_CAVEATS: readonly string[] = [
  "Bazaar instant-buy/instant-sell incurs tax and order fees, so realized margin is lower than the raw buy/sell spread.",
  "movingWeek volume is the ceiling on how much you can actually buy or sell; a large spread on a thin market is not realizable at size.",
  "Spread (buyPrice - sellPrice) is not guaranteed profit: filling buy/sell orders takes time and prices move against you.",
  "Instant prices differ from order (best offer) prices; quote the basis that matches the user's intended action."
];

export const AUCTION_CAVEATS: readonly string[] = [
  "Lowest-BIN can be a troll, mispriced, or scam listing (wrong reforge/enchants/stars). Corroborate against several listings before quoting a value.",
  "Distinguish BIN (fixed price) from bidded auctions; a low starting bid is not the sale price.",
  "ended_recent is a small, recent sample, not a full market history; treat it as indicative, not definitive.",
  "Item attributes (stars, enchants, gemstones, reforge) drive price heavily; compare like-for-like, not just by item name."
];

export const ITEM_VALUE_CAVEATS: readonly string[] = [
  "A Bazaar value is subject to tax/fees on actual transactions; it is a reference price, not a locked-in payout.",
  "A lowest_bin value is a single data point and can be skewed by troll or mispriced listings; confirm with skyblock_auctions before relying on it.",
  "A value.source of \"none\" means there is no live price for this auction-only item; do not estimate one from memory — use skyblock_auctions."
];

export const NETWORTH_CAVEATS: readonly string[] = [
  "Net worth is an estimate of replacement/market value, not a guaranteed liquidation payout; the market cannot absorb instant full liquidation at these prices.",
  "Modifier values (enchants, stars, reforges, gemstones) are approximate and auction-only items depend on an external lowest-BIN source when configured.",
  "Check coverage: when pricedPercent is well below 100%, the total understates value — hedge rather than asserting a precise figure."
];
