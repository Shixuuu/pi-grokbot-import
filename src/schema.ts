export {
  BUNDLE_FORMAT,
  isGrokBotBundle,
  toSkillSlug,
  toBotSlug,
} from "./schema.mjs";

export interface GrokBotPersona {
  name: string;
  title?: string;
  description: string;
  avatarShape?: string;
  avatarColor?: string;
}

export interface GrokBotMemory {
  kind: "profile" | "log";
  text: string;
  source?: string;
}

export interface GrokBotSkill {
  name: string;
  description: string;
  body: string;
  source?: string;
}

export interface GrokBotRoutine {
  name: string;
  schedule?: string;
  triggerSummary?: string;
  prompt: string;
}

export interface GrokBotPluginHint {
  id: string;
  note?: string;
}

export interface GrokBotSource {
  platform: "grok-bot";
  agentId: string;
  harness?: string;
  serverId?: string;
  /** Provenance for share/marketplace imports */
  kind?: "xai-share" | "local-export" | string;
  id?: string;
  url?: string;
  sharerName?: string;
  mode?: "metadata-only" | "full";
  ownerType?: string;
  marketplaceSlug?: string;
  color?: string;
  shape?: string;
  addHref?: string;
  originalInput?: string;
  resolvedFrom?: Record<string, unknown>;
  localCachePath?: string;
}

export interface GrokBotBundle {
  format: "grokbot-bundle/v1";
  exportedAt: string;
  source: GrokBotSource;
  persona: GrokBotPersona;
  memories: GrokBotMemory[];
  skills: GrokBotSkill[];
  routines: GrokBotRoutine[];
  plugins: GrokBotPluginHint[];
  omitted: string[];
}
