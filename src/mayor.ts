import type { JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject, sortByNumeric, stripMinecraftFormatting } from "./utils.js";

// Special election candidates whose perks rotate or behave unusually; useful
// context for advice. Jerry, Derpy, and Scorpius are the recurring specials
// (every 8 elections); Dante, Technoblade, and Aura have appeared as one-time
// special candidates. Marina, Foxy, Paul, etc. are regular mayors.
// https://wiki.hypixel.net/Mayor
const SPECIAL_MAYORS = new Set(["jerry", "derpy", "scorpius", "dante", "technoblade", "aura"]);

function summarizePerks(perks: unknown): JsonObject[] | undefined {
  const list = asArray(perks);
  if (!list?.length) {
    return undefined;
  }

  const summarized = list
    .map((perk) => asRecord(perk))
    .filter((perk): perk is JsonObject => Boolean(perk))
    .map((perk) =>
      compactObject({
        name: asString(perk.name),
        description: asString(perk.description) ? stripMinecraftFormatting(asString(perk.description)!) : undefined,
        minister: perk.minister === true ? true : undefined
      })
    );

  return summarized.length ? summarized : undefined;
}

function summarizeCandidate(candidate: JsonObject): JsonObject {
  return compactObject({
    key: asString(candidate.key),
    name: asString(candidate.name),
    votes: asNumber(candidate.votes),
    perks: summarizePerks(candidate.perks)
  });
}

/**
 * Turns the raw `/resources/skyblock/election` payload into a compact summary:
 * the active mayor and perks, the elected minister (if any), and the ongoing
 * election leaderboard. Accepts either the full resource envelope or its data.
 */
export function summarizeMayor(electionResource: unknown): JsonObject | undefined {
  const root = asRecord(electionResource);
  const data = asRecord(root?.resource) ?? asRecord(root?.data) ?? root;
  const mayor = asRecord(data?.mayor);
  const current = asRecord(data?.current);

  if (!mayor && !current) {
    return undefined;
  }

  const key = asString(mayor?.key);
  const minister = asRecord(mayor?.minister);

  const active = mayor
    ? compactObject({
        key,
        name: asString(mayor.name),
        special: key ? SPECIAL_MAYORS.has(key.toLowerCase()) : undefined,
        perks: summarizePerks(mayor.perks),
        minister: minister
          ? compactObject({
              key: asString(minister.key),
              name: asString(minister.name),
              perks: summarizePerks(minister.perks)
            })
          : undefined
      })
    : undefined;

  const candidates = (asArray(current?.candidates) ?? [])
    .map((candidate) => asRecord(candidate))
    .filter((candidate): candidate is JsonObject => Boolean(candidate))
    .map(summarizeCandidate);
  const ranked = sortByNumeric(candidates, (candidate) => asNumber(candidate.votes), "desc");

  const election = current
    ? compactObject({
        year: asNumber(current.year),
        leader: ranked[0],
        candidates: ranked
      })
    : undefined;

  return compactObject({
    lastUpdated: asNumber(data?.lastUpdated),
    active,
    election
  });
}
