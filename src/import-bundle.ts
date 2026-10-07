export {
  TRANSFER_MATRIX,
  importGrokBotBundle,
  loadBundleFromPath,
} from "./import-bundle.mjs";

export type ImportOptions = {
  outDir: string;
  force?: boolean;
};

export type ImportResult = {
  outDir: string;
  slug: string;
  imported: {
    persona: boolean;
    memories: number;
    skills: number;
    routines: number;
    pluginsNoted: number;
  };
  reportPath: string;
  reportText: string;
};
