import { registerWorkbenchAddon } from "/addon-runtime.js";

registerWorkbenchAddon({
  id: "artifacts",
  async mount(container, host) {
    container.innerHTML = `
      <div class="artifact-toolbar">
        <div><strong>CAS artifacts</strong><span id="artifact-count" class="muted"></span></div>
        <button id="refresh-artifacts" class="secondary-command" type="button">Refresh</button>
      </div>
      <div id="artifact-status" class="analysis-status"></div>
      <div id="artifact-gallery" class="artifact-gallery"></div>`;
    let loaded = false;

    const renderArtifact = (artifact) => {
      const card = host.node("article", "artifact-card");
      const heading = host.node("div", "artifact-heading");
      heading.append(host.node("h2", null, artifact.semanticRole), host.node("span", "artifact-media", artifact.mediaType));
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
      const details = host.node("details", "artifact-json");
      details.append(host.node("summary", null, "Metadata"), host.node("pre", null, JSON.stringify(artifact.attrs, null, 2)));
      actions.append(details);
      card.append(actions);
      return card;
    };

    const refresh = async () => {
      const status = container.querySelector("#artifact-status");
      const gallery = container.querySelector("#artifact-gallery");
      status.textContent = "Loading";
      try {
        const result = await host.request("/v1/artifacts?limit=200");
        const unique = [...new Map(result.artifacts.map((artifact) => [artifact.casUri, artifact])).values()];
        gallery.replaceChildren(...unique.map(renderArtifact));
        if (!unique.length) gallery.append(host.node("p", "muted artifact-empty", "No CAS-backed artifacts are recorded yet."));
        container.querySelector("#artifact-count").textContent = ` · ${unique.length}`;
        status.textContent = unique.length ? "Current ledger projection" : "No artifacts";
        loaded = true;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    container.querySelector("#refresh-artifacts").addEventListener("click", () => { void refresh(); });
    return { activate: () => { if (!loaded) void refresh(); } };
  },
});
