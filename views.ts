import { LoomSettings, Node, NoteState, getPreset } from "./common";
import {
  App,
  ItemView,
  Menu,
  Modal,
  Setting,
  WorkspaceLeaf,
  setIcon,
  Notice,
} from "obsidian";
import { Range, StateEffect, StateField, Extension } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  PluginSpec,
  PluginValue,
  WidgetType,
} from "@codemirror/view";
const dialog = require("electron").remote.dialog;

// Define quick tags once to use everywhere
const QUICK_TAGS = [
  { tag: 'to_continue', label: 'To Continue', icon: 'git-branch-plus', emoji: '🌳' },
  { tag: 'fav', label: 'Favorite', icon: 'star', emoji: '⭐' },
  { tag: 'private', label: 'Private', icon: 'lock', emoji: '🔒' }
];

// Parse filter string like "+to_continue -private fav"
function parseFilter(filterStr: string): { include: string[], exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  
  if (!filterStr.trim()) return { include, exclude };
  
  const parts = filterStr.trim().split(/\s+/);
  for (const part of parts) {
    if (part.startsWith('+')) {
      include.push(part.slice(1));
    } else if (part.startsWith('-')) {
      exclude.push(part.slice(1));
    } else if (part.trim()) {
      // No prefix means include
      include.push(part);
    }
  }
  
  return { include, exclude };
}

// Check if a node matches the filter criteria
function nodeMatchesFilter(node: Node, include: string[], exclude: string[]): boolean {
  const nodeTags = node.tags || [];
  
  // Must have all included tags
  for (const tag of include) {
    if (!nodeTags.includes(tag)) return false;
  }
  
  // Must not have any excluded tags
  for (const tag of exclude) {
    if (nodeTags.includes(tag)) return false;
  }
  
  return true;
}

// Debug logging helper
function debugLog(settings: any, ...args: any[]) {
  if (settings?.developerMode) {
    console.log('[Loom Filter Debug]', ...args);
  }
}

// Build a set of nodes to show based on filter rules
function buildFilteredNodeSet(state: NoteState, include: string[], exclude: string[], settings?: any): Set<string> {
  debugLog(settings, 'Building filtered node set:', { include, exclude });
  
  if (include.length === 0 && exclude.length === 0) {
    // No filters - show everything
    const allNodes = new Set(Object.keys(state.nodes));
    debugLog(settings, 'No filters active, showing all', allNodes.size, 'nodes');
    return allNodes;
    }
  
  const directMatches = new Set<string>();
  const toHide = new Set<string>();
  
  // First pass: find nodes that directly match the filter
    for (const [id, node] of Object.entries(state.nodes)) {
    if (nodeMatchesFilter(node, include, exclude)) {
      directMatches.add(id);
    }
  }
  
  debugLog(settings, 'Direct matches found:', directMatches.size, 'nodes');
  
  // Second pass: for excluded tags, hide those nodes and all descendants
      for (const [id, node] of Object.entries(state.nodes)) {
    const nodeTags = node.tags || [];
    if (exclude.some(tag => nodeTags.includes(tag))) {
      // Hide this node and all its descendants
      const hideDescendants = (nodeId: string) => {
        toHide.add(nodeId);
        for (const [childId, childNode] of Object.entries(state.nodes)) {
          if (childNode.parentId === nodeId) {
            hideDescendants(childId);
          }
        }
      };
      hideDescendants(id);
    }
  }
  
  debugLog(settings, 'Excluded nodes and descendants:', toHide.size, 'nodes');
  
  // Third pass: include ancestors of direct matches to ensure tree connectivity
  const toShow = new Set<string>();
  for (const matchId of directMatches) {
    if (!toHide.has(matchId)) {
      // Add this node and all its ancestors
      let currentId: string | null = matchId;
      while (currentId) {
        if (!toHide.has(currentId)) {
          toShow.add(currentId);
    }
        currentId = state.nodes[currentId]?.parentId || null;
      }
    }
  }
  
  debugLog(settings, 'Final filtered set:', toShow.size, 'nodes visible');
  return toShow;
}

interface NodeContext {
  app: App;
  state: NoteState;
  id: string;
  node: Node;
  deletable: boolean;
}

// Helper to copy a loom node link to clipboard
const copyNodeLink = (app: App, id: string) => {
  const file = app.workspace.getActiveFile();
  if (!file) return;
  const link = `[[${file.path}#loom=${id}]]`;
  navigator.clipboard.writeText(link);
  new Notice("Loom link copied to clipboard ✔");
};

const showNodeMenu = (
  event: MouseEvent,
  { app, state, id, node, deletable }: NodeContext
) => {
  const menu = new Menu();

  const menuItem = (name: string, icon: string, callback: () => void) =>
    menu.addItem((item) => {
      item.setTitle(name);
      item.setIcon(icon);
      item.onClick(callback);
    });

  const zeroArgMenuItem = (name: string, icon: string, event: string) =>
    menuItem(name, icon, () => app.workspace.trigger(event));
  const selfArgMenuItem = (name: string, icon: string, event: string) =>
    menuItem(name, icon, () => app.workspace.trigger(event, id));
  const selfListArgMenuItem = (name: string, icon: string, event: string) =>
    menuItem(name, icon, () => app.workspace.trigger(event, [id]));

  if (state.hoisted[state.hoisted.length - 1] === id)
    zeroArgMenuItem("Unhoist", "arrow-down", "loom:unhoist");
  else selfArgMenuItem("Hoist", "arrow-up", "loom:hoist");

  menu.addSeparator();
  QUICK_TAGS.forEach(({ tag, label, icon }) => {
    const hasTag = (node.tags || []).includes(tag);
    menuItem(
      hasTag ? `Remove ${label}` : `Add ${label}`,
      icon,
      () => app.workspace.trigger("loom:toggle-tag", { id, tag })
    );
  });

  // copy link item
  menuItem("Copy link", "link", () => copyNodeLink(app, id));

  menu.addSeparator();
  selfArgMenuItem("Create child", "plus", "loom:create-child");
  selfArgMenuItem("Create sibling", "list-plus", "loom:create-sibling");

  menu.addSeparator();
  selfArgMenuItem("Delete all children", "x", "loom:clear-children");
  selfArgMenuItem("Delete all siblings", "x-square", "loom:clear-siblings");

  if (node.parentId !== null) {
    menu.addSeparator();
    selfArgMenuItem(
      "Merge with parent",
      "arrow-up-left",
      "loom:merge-with-parent"
    );
  }

  if (deletable) {
    menu.addSeparator();
    selfListArgMenuItem("Delete", "trash", "loom:delete");
  }

  menu.showAtMouseEvent(event);
};

const renderNodeButtons = (
  container: HTMLElement,
  { app, state, id, node, deletable }: NodeContext
) => {
  const button = (
    label: string,
    icon: string,
    callback: (event: MouseEvent) => void
  ) => {
    const button_ = container.createDiv({
      cls: "loom__node-button",
      attr: { "aria-label": label },
    });
    setIcon(button_, icon);
    button_.addEventListener("click", (event) => {
      event.stopPropagation();
      callback(event);
    });
  };

  button("Show menu", "menu", (event) =>
    showNodeMenu(event, { app, state, id, node, deletable })
  );

  if (state.hoisted[state.hoisted.length - 1] === id)
    button("Unhoist", "arrow-down", () =>
      app.workspace.trigger("loom:unhoist")
    );
  else
    button("Hoist", "arrow-up", () => app.workspace.trigger("loom:hoist", id));

  // Quick tag buttons
  QUICK_TAGS.forEach(({ tag, label, icon }) => {
    const hasTag = (node.tags || []).includes(tag);
    button(
      hasTag ? `Remove ${label}` : `Add ${label}`,
      icon,
      () => app.workspace.trigger("loom:toggle-tag", { id, tag })
    );
  });

  // copy link button
  button("Copy link", "link", () => copyNodeLink(app, id));

  if (deletable)
    button("Delete", "trash", () => app.workspace.trigger("loom:delete", [id]));
};

export class LoomView extends ItemView {
  getNoteState: () => NoteState | null;
  getSettings: () => LoomSettings;

  tree: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    getNoteState: () => NoteState | null,
    getSettings: () => LoomSettings
  ) {
    super(leaf);

    this.getNoteState = getNoteState;
    this.getSettings = getSettings;
  }

  async onOpen() {
    this.render();
  }

  render() {
    const state = this.getNoteState();
    const settings = this.getSettings();

    const scroll = this.containerEl.scrollTop;

    this.containerEl.empty();
    this.containerEl.addClass("loom__view");

    this.renderNavButtons(settings);
    const container = this.containerEl.createDiv({ cls: "outline" });
    if (settings.showExport) this.renderAltExportInterface(container);
    if (settings.showSearchBar) this.renderSearchBar(container, state);
    if (settings.showSettings) this.renderSettings(container, settings, state);

    if (state === null) {
      container.createDiv({ cls: "pane-empty", text: "No note selected." });
      return;
    }
    
    this.renderTaggedNodes(container, state);
    this.tree = container.createDiv();
    this.renderTree(this.tree, state);

    this.containerEl.scrollTop = scroll;

    // scroll to active node in the tree
    const activeNode = this.tree.querySelector(".is-active");
    if (activeNode) {
      //&& !container.contains(activeNode)){
      activeNode.scrollIntoView({ block: "nearest" });
    }
  }

  renderNavButtons(settings: LoomSettings) {
    const navButtonsContainer = this.containerEl.createDiv({
      cls: "nav-buttons-container loom__nav-buttons",
    });

    // buttons to toggle 1) settings 2) node borders in the editor

    const settingNavButton = (
      setting: string,
      value: boolean,
      icon: string,
      label: string
    ) => {
      const button = navButtonsContainer.createDiv({
        cls: `clickable-icon nav-action-button${value ? " is-active" : ""}`,
        attr: { "aria-label": label },
      });
      setIcon(button, icon);
      button.addEventListener("click", () =>
        this.app.workspace.trigger("loom:set-setting", setting, !value)
      );
    };

    settingNavButton(
      "showSettings",
      settings.showSettings,
      "settings",
      "Show settings"
    );
    settingNavButton(
      "showSearchBar",
      settings.showSearchBar,
      "search",
      "Show search bar"
    );
    settingNavButton(
      "showNodeBorders",
      settings.showNodeBorders,
      "separator-vertical",
      "Show node borders in the editor"
    );

    // the import button

    const importInput = navButtonsContainer.createEl("input", {
      cls: "hidden",
      attr: { type: "file", id: "loom__import-input" },
    });

    const importNavButton = navButtonsContainer.createEl("label", {
      cls: "clickable-icon nav-action-button",
      attr: { "aria-label": "Import JSON", for: "loom__import-input" },
    });
    setIcon(importNavButton, "import");

    importInput.addEventListener("change", () => {
      // @ts-expect-error
      const path = importInput.files?.[0].path;
      if (path) this.app.workspace.trigger("loom:import", path);
    });

    // the export button

    const exportNavButton = navButtonsContainer.createDiv({
      cls: `clickable-icon nav-action-button${
        settings.showExport ? " is-active" : ""
      }`,
      attr: { "aria-label": "Export to JSON" },
    });
    setIcon(exportNavButton, "download");

    exportNavButton.addEventListener("click", (event) => {
      if (event.shiftKey) {
        this.app.workspace.trigger(
          "loom:set-setting",
          "showExport",
          !settings.showExport
        );
        return;
      }
      dialog
        .showSaveDialog({
          title: "Export to JSON",
          filters: [{ extensions: ["json"] }],
        })
        .then((result: any) => {
          if (result && result.filePath)
            this.app.workspace.trigger("loom:export", result.filePath);
        });
    });
  }

  renderAltExportInterface(container: HTMLElement) {
    const exportContainer = container.createDiv({
      cls: "loom__alt-export-field",
    });
    const exportInput = exportContainer.createEl("input", {
      attr: { type: "text", placeholder: "Path to export to (use .html for HTML export)" },
    });
    const exportButton = exportContainer.createEl("button", {});
    setIcon(exportButton, "download");

    exportButton.addEventListener("click", () => {
      if (exportInput.value)
        this.app.workspace.trigger("loom:export", exportInput.value);
    });

    // Add HTML export button
    const htmlExportButton = exportContainer.createEl("button", {
      cls: "loom__html-export-button",
      attr: { "aria-label": "Export as HTML" },
    });
    setIcon(htmlExportButton, "globe");

    htmlExportButton.addEventListener("click", () => {
      if (exportInput.value) {
        const path = exportInput.value.endsWith('.html') 
          ? exportInput.value 
          : exportInput.value + '.html';
        this.app.workspace.trigger("loom:export-html", path);
      }
    });
  }

  renderSearchBar(container: HTMLElement, state: NoteState | null) {
    const searchBar = container.createEl("input", {
      cls: "loom__search-bar",
      value: state?.searchTerm || "",
      attr: { type: "text", placeholder: "Search" },
    });
    searchBar.addEventListener("input", () => {
      const state = this.getNoteState();
      this.app.workspace.trigger("loom:search", searchBar.value);
      if (state) {
        this.renderTree(this.tree, state);
        if (
          Object.values(state.nodes).every(
            (node) => node.searchResultState === "none"
          )
        )
          searchBar.addClass("loom__search-bar-no-results");
        else searchBar.removeClass("loom__search-bar-no-results");
      }
    });
  }

  renderSettings(container: HTMLElement, settings: LoomSettings, state: NoteState | null) {
    const settingsContainer = container.createDiv({ cls: "loom__settings" });

    // visibility checkboxes

    const visibilityContainer = settingsContainer.createDiv({
      cls: "loom__visibility",
    });

    const createCheckbox = (
      id: string,
      label: string,
      ellipsis: boolean = false
    ) => {
      const checkboxContainer = visibilityContainer.createSpan({
        cls: "loom__visibility-item",
      });
      const checkbox = checkboxContainer.createEl("input", {
        attr: {
          id: `loom__${id}-checkbox`,
          checked: settings.visibility[id] ? "checked" : null,
        },
        type: "checkbox",
      });
      checkbox.addEventListener("change", () =>
        this.app.workspace.trigger(
          "loom:set-visibility-setting",
          id,
          checkbox.checked
        )
      );

      const checkboxLabel = checkboxContainer.createEl("label", {
        attr: { for: `loom__${id}-checkbox` },
        cls: "loom__visibility-item-label",
        text: label,
      });
      if (ellipsis && !settings.visibility.visibility)
        checkboxLabel.createSpan({
          cls: "loom__no-metavisibility",
          text: "...",
        });
    };

    createCheckbox("visibility", "These checkboxes", true);
    if (settings.visibility["visibility"]) {
      createCheckbox("modelPreset", "Model preset");
      createCheckbox("maxTokens", "Length");
      createCheckbox("n", "Number of completions");
      createCheckbox("bestOf", "Best of");
      createCheckbox("temperature", "Temperature");
      createCheckbox("topP", "Top p");
      createCheckbox("frequencyPenalty", "Frequency penalty");
      createCheckbox("presencePenalty", "Presence penalty");
      createCheckbox("prepend", "Prepend sequence");
      createCheckbox("systemPrompt", "System prompt");
      createCheckbox("userMessage", "User message");
      createCheckbox("steering", "Steering (probe server)");
    }

    // preset dropdown

    if (settings.visibility["modelPreset"]) {
      const presetContainer = settingsContainer.createDiv({
        cls: "loom__setting",
      });
      presetContainer.createEl("label", { text: "Model preset" });
      const presetDropdown = presetContainer.createEl("select");

      if (settings.modelPresets.length === 0)
        presetDropdown
          .createEl("option")
          .createEl("i", {
            text: "[You have no presets. Go to Settings → Loom.]",
          });
      else {
        for (const i in settings.modelPresets) {
          const preset = settings.modelPresets[i];
          presetDropdown.createEl("option", {
            text: preset.name,
            attr: {
              selected: settings.modelPreset === parseInt(i) ? "" : null,
              value: i,
            },
          });
        }

        presetDropdown.addEventListener("change", () =>
          this.app.workspace.trigger(
            "loom:set-setting",
            "modelPreset",
            parseInt(presetDropdown.value)
          )
        );
      }
    }

    // other settings

    const setting = (
      label: string,
      setting: string,
      value: string,
      type: "string" | "int" | "int?" | "float"
    ) => {
      if (!settings.visibility[setting]) return;

      const parsers = {
        string: (value: string) => value,
        int: (value: string) => parseInt(value),
        "int?": (value: string) => (value === "" ? 0 : parseInt(value)),
        float: (value: string) => parseFloat(value),
      };

      const settingContainer = settingsContainer.createDiv({
        cls: "loom__setting",
      });
      settingContainer.createEl("label", { text: label });
      const settingInput = settingContainer.createEl("input", {
        type: type === "string" ? "text" : "number",
        value,
      });
      settingInput.addEventListener("blur", () =>
        this.app.workspace.trigger(
          "loom:set-setting",
          setting,
          parsers[type](settingInput.value)
        )
      );
    };

    setting(
      "Length (in tokens)",
      "maxTokens",
      String(settings.maxTokens),
      "int"
    );
    setting("Number of completions", "n", String(settings.n), "int");
    setting(
      "Best of",
      "bestOf",
      settings.bestOf === 0 ? "" : String(settings.bestOf),
      "int?"
    );
    setting(
      "Temperature",
      "temperature",
      String(settings.temperature),
      "float"
    );
    setting("Top p", "topP", String(settings.topP), "float");
    setting(
      "Frequency penalty",
      "frequencyPenalty",
      String(settings.frequencyPenalty),
      "float"
    );
    setting(
      "Presence penalty",
      "presencePenalty",
      String(settings.presencePenalty),
      "float"
    );
    setting("Prepend sequence", "prepend", settings.prepend, "string");
    setting("System prompt", "systemPrompt", settings.systemPrompt, "string");
    setting("User message", "userMessage", settings.userMessage, "string");

    if (settings.visibility["steering"]) {
      this.renderSteering(settingsContainer, settings);
    }

    // Tag filter
    const filterContainer = settingsContainer.createDiv({
      cls: "loom__setting",
    });
    filterContainer.createEl("label", { text: "Tag filter" });
    const filterInput = filterContainer.createEl("input", {
      type: "text",
      value: state?.filter || "",
      placeholder: "+to_continue -private fav"
    });
    filterInput.addEventListener("input", () => {
      this.app.workspace.trigger("loom:set-filter", filterInput.value);
    });
  }

  renderSteering(container: HTMLElement, settings: LoomSettings) {
    const preset = getPreset(settings);
    const isProbePreset = !!(preset && preset.provider === "probe");
    // @ts-expect-error — url only on probe / openai-compat presets
    const presetUrl: string = (preset && preset.url) || "";

    const normalizedUrl = presetUrl
      .replace(/^(?!https?:\/\/)/, "http://")
      .replace(/\/+$/, "");
    const probeConfig = settings.probeConfigs[normalizedUrl];

    const steeringContainer = container.createDiv({
      cls: "loom__steering",
    });
    steeringContainer.createEl("h4", { text: "Steering" });

    if (!isProbePreset) {
      steeringContainer.createEl("p", {
        cls: "loom__steering-hint",
        text: "Select a probe-server preset to enable steering.",
      });
      return;
    }

    // Probe-document readout buttons
    const probeButtons = steeringContainer.createDiv({
      cls: "loom__steering-buttons",
    });
    const probeBtn = probeButtons.createEl("button", {
      text: "Probe document",
      cls: "mod-cta",
    });
    probeBtn.addEventListener("click", () =>
      this.app.workspace.trigger("loom:probe-doc")
    );
    const clearBtn = probeButtons.createEl("button", { text: "Clear readout" });
    clearBtn.addEventListener("click", () =>
      this.app.workspace.trigger("loom:probe-clear")
    );

    const typeRow = steeringContainer.createDiv({ cls: "loom__setting" });
    typeRow.createEl("label", { text: "Intervention" });
    const typeSelect = typeRow.createEl("select");
    const interventionTypes = probeConfig?.intervention_types?.length
      ? probeConfig.intervention_types
      : ["none", "steer", "floor", "ceil"];
    for (const t of interventionTypes) {
      typeSelect.createEl("option", {
        text: t,
        attr: { value: t, selected: settings.steeringType === t ? "" : null },
      });
    }
    typeSelect.addEventListener("change", () =>
      this.app.workspace.trigger(
        "loom:set-setting",
        "steeringType",
        typeSelect.value
      )
    );

    if (settings.steeringType === "none") return;

    if (!probeConfig) {
      steeringContainer.createEl("p", {
        cls: "loom__steering-hint",
        text: "No probe config loaded. Click \"Refresh probes\" in Settings → Loom.",
      });
      return;
    }

    const probeRow = steeringContainer.createDiv({ cls: "loom__setting" });
    probeRow.createEl("label", { text: "Probe set" });
    const probeSelect = probeRow.createEl("select");
    for (const p of probeConfig.probes) {
      probeSelect.createEl("option", {
        text: `${p.name} (layer ${p.layer}, ${p.labels.length})`,
        attr: {
          value: p.name,
          selected: settings.steeringProbe === p.name ? "" : null,
        },
      });
    }
    probeSelect.addEventListener("change", () => {
      this.app.workspace.trigger(
        "loom:set-setting",
        "steeringProbe",
        probeSelect.value
      );
      this.app.workspace.trigger("loom:set-setting", "steeringProbeIndex", 0);
    });

    const activeProbe = probeConfig.probes.find(
      (p) => p.name === settings.steeringProbe
    );
    if (activeProbe && activeProbe.labels.length > 0) {
      const labelRow = steeringContainer.createDiv({ cls: "loom__setting" });
      labelRow.createEl("label", { text: "Label" });
      const labelSelect = labelRow.createEl("select");
      activeProbe.labels.forEach((label, idx) => {
        labelSelect.createEl("option", {
          text: `${idx}: ${label}`,
          attr: {
            value: String(idx),
            selected: settings.steeringProbeIndex === idx ? "" : null,
          },
        });
      });
      labelSelect.addEventListener("change", () =>
        this.app.workspace.trigger(
          "loom:set-setting",
          "steeringProbeIndex",
          parseInt(labelSelect.value)
        )
      );
    }

    const strengthRow = steeringContainer.createDiv({ cls: "loom__setting" });
    strengthRow.createEl("label", { text: "Strength" });
    const strengthInput = strengthRow.createEl("input", {
      type: "number",
      value: String(settings.steeringStrength),
      attr: { step: "0.5" },
    });
    strengthInput.addEventListener("blur", () =>
      this.app.workspace.trigger(
        "loom:set-setting",
        "steeringStrength",
        parseFloat(strengthInput.value) || 0
      )
    );

    const renormRow = steeringContainer.createDiv({ cls: "loom__setting" });
    const renormCheckbox = renormRow.createEl("input", {
      type: "checkbox",
      attr: {
        id: "loom__steering-renorm",
        checked: settings.steeringRenorm ? "checked" : null,
      },
    });
    renormRow.createEl("label", {
      text: "Renorm (preserve activation norm)",
      attr: { for: "loom__steering-renorm" },
    });
    renormCheckbox.addEventListener("change", () =>
      this.app.workspace.trigger(
        "loom:set-setting",
        "steeringRenorm",
        renormCheckbox.checked
      )
    );
  }

  renderTaggedNodes(container: HTMLElement, state: NoteState) {
    const favorites = Object.entries(state.nodes).filter(
      ([, node]) => (node.tags || []).includes('fav')
    );

    const favoritesContainer = container.createDiv({ cls: "loom__favorites" });

    const favoritesHeader = favoritesContainer.createDiv({
      cls: "tree-item-self is-clickable loom__tree-header",
    });
    favoritesHeader.createSpan({
      cls: "tree-item-inner loom__tree-header-text",
      text: "Favorites",
    });
    favoritesHeader.createSpan({
      cls: "tree-item-flair-outer loom__favorites-count",
      text: String(favorites.length),
    });

    for (const [id] of favorites)
      this.renderNode(favoritesContainer, state, id, false, null);
  }

  renderTree(container: HTMLElement, state: NoteState) {
    container.empty();

    // Build filtered node set if filter is active
    let filteredNodes: Set<string> | null = null;
    if (state.filter) {
      const { include, exclude } = parseFilter(state.filter);
      if (include.length > 0 || exclude.length > 0) {
        filteredNodes = buildFilteredNodeSet(state, include, exclude, this.getSettings());
      }
    }

    const treeHeader = container.createDiv({
      cls: "tree-item-self loom__tree-header",
    });
    let headerText;
    if (state.searchTerm) {
      if (state.hoisted.length > 0)
        headerText = "Search results under hoisted node";
      else headerText = "Search results";
    } else if (state.filter) {
      const { include, exclude } = parseFilter(state.filter);
      if (include.length > 0 || exclude.length > 0) {
        headerText = `Filtered nodes (${state.filter})`;
      } else if (state.hoisted.length > 0) {
        headerText = "Hoisted node";
      } else {
        headerText = "All nodes";
      }
    } else if (state.hoisted.length > 0) headerText = "Hoisted node";
    else headerText = "All nodes";
    treeHeader.createSpan({
      cls: "tree-item-inner loom__tree-header-text",
      text: headerText,
    });

    if (state.hoisted.length > 0)
      this.renderNode(
        container,
        state,
        state.hoisted[state.hoisted.length - 1],
        true,
        filteredNodes
      );
    else {
      const rootIds = Object.entries(state.nodes)
        .filter(([, node]) => node.parentId === null)
        .map(([id]) => id);
      for (const rootId of rootIds)
        this.renderNode(container, state, rootId, true, filteredNodes);
    }
  }

  renderNode(
    container: HTMLElement,
    state: NoteState,
    id: string,
    inTree: boolean,
    filteredNodes: Set<string> | null = null
  ) {
    const node = state.nodes[id];

    if (inTree && node.searchResultState === "none") return;

    // Apply tag filter
    if (inTree && filteredNodes && !filteredNodes.has(id)) {
      return;
    }

    const branchContainer = container.createDiv({});

    const nodeContainer = branchContainer.createDiv({
      cls: "is-clickable outgoing-link-item tree-item-self loom__node",
      attr: { id: inTree ? `loom__node-${id}` : null },
    });
    if (id === state.current) nodeContainer.addClass("is-active");
    if (node.searchResultState === "result")
      nodeContainer.addClass("loom__node-search-result");
    if (node.unread) nodeContainer.addClass("loom__node-unread");

    const children = Object.entries(state.nodes)
      .filter(([, node]) => node.parentId === id)
      .map(([id]) => id);

    // if the node has children, add an expand/collapse button

    if (inTree && children.length > 0) {
      const collapseButton = nodeContainer.createDiv({
        cls: "collapse-icon loom__collapse-button",
      });
      if (node.collapsed) collapseButton.addClass("loom__is-collapsed");
      setIcon(collapseButton, "right-triangle");

      collapseButton.addEventListener("click", () =>
        this.app.workspace.trigger("loom:toggle-collapse", id)
      );
    }

    // Add quick tag icons (only for active tags) - using exact same pattern as buttons
    const activeTags = QUICK_TAGS.filter(({ tag }) => 
      (node.tags || []).includes(tag)
    );

    activeTags.forEach(({ tag, emoji }) => {
      const tagIcon = nodeContainer.createDiv({
        cls: 'loom__node-tag-icon',
        attr: { 'aria-label': tag },
        text: emoji
      });
      
      tagIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        this.app.workspace.trigger('loom:toggle-tag', { id, tag });
      });
    });

    // if the node is unread, add an unread indicator

    if (node.unread)
      nodeContainer.createDiv({ cls: "loom__node-unread-indicator" });

    // add the node's text

    const nodeText = nodeContainer.createEl(node.text.trim() ? "span" : "em", {

      cls: "tree-item-inner loom__node-text",
      text: node.text.trim() || "No text",
    });
    nodeText.addEventListener("click", () =>
      this.app.workspace.trigger("loom:switch-to", id)
    );

    const rootNodes = Object.entries(state.nodes).filter(
      ([, node]) => node.parentId === null
    );
    const deletable = rootNodes.length !== 1 || rootNodes[0][0] !== id;

    const nodeContext: NodeContext = {
      app: this.app,
      state,
      id,
      node,
      deletable,
    };

    nodeContainer.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showNodeMenu(event, nodeContext);
    });

    // add buttons on hover

    const nodeButtonsContainer = nodeContainer.createDiv({
      cls: "loom__node-buttons",
    });

    renderNodeButtons(nodeButtonsContainer, nodeContext);

    // indicate if loom is currently generating children for this node

    if (inTree && state.generating === id) {
      const generatingContainer = branchContainer.createDiv({
        cls: "loom__node-footer",
      });
      const generatingIcon = generatingContainer.createDiv({
        cls: "loom__node-generating-icon",
      });
      setIcon(generatingIcon, "loader-2");
      generatingContainer.createSpan({
        cls: "loom__node-footer-text",
        text: "Generating...",
      });
    }

    // if in a tree, and if the node isn't collapsed, render its children

    if (!inTree || node.collapsed) return;

    if (branchContainer.offsetWidth < 150) {
      if (children.length > 0) {
        const showMore = branchContainer.createDiv({
          cls: "loom__node-footer loom__node-show-more",
        });
        setIcon(showMore, "arrow-up");
        showMore.createSpan({
          cls: "loom__node-footer-text",
          text: "Show more...",
        });

        showMore.addEventListener("click", () =>
          this.app.workspace.trigger("loom:hoist", id)
        );
      }

      return;
    }

    const childrenContainer = branchContainer.createDiv({
      cls: "loom__node-children",
    });
    for (const childId of children)
      this.renderNode(childrenContainer, state, childId, true, filteredNodes);
  }

  getViewType(): string {
    return "loom";
  }

  getDisplayText(): string {
    return "Loom";
  }

  getIcon(): string {
    return "network";
  }
}

export class LoomSiblingsView extends ItemView {
  getNoteState: () => NoteState | null;

  constructor(leaf: WorkspaceLeaf, getNoteState: () => NoteState | null) {
    super(leaf);
    this.getNoteState = getNoteState;
    this.render();
  }

  render() {
    const scroll = this.containerEl.scrollTop;

    this.containerEl.empty();
    this.containerEl.addClass("loom__view");
    const container = this.containerEl.createDiv({ cls: "outline" });

    const state = this.getNoteState();

    if (state === null) {
      container.createDiv({
        cls: "pane-empty",
        text: "No note selected.",
      });
      return;
    }

    const parentId = state.nodes[state.current].parentId;
    const siblings = Object.entries(state.nodes).filter(
      ([, node]) => node.parentId === parentId
    );

    let currentNodeContainer = null;
    for (const i in siblings) {
      const [id, node] = siblings[i];

      const nodeContainer = container.createDiv({
        cls: `loom__sibling${id === state.current ? " is-active" : ""}`,
      });
      if (parentId !== null)
        nodeContainer.createSpan({
          text: "…",
          cls: "loom__sibling-ellipsis",
        });
      nodeContainer.createSpan({ text: node.text.trim() });
      nodeContainer.addEventListener("click", () =>
        this.app.workspace.trigger("loom:switch-to", id)
      );

      const rootNodes = Object.entries(state.nodes).filter(
        ([, node]) => node.parentId === null
      );
      const deletable = rootNodes.length !== 1 || rootNodes[0][0] !== id;

      const nodeContext: NodeContext = {
        app: this.app,
        state,
        id,
        node,
        deletable,
      };

      const nodeButtonsContainer = nodeContainer.createDiv({
        cls: "loom__sibling-buttons",
      });
      renderNodeButtons(nodeButtonsContainer, nodeContext);

      nodeContainer.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showNodeMenu(event, nodeContext);
      });

      if (parseInt(i) !== siblings.length - 1)
        container.createEl("hr", { cls: "loom__sibling-separator" });

      if (id === state.current) currentNodeContainer = nodeContainer;
    }

    this.containerEl.scrollTop = scroll;

    if (currentNodeContainer !== null)
      currentNodeContainer.scrollIntoView({ block: "nearest" });
  }

  getViewType(): string {
    return "loom-siblings";
  }

  getDisplayText(): string {
    return "Siblings";
  }

  getIcon(): string {
    return "layout-list";
  }
}

export interface LoomEditorPluginState {
  ancestorLengths: [string, number][];
  showNodeBorders: boolean;
}

export class LoomEditorPlugin implements PluginValue {
  decorations: DecorationSet;
  state: LoomEditorPluginState;

  constructor() {
    this.decorations = Decoration.none;
    this.state = { ancestorLengths: [], showNodeBorders: false };
  }

  update() {
    let decorations: Range<Decoration>[] = [];

    const addRange = (from: number, to: number, id: string) => {
      try {
        const range = Decoration.mark({
          class: `loom__editor-node loom__editor-node-${id}`,
        }).range(from, to);
        decorations.push(range);
      } catch (e) {
        // this happens if the range is empty. it's ok. it's fine,
      }
    };

    const addBorder = (at: number) => {
      const range = Decoration.widget({
        widget: new LoomNodeBorderWidget(),
        side: -1,
      }).range(at, at);
      decorations.push(range);
    };

    let i = 0;
    for (const [id, length] of this.state.ancestorLengths) {
      addRange(i, i + length, id);
      i += length;
      if (this.state.showNodeBorders) addBorder(i);
    }

    this.decorations = Decoration.set(decorations);
  }
}

class LoomNodeBorderWidget extends WidgetType {
  toDOM() {
    const el = document.createElement("span");
    el.classList.add("loom__editor-node-border");
    return el;
  }

  eq() {
    return true;
  }
}

export interface ProbeReadout {
  tokens: string[];
  projections: number[][]; // (n_tokens, n_probes)
  labels: string[];
  probeName: string;
  /** index of the user-selected probe label (always shown first in tooltip) */
  selectedIndex?: number;
}

export interface LoomProbeEditorPluginState {
  readout: ProbeReadout | null;
  /** per-editor-offset token index (lookup for hover) */
  ranges: Array<{ from: number; to: number; tokenIdx: number }>;
}

interface TooltipRow {
  label: string;
  value: number;
  selected?: boolean;
  separator?: boolean;
}

function buildTooltipRows(
  projections: number[],
  labels: string[],
  selectedIndex: number | undefined,
  k: number
): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (
    selectedIndex !== undefined &&
    selectedIndex >= 0 &&
    selectedIndex < projections.length
  ) {
    rows.push({
      label: labels[selectedIndex] || String(selectedIndex),
      value: projections[selectedIndex],
      selected: true,
    });
    rows.push({ label: "", value: 0, separator: true });
  }
  const indexed = projections
    .map((v, i) => ({ label: labels[i] || String(i), value: v, idx: i }))
    .filter((r) => r.idx !== selectedIndex);
  // Descending by signed value: top k positive
  const topK = [...indexed].sort((a, b) => b.value - a.value).slice(0, k);
  // Pick the k most negative, then display them high→low (least negative first)
  const botK = [...indexed]
    .sort((a, b) => a.value - b.value)
    .slice(0, k)
    .reverse();
  for (const r of topK) rows.push({ label: r.label, value: r.value });
  if (botK.length > 0) rows.push({ label: "", value: 0, separator: true });
  for (const r of botK) rows.push({ label: r.label, value: r.value });
  return rows;
}

function alignTokens(
  text: string,
  tokens: string[]
): Array<{ from: number; to: number; tokenIdx: number }> {
  const ranges: Array<{ from: number; to: number; tokenIdx: number }> = [];
  let pos = 0;
  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i];
    // Normalize common BPE space markers to ASCII space
    const candidates = [
      rawTok,
      rawTok.replace(/^\u2581/, " "), // SentencePiece ▁
      rawTok.replace(/^\u0120/, " "), // GPT-2 BPE Ġ
      rawTok.replace(/\u010A/g, "\n"), // GPT-2 BPE Ċ (newline)
    ];
    let matched = false;
    for (const cand of candidates) {
      if (cand.length > 0 && text.slice(pos, pos + cand.length) === cand) {
        ranges.push({ from: pos, to: pos + cand.length, tokenIdx: i });
        pos += cand.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Special / control token (e.g. BOS, chat template markup) — skip without advancing
    }
  }
  return ranges;
}

let probeTooltipEl: HTMLElement | null = null;
function ensureProbeTooltip(): HTMLElement {
  if (probeTooltipEl) return probeTooltipEl;
  probeTooltipEl = document.createElement("div");
  probeTooltipEl.className = "loom__probe-tooltip";
  probeTooltipEl.style.display = "none";
  document.body.appendChild(probeTooltipEl);
  return probeTooltipEl;
}
function hideProbeTooltip() {
  if (probeTooltipEl) probeTooltipEl.style.display = "none";
}

// Effect: set the probe readout (null clears). Stored in a StateField for CM6-idiomatic updates.
export const setProbeReadoutEffect = StateEffect.define<ProbeReadout | null>();

interface ProbeFieldValue {
  readout: ProbeReadout | null;
  decorations: DecorationSet;
  ranges: Array<{ from: number; to: number; tokenIdx: number }>;
}

function buildDecorations(
  docLen: number,
  ranges: Array<{ from: number; to: number; tokenIdx: number }>
): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const r of ranges) {
    if (r.from >= r.to || r.to > docLen) continue;
    decos.push(
      Decoration.mark({
        class: "loom__probe-token",
        attributes: { "data-probe-token": String(r.tokenIdx) },
      }).range(r.from, r.to)
    );
  }
  return Decoration.set(decos, true);
}

export const probeReadoutField = StateField.define<ProbeFieldValue>({
  create: () => ({ readout: null, decorations: Decoration.none, ranges: [] }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setProbeReadoutEffect)) {
        const readout = e.value;
        if (!readout) {
          next = { readout: null, decorations: Decoration.none, ranges: [] };
        } else {
          const text = tr.state.doc.toString();
          const ranges = alignTokens(text, readout.tokens);
          console.log(
            `[loom probe] ${readout.tokens.length} tokens → ${ranges.length} aligned (doc=${text.length} chars)`,
            {
              firstTokens: readout.tokens.slice(0, 10),
              firstRanges: ranges.slice(0, 10),
            }
          );
          next = {
            readout,
            ranges,
            decorations: buildDecorations(tr.state.doc.length, ranges),
          };
        }
      }
    }
    if (next === value && tr.docChanged) {
      next = {
        ...value,
        decorations: value.decorations.map(tr.changes),
      };
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

const probeTooltipDomHandlers = EditorView.domEventHandlers({
  mouseover(event, view) {
    const target = event.target as HTMLElement;
    if (!target.classList || !target.classList.contains("loom__probe-token")) return false;
    const idxStr = target.getAttribute("data-probe-token");
    if (!idxStr) return false;
    const fieldVal = view.state.field(probeReadoutField, false);
    if (!fieldVal?.readout) return false;
    const tokenIdx = parseInt(idxStr);
    const projections = fieldVal.readout.projections[tokenIdx] || [];
    const rows = buildTooltipRows(
      projections,
      fieldVal.readout.labels,
      fieldVal.readout.selectedIndex,
      5
    );

    const tip = ensureProbeTooltip();
    tip.innerHTML = "";
    const header = document.createElement("div");
    header.className = "loom__probe-tooltip-header";
    header.textContent = `${fieldVal.readout.probeName} · "${fieldVal.readout.tokens[tokenIdx]}"`;
    tip.appendChild(header);
    const list = document.createElement("div");
    list.className = "loom__probe-tooltip-list";
    for (const r of rows) {
      if (r.separator) {
        const sep = document.createElement("div");
        sep.className = "loom__probe-tooltip-separator";
        list.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className =
        "loom__probe-tooltip-row" + (r.selected ? " loom__probe-tooltip-row-selected" : "");
      const lab = document.createElement("span");
      lab.className = "loom__probe-tooltip-label";
      lab.textContent = r.label;
      const val = document.createElement("span");
      val.className = "loom__probe-tooltip-value";
      val.textContent = r.value.toFixed(2);
      val.style.color = r.value >= 0 ? "var(--color-green)" : "var(--color-red)";
      row.appendChild(lab);
      row.appendChild(val);
      list.appendChild(row);
    }
    tip.appendChild(list);

    const rect = target.getBoundingClientRect();
    tip.style.display = "block";
    tip.style.left = `${rect.left + window.scrollX}px`;
    tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
    return false;
  },
  mouseout(event, _view) {
    const target = event.target as HTMLElement;
    if (!target.classList || !target.classList.contains("loom__probe-token")) return false;
    hideProbeTooltip();
    return false;
  },
});

export const probeReadoutExtension: Extension = [probeReadoutField, probeTooltipDomHandlers];

export const loomEditorPluginSpec: PluginSpec<LoomEditorPlugin> = {
  decorations: (plugin: LoomEditorPlugin) => plugin.decorations,
  eventHandlers: {
    mouseover: (event: MouseEvent, _view: EditorView) => {
      if (event.button !== 0) return false;

      const target = event.target as HTMLElement;
      if (!target.classList.contains("loom__editor-node")) return false;

      const className = target.classList[target.classList.length - 1];
      for (const el of [].slice.call(
        document.getElementsByClassName(className)
      ))
        el.classList.add("loom__editor-node-hover");

      return true;
    },
    mouseout: (event: MouseEvent, _view: EditorView) => {
      if (event.button !== 0) return false;

      const target = event.target as HTMLElement;
      if (!target.classList.contains("loom__editor-node")) return false;

      const className = target.classList[target.classList.length - 1];
      for (const el of [].slice.call(
        document.getElementsByClassName(className)
      ))
        el.classList.remove("loom__editor-node-hover");

      return true;
    },
    mousedown: (event: MouseEvent, _view: EditorView) => {
      if (event.button !== 0 || !event.shiftKey) return false;

      const target = event.target as HTMLElement;
      if (!target.classList.contains("loom__editor-node")) return false;

      // the second last element, since the last is `loom__editor-node-hover`
      const className = target.classList[target.classList.length - 2];
      const id = className.split("-").slice(2).join("-");
      // app.workspace.trigger("loom:switch-to", id); FIXME :3

      return true;
    },
  },
};

export class MakePromptFromPassagesModal extends Modal {
  getSettings: () => LoomSettings;

  constructor(app: App, getSettings: () => LoomSettings) {
    super(app);
    this.getSettings = getSettings;
  }

  onOpen() {
    this.contentEl.createDiv({
      cls: "modal-title",
      text: "Make prompt from passages",
    });

    const pathPrefix = this.getSettings()
      .passageFolder.trim()
      .replace(/\/?$/, "/");
    const passages = this.app.vault
      .getFiles()
      .filter(
        (file) => file.path.startsWith(pathPrefix) && file.extension === "md"
      )
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    let selectedPassages: string[] = [];

    const unselectedContainer = this.contentEl.createDiv({
      cls: "loom__passage-list",
    });
    this.contentEl.createDiv({
      cls: "loom__selected-passages-title",
      text: "Selected passages",
    });
    const selectedContainer = this.contentEl.createDiv({
      cls: "loom__passage-list loom__selected-passage-list",
    });
    let button: HTMLElement;

    const cleanName = (name: string) => name.slice(pathPrefix.length, -3);

    const renderPassageList = () => {
      unselectedContainer.empty();
      selectedContainer.empty();

      const unselectedPassages = passages.filter(
        (passage) => !selectedPassages.includes(passage.path)
      );

      for (const passage of unselectedPassages) {
        const passageContainer = unselectedContainer.createDiv({
          cls: "tree-item-self loom__passage",
        });
        passageContainer.createSpan({
          cls: "tree-item-inner",
          text: cleanName(passage.path),
        });
        passageContainer.addEventListener("click", () => {
          selectedPassages.push(passage.path);
          renderPassageList();
        });
      }

      if (selectedPassages.length === 0) {
        selectedContainer.createDiv({
          cls: "loom__no-passages-selected",
          text: "No passages selected.",
        });
      }
      for (const passage of selectedPassages) {
        const passageContainer = selectedContainer.createDiv({
          cls: "tree-item-self loom__passage",
        });
        passageContainer.createSpan({
          cls: "tree-item-inner",
          text: cleanName(passage),
        });
        passageContainer.addEventListener("click", () => {
          selectedPassages = selectedPassages.filter((p) => p !== passage);
          renderPassageList();
        });
      }
    };

    let separator = this.getSettings().defaultPassageSeparator;
    let passageFrontmatter = this.getSettings().defaultPassageFrontmatter;

    new Setting(this.contentEl)
      .setName("Separator")
      .setDesc("Use \\n to denote a newline.")
      .addText((text) =>
        text.setValue(separator).onChange((value) => (separator = value))
      );
    new Setting(this.contentEl)
      .setName("Passage frontmatter")
      .setDesc(
        "This will be added before each passage and at the end. %n: 1, 2, 3..., %r: I, II, III..."
      )
      .addText((text) =>
        text
          .setValue(passageFrontmatter)
          .onChange((value) => (passageFrontmatter = value))
      );

    const buttonContainer = this.contentEl.createDiv({
      cls: "modal-button-container",
    });
    button = buttonContainer.createEl("button", {
      cls: "mod-cta",
      text: "Submit",
    });
    button.addEventListener("click", () => {
      if (selectedPassages.length === 0) return;

      this.app.workspace.trigger(
        "loom:make-prompt-from-passages",
        selectedPassages,
        separator,
        passageFrontmatter
      );
      this.close();
    });

    renderPassageList();
  }

  onClose() {
    this.contentEl.empty();
  }
}

