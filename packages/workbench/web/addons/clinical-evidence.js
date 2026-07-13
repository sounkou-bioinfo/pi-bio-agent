import { registerWorkbenchAddon } from "/addon-runtime.js";

registerWorkbenchAddon({
  id: "clinical-evidence",
  async mount(container, host) {
    container.innerHTML = `
      <div class="analysis-launch">
        <form id="analysis-form" class="analysis-toolbar">
          <label for="case-id">Case</label>
          <input id="case-id" value="CASE-RD-001" autocomplete="off">
          <label class="resume-label" for="analysis-id">Resume id</label>
          <input id="analysis-id" placeholder="New analysis" autocomplete="off">
          <button id="run-analysis" class="primary-command" type="submit">Run recorded workup</button>
          <button id="refresh-history" class="secondary-command" type="button">Refresh history</button>
          <button id="ask-agent" class="secondary-command" type="button" disabled>Ask Pi</button>
        </form>
        <section class="analysis-plan" aria-labelledby="analysis-plan-title">
          <div class="analysis-plan-heading">
            <div><h2 id="analysis-plan-title">Case workspace</h2><p>Declared inputs, checkpointed analysis, evidence packet, and review state remain addressable by durable ids.</p></div>
            <dl class="analysis-inputs">
              <dt>Assembly</dt><dd>GRCh38</dd>
              <dt>Inputs</dt><dd>Declared workspace resources</dd>
              <dt>Scope</dt><dd>Evidence routing</dd>
            </dl>
          </div>
          <ol id="analysis-steps" class="analysis-steps">
            <li>Ground narrative to reviewed HPO assertions</li>
            <li>Rank phenotype-supported disease and gene hypotheses</li>
            <li>Resolve assembly-pinned candidate intervals</li>
            <li>Search indexed VCF regions and record coverage</li>
            <li>Annotate selected alleles through VEP</li>
            <li>Reconcile direct and inverted evidence</li>
            <li>Compare the prior assessment</li>
            <li>Commit packet, receipts, replay, and graph links</li>
          </ol>
        </section>
      </div>
      <section class="analysis-history-band" aria-labelledby="analysis-history-title">
        <div class="history-heading"><h2 id="analysis-history-title">Recorded analyses</h2><span id="history-count" class="muted"></span></div>
        <div id="analysis-history" class="analysis-history"><p class="muted">No recorded analyses loaded.</p></div>
      </section>
      <div id="analysis-status" class="analysis-status">Choose a case or resume a recorded analysis.</div>
      <div id="analysis-content" class="analysis-content"></div>`;

    let analysis = null;
    let history = [];
    let reviews = [];
    let focusedEvidence = null;
    let reviewWarning = null;

    const caseInput = container.querySelector("#case-id");
    const analysisIdInput = container.querySelector("#analysis-id");
    const askButton = container.querySelector("#ask-agent");
    const status = container.querySelector("#analysis-status");

    const updateAsk = () => { askButton.disabled = !analysis || !host.getActiveSession(); };
    const unsubscribeSession = host.onSessionChange(updateAsk);

    const metric = (label, value) => {
      const item = host.node("div", "metric");
      item.append(host.node("span", "metric-value", String(value)), host.node("span", "metric-label", label));
      return item;
    };

    const selectionFor = (value) => ({
      caseId: value.packet.caseId,
      analysisId: value.analysisId,
      packetUri: value.packetUri,
      groundingId: value.packet.grounding?.groundingId ?? null,
      runIds: value.packet.provenance?.runIds ?? [],
    });

    const formatTime = (value) => {
      if (!value) return "";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    };

    const defaultReviews = () => (analysis?.packet.summary.reviewQueue ?? []).map((item) => ({
      ...item,
      reviewId: null,
      status: "open",
      note: null,
      updatedAt: null,
    }));

    const evidenceRun = (row) => {
      if (!analysis) return null;
      return row.lane === "inverted" ? analysis.packet.lanes.inverted.runId : analysis.packet.lanes.direct.runId;
    };

    const setSelection = () => {
      if (analysis) host.setWorkspaceSelection(selectionFor(analysis));
    };

    const renderHistory = () => {
      const historyRoot = container.querySelector("#analysis-history");
      historyRoot.replaceChildren();
      container.querySelector("#history-count").textContent = history.length ? `${history.length} recorded` : "";
      if (!history.length) {
        historyRoot.append(host.node("p", "muted", "No recorded analyses for this case."));
        return;
      }
      for (const item of history) {
        const row = host.node("button", `history-row${analysis?.analysisId === item.analysisId ? " selected" : ""}`);
        row.type = "button";
        const name = host.node("span", "history-analysis", item.analysisId);
        const facts = host.node("span", "history-facts", `${formatTime(item.recordedAt)} · ${item.reviewItems} review items · ${item.reanalysisSignals} reanalysis signals`);
        row.append(name, facts);
        row.addEventListener("click", () => { void loadAnalysis(item.analysisId); });
        historyRoot.append(row);
      }
    };

    const loadHistory = async () => {
      const caseId = caseInput.value.trim();
      if (!caseId) {
        history = [];
        renderHistory();
        return;
      }
      try {
        const result = await host.request(`/v1/clinical-analyses?caseId=${encodeURIComponent(caseId)}&limit=100`);
        history = result.analyses;
        renderHistory();
      } catch (error) {
        history = [];
        renderHistory();
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    const loadReviews = async () => {
      if (!analysis) return;
      reviewWarning = null;
      try {
        const response = await host.request(`/v1/clinical-analyses/${encodeURIComponent(analysis.analysisId)}/reviews`);
        reviews = response.reviews;
      } catch {
        reviews = defaultReviews();
        reviewWarning = "Review state is unavailable until this recorded analysis can be read from the ledger.";
      }
    };

    const selectAnalysis = async (value, workflow = null) => {
      const caseChanged = caseInput.value.trim() !== value.packet.caseId;
      analysis = { ...value, workflow };
      focusedEvidence = null;
      reviews = [];
      caseInput.value = analysis.packet.caseId;
      analysisIdInput.value = analysis.analysisId;
      setSelection();
      await loadReviews();
      if (caseChanged) await loadHistory();
      renderHistory();
      render();
    };

    const loadAnalysis = async (analysisId) => {
      status.textContent = `Loading ${analysisId}`;
      try {
        const recorded = await host.request(`/v1/clinical-analyses/${encodeURIComponent(analysisId)}`);
        await selectAnalysis(recorded);
        status.textContent = `Loaded · ${recorded.analysisId} · packet ${recorded.packetDigest}`;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };

    const syncWorkspaceSelection = (selection) => {
      if (!selection || selection.kind !== "clinical_analysis" || selection.analysisId === analysis?.analysisId) return;
      void loadAnalysis(selection.analysisId);
    };
    const unsubscribeSelection = host.onWorkspaceSelectionChange(syncWorkspaceSelection);

    const inspectEvidence = (row) => {
      focusedEvidence = row;
      render();
    };

    const evidenceTable = (title, rows) => {
      const section = host.node("section", "evidence-section");
      section.append(host.node("h2", null, title));
      if (!rows?.length) {
        section.append(host.node("p", "muted", "No rows"));
        return section;
      }
      const columns = ["gene", "disease_label", "variant_key", "evidence_status", "missing_field", "conflict", "review_kind"]
        .filter((key) => rows.some((row) => row[key] != null));
      const wrap = host.node("div", "table-wrap");
      const table = host.node("table");
      const head = host.node("thead");
      const headRow = host.node("tr");
      for (const column of columns) headRow.append(host.node("th", null, column.replaceAll("_", " ")));
      headRow.append(host.node("th", null, ""));
      head.append(headRow);
      const body = host.node("tbody");
      for (const row of rows.slice(0, 50)) {
        const tr = host.node("tr", focusedEvidence?.evidence_key === row.evidence_key ? "focused" : "");
        for (const column of columns) tr.append(host.node("td", null, row[column] == null ? "" : String(row[column])));
        const action = host.node("button", "table-action", "Inspect");
        action.type = "button";
        action.addEventListener("click", () => inspectEvidence(row));
        const actionCell = host.node("td", "table-action-cell");
        actionCell.append(action);
        tr.append(actionCell);
        body.append(tr);
      }
      table.append(head, body);
      wrap.append(table);
      section.append(wrap);
      return section;
    };

    const askForReview = (item) => {
      if (!analysis || !host.getActiveSession()) return;
      host.setAgentDraft(`Inspect review item ${item.kind} for analysis ${analysis.analysisId}. Target: ${item.target}. Reason: ${item.reason} Recorded status: ${item.status}. Start from the evidence packet ${analysis.packetUri} and the ledger run ids ${analysis.packet.provenance.runIds.join(", ")}. Treat these ids as pointers; derive facts from the recorded evidence, receipts, and graph.`);
    };

    const saveReview = async (item, select, note) => {
      if (!analysis || !item.reviewId) return;
      const button = select.closest(".review-row")?.querySelector(".save-review");
      if (button) button.disabled = true;
      try {
        const response = await host.request(`/v1/clinical-analyses/${encodeURIComponent(analysis.analysisId)}/reviews/${encodeURIComponent(item.reviewId)}`, {
          method: "PUT",
          body: JSON.stringify({ status: select.value, ...(note.value.trim() ? { note: note.value.trim() } : {}) }),
        });
        reviews = response.reviews;
        reviewWarning = null;
        render();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        if (button) button.disabled = false;
      }
    };

    const reviewQueue = () => {
      const section = host.node("section", "evidence-section");
      section.append(host.node("h2", null, "Review queue"));
      if (reviewWarning) section.append(host.node("p", "muted", reviewWarning));
      const reviewList = host.node("div", "review-list");
      const items = reviews.length ? reviews : defaultReviews();
      for (const item of items) {
        const row = host.node("div", "review-row");
        const identity = host.node("div", "review-identity");
        identity.append(host.node("strong", null, item.kind), host.node("code", null, item.target));
        const reason = host.node("span", "review-reason", item.reason);
        const controls = host.node("div", "review-controls");
        const disposition = host.node("select", "review-disposition");
        for (const [value, label] of [["open", "Open"], ["acknowledged", "Acknowledged"], ["needs_follow_up", "Needs follow-up"]]) {
          const option = host.node("option", null, label);
          option.value = value;
          option.selected = item.status === value;
          disposition.append(option);
        }
        const note = host.node("input", "review-note");
        note.placeholder = "Review note";
        note.value = item.note ?? "";
        const save = host.node("button", "secondary-command save-review", "Record");
        save.type = "button";
        save.disabled = !item.reviewId;
        save.addEventListener("click", () => { void saveReview(item, disposition, note); });
        const inspect = host.node("button", "text-command review-agent", "Inspect in Pi");
        inspect.type = "button";
        inspect.disabled = !host.getActiveSession();
        inspect.addEventListener("click", () => askForReview(item));
        controls.append(disposition, note, save, inspect);
        row.append(identity, reason, controls);
        reviewList.append(row);
      }
      if (!items.length) reviewList.append(host.node("p", "muted", "No review items"));
      section.append(reviewList);
      return section;
    };

    const focusedPanel = () => {
      if (!focusedEvidence || !analysis) return null;
      const section = host.node("section", "evidence-section focused-evidence");
      const heading = host.node("div", "focused-evidence-heading");
      heading.append(host.node("h2", null, "Evidence focus"));
      const clear = host.node("button", "text-command", "Clear focus");
      clear.type = "button";
      clear.addEventListener("click", () => { focusedEvidence = null; render(); });
      heading.append(clear);
      section.append(heading);
      const facts = host.node("dl", "workflow-facts");
      for (const [label, value] of [
        ["Evidence key", focusedEvidence.evidence_key],
        ["Lane", focusedEvidence.lane],
        ["Run", evidenceRun(focusedEvidence)],
        ["Review target", focusedEvidence.review_target],
        ["Status", focusedEvidence.evidence_status],
      ]) facts.append(host.node("dt", null, label), host.node("dd", null, value == null ? "" : String(value)));
      section.append(facts);
      const details = host.node("details", "packet-json");
      details.append(host.node("summary", null, "Recorded evidence row"), host.node("pre", null, JSON.stringify(focusedEvidence, null, 2)));
      section.append(details);
      return section;
    };

    const render = () => {
      const content = container.querySelector("#analysis-content");
      content.replaceChildren();
      updateAsk();
      if (!analysis) return;
      const { packet } = analysis;
      const evidenceGaps = packet.summary.directAbstentions + packet.summary.invertedGaps + packet.summary.invertedUnsearched;
      const metrics = host.node("section", "metrics");
      metrics.append(
        metric("Direct candidates", packet.summary.directCandidates),
        metric("Evidence gaps", evidenceGaps),
        metric("Phenotype hypotheses", packet.summary.phenotypeHypotheses),
        metric("Selected alleles", packet.summary.selectedAlleles),
        metric("Review items", packet.summary.reviewQueue.length),
        metric("Conflicts", packet.summary.conflicts),
      );
      content.append(metrics);

      const workflow = host.node("section", "workflow-result evidence-section");
      workflow.append(host.node("h2", null, "Recorded workflow"));
      const workflowFacts = host.node("dl", "workflow-facts");
      const detailFacts = [
        ["Analysis", analysis.analysisId],
        ["Packet", analysis.packetUri],
        ["Grounding", packet.grounding?.groundingId],
        ["Generated", packet.generatedAt],
        ["Replay", analysis.workflow?.replayDigest ?? "Recorded packet"],
      ];
      if (analysis.workflow) {
        detailFacts.splice(3, 0, ["Executed steps", analysis.workflow.executedSteps], ["Reused steps", analysis.workflow.reusedSteps]);
      }
      for (const [label, value] of detailFacts) workflowFacts.append(host.node("dt", null, label), host.node("dd", null, value == null ? "" : String(value)));
      workflow.append(workflowFacts);
      content.append(workflow, reviewQueue());
      const focus = focusedPanel();
      if (focus) content.append(focus);
      content.append(evidenceTable("Direct evidence", packet.lanes.direct.rows), evidenceTable("Inverted evidence", packet.lanes.inverted.rows));

      const provenance = host.node("section", "evidence-section");
      provenance.append(host.node("h2", null, "Provenance"));
      const runs = host.node("div", "run-list");
      for (const runId of packet.provenance.runIds) runs.append(host.node("code", "run-id", runId));
      provenance.append(runs);
      const details = host.node("details", "packet-json");
      details.append(host.node("summary", null, "Evidence packet JSON"), host.node("pre", null, JSON.stringify(packet, null, 2)));
      provenance.append(details);
      content.append(provenance);
    };

    container.querySelector("#analysis-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = container.querySelector("#run-analysis");
      const steps = [...container.querySelectorAll("#analysis-steps li")];
      const caseId = caseInput.value.trim();
      const requestedAnalysisId = analysisIdInput.value.trim();
      if (!caseId) return;
      button.disabled = true;
      steps.forEach((step) => step.classList.add("running"));
      status.textContent = "Running 8 checkpointed stages · the response returns after the evidence packet is committed";
      try {
        const result = await host.request("/v1/clinical-analyses", {
          method: "POST",
          body: JSON.stringify({ caseId, ...(requestedAnalysisId ? { analysisId: requestedAnalysisId } : {}) }),
        });
        steps.forEach((step) => {
          step.classList.remove("running");
          step.classList.add("complete");
        });
        await selectAnalysis(result, result.workflow);
        status.textContent = `Completed · ${result.analysisId} · ${result.workflow.executedSteps} executed · ${result.workflow.reusedSteps} reused`;
        await loadHistory();
      } catch (error) {
        steps.forEach((step) => step.classList.remove("running"));
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    });

    container.querySelector("#refresh-history").addEventListener("click", () => { void loadHistory(); });
    caseInput.addEventListener("change", () => { void loadHistory(); });

    askButton.addEventListener("click", () => {
      if (!analysis || !host.getActiveSession()) return;
      host.setAgentDraft(`Inspect recorded analysis ${analysis.analysisId} for case ${analysis.packet.caseId}. Start from packet ${analysis.packetUri}, grounding ${analysis.packet.grounding?.groundingId ?? ""}, and run ids ${analysis.packet.provenance.runIds.join(", ")}. Verify evidence and surface abstentions or conflicts through the ledger and graph; these identifiers are pointers, not the fact source. Any requested figure must be a declared compute.run output with CAS-backed artifacts.`);
    });

    void loadHistory();
    return {
      activate: () => {
        updateAsk();
        syncWorkspaceSelection(host.getWorkspaceSelection());
      },
      dispose() {
        unsubscribeSession();
        unsubscribeSelection();
      },
    };
  },
});
