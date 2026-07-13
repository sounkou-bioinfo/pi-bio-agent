import { registerWorkbenchAddon } from "/addon-runtime.js";

registerWorkbenchAddon({
  id: "artifacts",
  async mount(container, host) {
    container.innerHTML = `
      <div class="artifact-toolbar">
        <div><strong>CAS artifacts</strong><span id="artifact-count" class="muted"></span><span id="artifact-context" class="muted"></span></div>
        <div class="artifact-toolbar-actions"><button id="clear-artifact-selection" class="text-command" type="button" hidden>Show all</button><button id="refresh-artifacts" class="secondary-command" type="button">Refresh</button></div>
      </div>
      <div id="artifact-status" class="analysis-status"></div>
      <div id="artifact-gallery" class="artifact-gallery"></div>`;
    let loaded = false;
    let artifacts = [];
    let selection = host.getWorkspaceSelection();

    const relevantArtifact = (artifact) => {
      if (!selection) return true;
      const sourceNodes = new Set([
        `analysis:${selection.analysisId}`,
        selection.groundingId,
        selection.packetUri,
        ...selection.runIds.flatMap((runId) => [runId, `run:${runId}`]),
      ].filter(Boolean));
      return sourceNodes.has(artifact.sourceNode)
        || artifact.casUri === selection.packetUri
        || artifact.attrs?.analysis_id === selection.analysisId;
    };

    const renderArtifact = (artifact) => {
      const card = host.node("article", "artifact-card");
      const heading = host.node("div", "artifact-heading");
      const caption = typeof artifact.attrs?.caption === "string" ? artifact.attrs.caption : artifact.semanticRole;
      heading.append(host.node("h2", null, caption), host.node("span", "artifact-media", `${artifact.semanticRole} · ${artifact.mediaType}`));
      card.append(heading);
      if (artifact.mediaType.startsWith("image/")) {
        const image = host.node("img", "artifact-image");
        image.src = artifact.contentUrl;
        image.alt = `${artifact.semanticRole} from ${artifact.sourceNode}`;
        image.loading = "lazy";
        card.append(image);
      } else if (artifact.mediaType === "text/html") {
        const frame = host.node("iframe", "artifact-frame");
        frame.src = artifact.contentUrl;
        frame.title = `${artifact.semanticRole} preview`;
        frame.setAttribute("sandbox", "");
        card.append(frame);
      }
      const facts = host.node("dl", "artifact-facts");
      for (const [label, value] of [
        ["Source", artifact.sourceNode],
        ["Relation", artifact.relation],
        ["Digest", artifact.digest],
        ["Bytes", artifact.sizeBytes],
      ]) facts.append(host.node("dt", null, label), host.node("dd", null, String(value)));
      card.append(facts);
      const actions = host.node("div", "artifact-actions");
      const open = host.node("a", "secondary-command", "Open");
      open.href = artifact.contentUrl;
      open.target = "_blank";
      open.rel = "noopener";
      actions.append(open);
      const inspect = host.node("button", "text-command", "Inspect in Pi");
      inspect.type = "button";
      inspect.disabled = !host.getActiveSession();
      inspect.addEventListener("click", () => {
        host.setAgentDraft(`Inspect CAS artifact ${artifact.digest} from ${artifact.sourceNode}. Semantic role: ${artifact.semanticRole}. Start from the ledger reference and provenance; do not infer artifact meaning from this message alone.`);
      });
      actions.append(inspect);
      const details = host.node("details", "artifact-json");
      details.append(host.node("summary", null, "Metadata"), host.node("pre", null, JSON.stringify(artifact.attrs, null, 2)));
      actions.append(details);
      card.append(actions);
      return card;
    };

    const render = () => {
      const gallery = container.querySelector("#artifact-gallery");
      const visible = artifacts.filter(relevantArtifact);
      gallery.replaceChildren(...visible.map(renderArtifact));
      if (!visible.length) gallery.append(host.node("p", "muted artifact-empty", selection ? "No CAS artifacts are linked to the selected analysis." : "No CAS-backed artifacts are recorded yet."));
      container.querySelector("#artifact-count").textContent = ` · ${visible.length}${selection ? ` of ${artifacts.length}` : ""}`;
      container.querySelector("#artifact-context").textContent = selection ? ` · ${selection.analysisId}` : "";
      container.querySelector("#clear-artifact-selection").hidden = !selection;
    };

    const refresh = async () => {
      const status = container.querySelector("#artifact-status");
      status.textContent = "Loading";
      try {
        const result = await host.request("/v1/artifacts?limit=200");
        artifacts = [...new Map(result.artifacts.map((artifact) => [artifact.casUri, artifact])).values()];
        render();
        status.textContent = artifacts.length ? "Current ledger projection" : "No artifacts";
        loaded = true;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    const unsubscribeSelection = host.onWorkspaceSelectionChange((next) => {
      selection = next;
      if (loaded) render();
    });
    const unsubscribeSession = host.onSessionChange(() => { if (loaded) render(); });

    container.querySelector("#refresh-artifacts").addEventListener("click", () => { void refresh(); });
    container.querySelector("#clear-artifact-selection").addEventListener("click", () => host.setWorkspaceSelection(null));
    return {
      activate: () => { if (!loaded) void refresh(); },
      dispose() {
        unsubscribeSelection();
        unsubscribeSession();
      },
    };
  },
});
