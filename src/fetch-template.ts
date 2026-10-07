export {
  isGrokBotShareOrMarketplaceUrl,
  normalizeTemplateInput,
  parseShareIdFromUrl,
  parseBotTemplateHtml,
  parseMarketplaceHtml,
  shareIdFromAddHref,
  tryAuthenticatedFullFetch,
  probeLocalTemplateCaches,
  buildMetadataBundle,
  mapFullRecipeToBundle,
  fetchPublicApiMeta,
  tryCursorImportDetails,
  asFetchResponse,
  asFetchText,
  fetchTemplateAsBundle,
  loadBundleFromSource,
} from "./fetch-template.mjs";

export type TemplateNormalizeResult =
  | {
      kind: "share-id";
      id: string;
      url: string;
      original: string;
      marketplaceMeta?: MarketplaceListing;
    }
  | {
      kind: "marketplace";
      slug: string;
      url: string;
      original: string;
    }
  | {
      kind: "grokbottemplates";
      slug: string;
      url: string;
      apiUrl: string;
      original: string;
    };

export type BotTemplateMeta = {
  id: string;
  ownerType: string;
  sharerName: string;
  botName: string;
  description: string;
  addHref: string;
  color: string;
  shape: string;
};

export type MarketplaceListing = {
  slug: string;
  name: string;
  description: string;
  creatorName: string;
  addHref: string;
  shareId: string | null;
};

export type FetchTemplateResult = {
  bundle: import("./schema.ts").GrokBotBundle;
  mode: "metadata-only" | "full";
  meta: BotTemplateMeta;
  fullFetch: { ok: boolean; url?: string; attempts?: unknown[]; skipped?: boolean };
  localCacheHits: string[];
};
