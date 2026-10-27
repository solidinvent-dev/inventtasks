import { App, SuggestModal } from "obsidian";
import { t } from "../i18n";

/**
 * Picks one synced file path (manifest keys) to open its version history.
 * Built on SuggestModal for free fuzzy filtering + keyboard navigation.
 */
export class SyncPathPickerModal extends SuggestModal<string> {
  constructor(app: App, private readonly paths: string[], private readonly onPick: (path: string) => void) {
    super(app);
    this.setPlaceholder(t("syncHistory.pickPath"));
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase().trim();
    const matches = q ? this.paths.filter((p) => p.toLowerCase().includes(q)) : this.paths;
    return matches.slice(0, 200);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    const slash = path.lastIndexOf("/");
    el.createDiv({ cls: "it-suggest-title", text: slash >= 0 ? path.slice(slash + 1) : path });
    if (slash >= 0) el.createDiv({ cls: "it-suggest-sub", text: path.slice(0, slash) });
  }

  onChooseSuggestion(path: string): void {
    this.onPick(path);
  }
}
