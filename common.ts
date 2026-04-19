export const PROVIDERS = [
  "cohere",
  "textsynth",
  "openai-compat",
  "openai",
  "openai-chat",
  "azure",
  "azure-chat",
  "anthropic",
  "openrouter",
  "bedrock",
  "probe",
];
export type Provider = (typeof PROVIDERS)[number];

type ProviderProps = {
  openai: { organization: string };
  "openai-chat": { organization: string };
  "openai-compat": { url: string };
  azure: { url: string };
  "azure-chat": { url: string };
  anthropic: { url: string };
  openrouter: { quantization: string };
  bedrock: { region: string };
  probe: { url: string };
};

export type SteeringType = "none" | "steer" | "floor" | "ceil";

export interface ProbeSetInfo {
  name: string;
  layer: number;
  labels: string[];
}

export interface ProbeConfig {
  model: string;
  model_type: string;
  probes: ProbeSetInfo[];
  intervention_types: string[];
}

type SharedPresetSettings = {
  name: string;

  model: string;
  contextLength: number;
  apiKey: string;
};

export type ModelPreset<P extends Provider> = SharedPresetSettings &
  (P extends keyof ProviderProps ? ProviderProps[P] : {}) & { provider: P };

export interface LoomSettings {
  passageFolder: string;
  defaultPassageSeparator: string;
  defaultPassageFrontmatter: string;

  logApiCalls: boolean;

  modelPresets: ModelPreset<Provider>[];
  modelPreset: number;

  visibility: Record<string, boolean>;
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  prepend: string;
  bestOf: number;
  n: number;
  systemPrompt: string;
  userMessage: string;

  showSettings: boolean;
  showSearchBar: boolean;
  showNodeBorders: boolean;
  showExport: boolean;

  /** When true, emit verbose console logs for debugging and development */
  developerMode: boolean;

  // Storage settings
  useDocumentStorage: boolean;
  documentStorageLocation: 'alongside' | 'plugin-folder';
  autoMigrateOnSwitch: boolean;

  // Probe-server steering
  steeringType: SteeringType;
  steeringProbe: string;
  steeringProbeIndex: number;
  steeringStrength: number;
  steeringRenorm: boolean;
  probeConfigs: Record<string, ProbeConfig>;
}

export const getPreset = (settings: LoomSettings) =>
  settings.modelPresets[settings.modelPreset];

export type SearchResultState = "result" | "ancestor" | "none" | null;

export interface Node {
  text: string;
  parentId: string | null;
  collapsed: boolean;
  unread: boolean;
  tags: string[];
  lastVisited?: number;
  created?: number;
  childrenGeneratedAt?: number;
  siblingExplorationRatio?: number;
  generationSpeed?: number;
  intensity?: number;
  searchResultState: SearchResultState;
  
  // New metadata fields for consciousness research
  nodeType?: 'ai-generated' | 'user-edited' | 'user-created';
  createdTimestamp?: number;
  firstReadTimestamp?: number;
  reReadTimestamps?: number[];
  generationModel?: string;
  generationParameters?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    provider?: string;
    model?: string;
  };
  originalNodeId?: string; // For edited nodes, reference to original
}

export interface NoteState {
  current: string;
  hoisted: string[];
  searchTerm: string;
  filter: string;
  nodes: Record<string, Node>;
  generating: string | null;
}
