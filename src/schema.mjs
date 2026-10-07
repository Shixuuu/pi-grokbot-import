export const BUNDLE_FORMAT = "grokbot-bundle/v1";

export function isGrokBotBundle(value) {
  if (!value || typeof value !== "object") return false;
  if (value.format !== BUNDLE_FORMAT) return false;
  if (!value.persona || typeof value.persona !== "object") return false;
  if (typeof value.persona.name !== "string" || typeof value.persona.description !== "string") {
    return false;
  }
  if (!Array.isArray(value.memories) || !Array.isArray(value.skills) || !Array.isArray(value.routines)) {
    return false;
  }
  return true;
}

export function toSkillSlug(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
  return s || "unnamed-skill";
}

export function toBotSlug(name) {
  return toSkillSlug(name) || "imported-bot";
}
