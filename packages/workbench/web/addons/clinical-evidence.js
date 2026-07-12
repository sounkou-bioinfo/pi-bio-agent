import { registerWorkbenchAddon } from "/addon-runtime.js";

registerWorkbenchAddon({
  id: "clinical-evidence",
  async mount(container, host) {
    container.innerHTML = `
      <div class="analysis-launch">
        <form id="analysis-form" class="analysis-toolbar">
          <label for="case-id">Case</label>
          <input id="case-id" value="CASE-RD-001" autocomplete="off">
          <button id="run-analysis" class="primary-command" type="submit">Run fixture workup</button>
          <button id="ask-agent" class="secondary-command" type="button" disabled>Ask Pi</button>
        </form>
        <section class="analysis-plan" aria-labelledby="analysis-plan-title">
          <div class="analysis-plan-heading">
            <div><h2 id="analysis-plan-title">Recorded case workup</h2><p>One synchronous request, eight resumable steps, one CAS-backed evidence packet.</p></div>
            <dl class="analysis-inputs">
              <dt>Assembly</dt><dd>GRCh38</dd>
              <dt>Sources</dt><dd>Declared fixture resources</dd>
              <dt>VEP</dt><dd>Host-composed endpoint</dd>
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
      <div id="analysis-status" class="analysis-status">Not run</div>
      <div id="analysis-content" class="analysis-content"></div>`;

    let analysis = null;
    const askButton = container.querySelector("#ask-agent");
    const updateAsk = () => { askButton.disabled = !analysis || !host.getActiveSession(); };
    const unsubscribe = host.onSessionChange(updateAsk);

    const metric = (label, value) => {
      const item = host.node("div", "metric");
      item.append(host.node("span", "metric-value", String(value)), host.node("span", "metric-label", label));
      return item;
    };

    const evidenceTable = (title, rows) => {
      const section = host.node("section", "evidence-section");
      section.append(host.node("h2", null, title));
      if (!rows?.length) {
        section.append(host.node("p", "muted", "No rows"));
        return section;
      }
      const columns = ["gene", "disease_label", "variant_key", "evidence_status", "review_kind"].filter((key) => rows.some((row) => row[key] !== undefined));
      const wrap = host.node("div", "table-wrap");
      const table = host.node("table");
      const head = host.node("thead");
      const headRow = host.node("tr");
      for (const column of columns) headRow.append(host.node("th", null, column.replaceAll("_", " ")));
      head.append(headRow);
      const body = host.node("tbody");
      for (const row of rows.slice(0, 30)) {
        const tr = host.node("tr");
        for (const column of columns) tr.append(host.node("td", null, row[column] == null ? "" : String(row[column])));
        body.append(tr);
      }
      table.append(head, body);
      wrap.append(table);
      section.append(wrap);
      return section;
    };

    const render = () => {
      const content = container.querySelector("#analysis-content");
      content.replaceChildren();
      updateAsk();
      if (!analysis) return;
      const { packet } = analysis;
      const metrics = host.node("section", "metrics");
      metrics.append(
        metric("Direct candidates", packet.summary.directCandidates),
        metric("Abstentions", packet.summary.directAbstentions),
        metric("Phenotype hypotheses", packet.summary.phenotypeHypotheses),
        metric("Selected alleles", packet.summary.selectedAlleles),
        metric("Review items", packet.summary.reviewQueue.length),
        metric("Conflicts", packet.summary.conflicts),
      );
      content.append(metrics);

      const workflow = host.node("section", "workflow-result evidence-section");
      workflow.append(host.node("h2", null, "Recorded workflow"));
      const workflowFacts = host.node("dl", "workflow-facts");
      for (const [label, value] of [
        ["Analysis", analysis.analysisId],
        ["Packet", analysis.packetUri],
        ["Executed steps", analysis.workflow.executedSteps],
        ["Reused steps", analysis.workflow.reusedSteps],
        ["Replay", analysis.workflow.replayDigest],
      ]) workflowFacts.append(host.node("dt", null, label), host.node("dd", null, String(value)));
      workflow.append(workflowFacts);
      content.append(workflow);

      const review = host.node("section", "evidence-section");
      review.append(host.node("h2", null, "Review queue"));
      const reviewList = host.node("div", "review-list");
      for (const item of packet.summary.reviewQueue) {
        const row = host.node("div", "review-row");
        row.append(host.node("strong", null, item.kind), host.node("code", null, item.target), host.node("span", null, item.reason));
        reviewList.append(row);
      }
      if (!packet.summary.reviewQueue.length) reviewList.append(host.node("p", "muted", "No review items"));
      review.append(reviewList);
      content.append(review, evidenceTable("Direct evidence", packet.lanes.direct.rows), evidenceTable("Inverted evidence", packet.lanes.inverted.rows));

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
      const status = container.querySelector("#analysis-status");
      const button = container.querySelector("#run-analysis");
      const steps = [...container.querySelectorAll("#analysis-steps li")];
      button.disabled = true;
      steps.forEach((step) => step.classList.add("running"));
      status.textContent = "Running 8 checkpointed stages · the response returns after the evidence packet is committed";
      try {
        analysis = await host.request("/v1/clinical-analyses", {
          method: "POST",
          body: JSON.stringify({ caseId: container.querySelector("#case-id").value.trim() }),
        });
        steps.forEach((step) => {
          step.classList.remove("running");
          step.classList.add("complete");
        });
        status.textContent = `Completed · ${analysis.analysisId} · ${analysis.workflow.executedSteps} executed · ${analysis.workflow.reusedSteps} reused`;
        render();
      } catch (error) {
        steps.forEach((step) => step.classList.remove("running"));
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        button.disabled = false;
      }
    });

    askButton.addEventListener("click", () => {
      if (!analysis || !host.getActiveSession()) return;
      const runIds = analysis.packet.provenance.runIds.join(", ");
      host.setAgentDraft(`Inspect analysis ${analysis.analysisId} through the ledger and graph. Start from these run ids: ${runIds}. Verify the evidence and surface abstentions; do not treat this message as the fact source. If I request a figure, use a declared compute.run output so it is captured in CAS and shown in Artifacts; do not write an untracked plot directly.`);
    });

    return { activate: updateAsk, dispose: unsubscribe };
  },
});
