import { registerWorkbenchAddon } from "/addon-runtime.js";

const stateLabels = {
  needs_follow_up: "Needs follow-up",
  reanalysis_signal: "Reanalysis signal",
  evidence_conflict: "Evidence conflict",
  evidence_gap: "Evidence gap",
  review_pending: "Review pending",
  no_active_signal: "No active signal",
};

registerWorkbenchAddon({
  id: "clinical-reanalysis",
  async mount(container, host) {
    container.innerHTML = `
      <div class="reanalysis-toolbar">
        <div><strong>Reanalysis queue</strong><span id="reanalysis-count" class="muted"></span></div>
        <button id="refresh-reanalysis" class="secondary-command" type="button">Refresh</button>
      </div>
      <div id="reanalysis-status" class="analysis-status">Latest recorded analysis per case.</div>
      <div id="reanalysis-content" class="reanalysis-content"></div>`;

    let entries = [];
    let loaded = false;
    let selection = host.getWorkspaceSelection();

    const render = () => {
      const content = container.querySelector("#reanalysis-content");
      content.replaceChildren();
      container.querySelector("#reanalysis-count").textContent = entries.length ? ` · ${entries.length} cases` : "";
      if (!entries.length) {
        content.append(host.node("p", "muted reanalysis-empty", "No completed case analyses are recorded."));
        return;
      }
      const wrap = host.node("div", "table-wrap reanalysis-table-wrap");
      const table = host.node("table", "reanalysis-table");
      const head = host.node("thead");
      const header = host.node("tr");
      for (const title of ["Case", "Queue state", "Signals", "Review", "Reasons", "Analysis", ""]) header.append(host.node("th", null, title));
      head.append(header);
      const body = host.node("tbody");
      for (const entry of entries) {
        const row = host.node("tr", selection?.analysisId === entry.analysisId ? "focused" : "");
        row.append(
          host.node("td", "reanalysis-case", entry.caseId),
          host.node("td", null, stateLabels[entry.state] ?? entry.state),
          host.node("td", null, `${entry.reanalysisSignals} signals · ${entry.conflicts} conflicts · ${entry.evidenceGaps} gaps`),
          host.node("td", null, `${entry.openReviewItems} open · ${entry.needsFollowUpItems} follow-up`),
        );
        const reasons = host.node("td", "reanalysis-reasons");
        for (const reason of entry.reasons) reasons.append(host.node("div", null, reason));
        row.append(reasons, host.node("td", "reanalysis-analysis", entry.analysisId));
        const actions = host.node("td", "reanalysis-actions");
        const open = host.node("button", "secondary-command", "Open evidence");
        open.type = "button";
        open.addEventListener("click", () => {
          host.setWorkspaceSelection({
            caseId: entry.caseId,
            analysisId: entry.analysisId,
            packetUri: entry.packetUri,
            groundingId: entry.groundingId,
            runIds: entry.runIds,
          });
          host.activateView("clinical-evidence");
        });
        const inspect = host.node("button", "text-command", "Inspect in Pi");
        inspect.type = "button";
        inspect.disabled = !host.getActiveSession();
        inspect.addEventListener("click", () => {
          host.setAgentDraft(`Inspect latest recorded reanalysis state for case ${entry.caseId}. Analysis: ${entry.analysisId}. Packet: ${entry.packetUri}. Queue state: ${entry.state}. Reasons: ${entry.reasons.join(" ")} Use the ledger, evidence packet, and recorded runs for facts; do not convert this queue state into a diagnosis.`);
        });
        actions.append(open, inspect);
        row.append(actions);
        body.append(row);
      }
      table.append(head, body);
      wrap.append(table);
      content.append(wrap);
    };

    const refresh = async () => {
      const status = container.querySelector("#reanalysis-status");
      status.textContent = "Loading latest recorded analysis per case";
      try {
        const result = await host.request("/v1/clinical-reanalysis-queue?limit=100");
        entries = result.cases;
        loaded = true;
        status.textContent = entries.length ? "Current ledger projection" : "No completed analyses";
        render();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    const unsubscribeSelection = host.onWorkspaceSelectionChange((next) => {
      selection = next;
      if (loaded) render();
    });
    const unsubscribeSession = host.onSessionChange(() => { if (loaded) render(); });

    container.querySelector("#refresh-reanalysis").addEventListener("click", () => { void refresh(); });
    return {
      activate: () => { if (!loaded) void refresh(); },
      dispose() {
        unsubscribeSelection();
        unsubscribeSession();
      },
    };
  },
});
