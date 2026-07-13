import { registerWorkbenchAddon } from "/addon-runtime.js";

const CLASSIFICATION_LABELS = {
  benign: "Benign",
  likely_benign: "Likely benign",
  uncertain_significance: "Uncertain significance",
  likely_pathogenic: "Likely pathogenic",
  pathogenic: "Pathogenic",
  conflicting_classifications: "Conflicting classifications",
};

function classificationLabel(value) {
  return CLASSIFICATION_LABELS[value] ?? String(value ?? "Unknown").replaceAll("_", " ");
}

function classificationClass(value) {
  return `classification classification-${String(value ?? "unknown").replaceAll("_", "-")}`;
}

function criterionLabel(criterion) {
  if (!criterion.code) return criterion.raw;
  const strength = criterion.strength && criterion.strength !== "default"
    ? ` (${criterion.strength.replaceAll("_", " ")})`
    : "";
  return `${criterion.code}${strength}`;
}

function externalLink(host, label, href) {
  const link = host.node("a", "variant-link", label);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

function factList(host, facts, className = "variant-facts") {
  const list = host.node("dl", className);
  for (const [label, value] of facts) {
    if (value == null || value === "") continue;
    list.append(host.node("dt", null, label));
    const item = host.node("dd");
    if (value instanceof Node) item.append(value);
    else item.textContent = String(value);
    list.append(item);
  }
  return list;
}

function criterionGroup(host, title, criteria) {
  const group = host.node("section", "criterion-group");
  const heading = host.node("div", "criterion-heading");
  heading.append(host.node("h3", null, title), host.node("span", "muted", `${criteria.length} decisions`));
  group.append(heading);
  if (!criteria.length) {
    group.append(host.node("p", "muted", "No criteria recorded."));
    return group;
  }
  const list = host.node("div", "criterion-list");
  for (const criterion of criteria) {
    const item = host.node("div", `criterion-row${criterion.parseStatus === "unparsed" ? " criterion-unparsed" : ""}`);
    const applied = criterion.applied == null ? "Recorded" : criterion.applied ? "Applied" : "Not applied";
    item.append(
      host.node("strong", null, criterionLabel(criterion)),
      host.node("span", criterion.applied === false ? "criterion-state criterion-state-negative" : "criterion-state", applied),
    );
    if (criterion.context) item.append(host.node("span", "criterion-context", criterion.context));
    if (criterion.sourceFlag !== "none" || criterion.parseStatus === "unparsed") {
      const flags = [criterion.sourceFlag !== "none" ? criterion.sourceFlag.replaceAll("_", " ") : null, criterion.parseStatus === "unparsed" ? "unparsed" : null]
        .filter(Boolean)
        .join(" · ");
      item.append(host.node("span", "criterion-warning", flags));
    }
    list.append(item);
  }
  group.append(list);
  return group;
}

registerWorkbenchAddon({
  id: "published-variants",
  async mount(container, host) {
    container.innerHTML = `
      <form id="variant-filters" class="variant-toolbar">
        <label for="variant-role">Cohort</label>
        <select id="variant-role">
          <option value="external_validation">Held-out validation</option>
          <option value="external_reanalysis">Conflicting reanalysis</option>
        </select>
        <label for="variant-classification">Source class</label>
        <select id="variant-classification">
          <option value="">All</option>
          <option value="pathogenic">Pathogenic</option>
          <option value="likely_pathogenic">Likely pathogenic</option>
          <option value="uncertain_significance">Uncertain significance</option>
          <option value="likely_benign">Likely benign</option>
          <option value="benign">Benign</option>
          <option value="conflicting_classifications">Conflicting classifications</option>
        </select>
        <label for="variant-search">Search</label>
        <input id="variant-search" type="search" autocomplete="off" placeholder="HGVS, gene, or criterion">
        <button class="secondary-command" type="submit">Apply</button>
        <button id="variant-refresh" class="text-command" type="button">Refresh</button>
        <button id="variant-ask-agent" class="secondary-command" type="button" disabled>Ask Pi</button>
      </form>
      <div id="variant-status" class="variant-status">Loading registered variants.</div>
      <div class="variant-workspace">
        <section class="variant-index" aria-labelledby="variant-index-title">
          <div class="variant-index-heading">
            <h2 id="variant-index-title">Published variants</h2>
            <div class="variant-page-controls">
              <span id="variant-count" class="muted"></span>
              <button id="variant-previous" class="icon-command" type="button" title="Previous variant page" aria-label="Previous variant page">&#8249;</button>
              <button id="variant-next" class="icon-command" type="button" title="Next variant page" aria-label="Next variant page">&#8250;</button>
            </div>
          </div>
          <div id="variant-table" class="variant-table-wrap"></div>
        </section>
        <section id="variant-detail" class="variant-detail" aria-live="polite"><p class="muted">Select a variant.</p></section>
      </div>`;

    let page = null;
    let selected = null;
    let loadingDetail = false;
    let offset = 0;
    const limit = 50;

    const status = container.querySelector("#variant-status");
    const role = container.querySelector("#variant-role");
    const classification = container.querySelector("#variant-classification");
    const search = container.querySelector("#variant-search");
    const ask = container.querySelector("#variant-ask-agent");
    const detailRoot = container.querySelector("#variant-detail");

    const updateAsk = () => { ask.disabled = !selected || !host.getActiveSession(); };
    const unsubscribeSession = host.onSessionChange(updateAsk);

    const renderIndex = () => {
      const root = container.querySelector("#variant-table");
      root.replaceChildren();
      const first = page?.totalCount ? page.offset + 1 : 0;
      const last = page ? Math.min(page.offset + page.rows.length, page.totalCount) : 0;
      container.querySelector("#variant-count").textContent = page ? `${first}-${last} / ${page.totalCount}` : "";
      container.querySelector("#variant-previous").disabled = !page || page.offset === 0;
      container.querySelector("#variant-next").disabled = !page || page.offset + page.rows.length >= page.totalCount;
      if (!page?.rows.length) {
        root.append(host.node("p", "variant-empty muted", "No variants match the current filters."));
        return;
      }
      const table = host.node("table", "variant-table");
      const head = host.node("thead");
      const headRow = host.node("tr");
      for (const label of ["Variant", "Gene", "Source", "Reassessed", "Criteria", "Models"]) headRow.append(host.node("th", null, label));
      head.append(headRow);
      const body = host.node("tbody");
      for (const row of page.rows) {
        const tr = host.node("tr", selected?.row?.rowId === row.rowId ? "focused" : "");
        tr.tabIndex = 0;
        tr.setAttribute("role", "button");
        tr.setAttribute("aria-label", `Open ${row.variantText}`);
        const source = host.node("span", classificationClass(row.sourceClassification.normalized), classificationLabel(row.sourceClassification.normalized));
        const reference = host.node("span", classificationClass(row.referenceClassification.normalized), classificationLabel(row.referenceClassification.normalized));
        const modelState = `${row.deepseekConcordant ? "D✓" : "D×"} ${row.o3MiniHighConcordant ? "o3✓" : "o3×"}`;
        tr.append(
          host.node("td", "variant-identity-cell", row.variantText),
          host.node("td", null, row.genes.join(", ")),
          (() => { const td = host.node("td"); td.append(source); return td; })(),
          (() => { const td = host.node("td"); td.append(reference); return td; })(),
          host.node("td", null, `${row.literatureIndependentCriteria.length} + ${row.humanCriteria.length}`),
          host.node("td", "variant-model-state", modelState),
        );
        const open = () => { void loadDetail(row.rowId); };
        tr.addEventListener("click", open);
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
        body.append(tr);
      }
      table.append(head, body);
      root.append(table);
    };

    const renderModels = (row) => {
      const section = host.node("section", "variant-section");
      section.append(host.node("h2", null, "Model assessments"));
      const wrap = host.node("div", "table-wrap");
      const table = host.node("table", "model-assessment-table");
      const head = host.node("thead");
      const headRow = host.node("tr");
      for (const label of ["Actor", "Criteria", "Classification", "Computed match", "Reported match"]) headRow.append(host.node("th", null, label));
      head.append(headRow);
      const body = host.node("tbody");
      for (const [label, assessment] of [["DeepSeek-R1", row.modelAssessments.deepseekR1], ["o3-mini-high", row.modelAssessments.o3MiniHigh]]) {
        const tr = host.node("tr");
        const classCell = host.node("td");
        classCell.append(host.node("span", classificationClass(assessment.classification.normalized), classificationLabel(assessment.classification.normalized)));
        tr.append(
          host.node("td", null, label),
          host.node("td", "model-criteria", assessment.criteriaRaw || "None recorded"),
          classCell,
          host.node("td", null, assessment.computedConcordant ? "Yes" : "No"),
          host.node("td", assessment.concordanceConsistent ? null : "criterion-warning", assessment.reportedConcordant ? "Yes" : "No"),
        );
        body.append(tr);
      }
      table.append(head, body);
      wrap.append(table);
      section.append(wrap);
      return section;
    };

    const renderResolution = (value) => {
      const section = host.node("section", "variant-section source-resolution");
      section.append(host.node("h2", null, "Current source resolution"));
      if (!value.resolution) {
        section.append(host.node("p", "muted", "No independently resolved source snapshot is registered for this row."));
        return section;
      }
      const resolution = value.resolution;
      const clinvar = resolution.clinvar;
      const location = resolution.genomicLocation;
      const clinvarLink = clinvar ? externalLink(host, clinvar.accessionVersion, `https://www.ncbi.nlm.nih.gov/clinvar/variation/${encodeURIComponent(clinvar.uid)}/`) : null;
      const rsLinks = resolution.rsids.map((rsid) => externalLink(host, `rs${rsid}`, `https://www.ncbi.nlm.nih.gov/snp/${encodeURIComponent(rsid)}`));
      const rsValue = host.node("span", "inline-links");
      for (const link of rsLinks) rsValue.append(link);
      section.append(factList(host, [
        ["Transcript HGVS", resolution.transcriptHgvs],
        ["Transcript SPDI", resolution.transcriptSpdi],
        ["dbSNP", rsValue],
        ["ClinVar", clinvarLink],
        ["GRCh38", location ? `${location.chromosome}:${location.position1Based} ${location.ref}>${location.alt}` : null],
        ["Current class", clinvar?.classification],
        ["Review", clinvar?.reviewStatus],
        ["Last evaluated", clinvar?.lastEvaluated],
        ["Resolution CAS", value.resolutionUri],
      ]));
      if (clinvar?.traits.length) {
        const traits = host.node("div", "variant-traits");
        for (const trait of clinvar.traits) {
          const row = host.node("div", "variant-trait");
          row.append(host.node("strong", null, trait.name));
          if (trait.xrefs.length) row.append(host.node("span", "muted", trait.xrefs.map((xref) => `${xref.source}:${xref.id}`).join(" · ")));
          traits.append(row);
        }
        section.append(traits);
      }
      const snapshots = host.node("div", "source-snapshots");
      snapshots.append(host.node("h3", null, "Pinned source responses"));
      for (const snapshot of resolution.sourceSnapshots) {
        const row = host.node("div", "source-snapshot");
        const identity = host.node("div", "source-snapshot-identity");
        identity.append(externalLink(host, snapshot.sourceId, snapshot.uri), host.node("code", null, snapshot.digest), host.node("code", null, snapshot.runId));
        row.append(identity, host.node("span", "muted", `${snapshot.retrievedAt} · ${snapshot.sizeBytes} bytes`));
        snapshots.append(row);
      }
      section.append(snapshots);
      return section;
    };

    const renderDetail = () => {
      detailRoot.replaceChildren();
      updateAsk();
      if (loadingDetail) {
        detailRoot.append(host.node("p", "variant-empty muted", "Loading source and criterion evidence."));
        return;
      }
      if (!selected) {
        detailRoot.append(host.node("p", "variant-empty muted", "Select a variant."));
        return;
      }
      const { row, benchmark } = selected;
      const header = host.node("header", "variant-detail-header");
      const title = host.node("div", "variant-detail-title");
      title.append(host.node("span", "variant-gene", row.genes.join(", ")), host.node("h1", null, row.variantText), host.node("code", null, row.rowId));
      const comparison = host.node("div", "classification-comparison");
      const source = host.node("div", "classification-column");
      source.append(host.node("span", "muted", "Workbook source"), host.node("strong", classificationClass(row.sourceClassification.normalized), classificationLabel(row.sourceClassification.normalized)));
      const reassessed = host.node("div", "classification-column");
      reassessed.append(host.node("span", "muted", "Human reassessment"), host.node("strong", classificationClass(row.referenceClassification.normalized), classificationLabel(row.referenceClassification.normalized)));
      comparison.append(source, reassessed);
      header.append(title, comparison);
      detailRoot.append(header);

      const benchmarkSection = host.node("section", "variant-section benchmark-provenance");
      benchmarkSection.append(host.node("h2", null, "Published benchmark row"), factList(host, [
        ["Cohort", row.datasetRole === "external_validation" ? "Held-out validation" : "Conflicting reanalysis"],
        ["Sheet row", `${row.sheet} · ${row.sourceRow}`],
        ["Citation", benchmark.citation],
        ["Bundle digest", benchmark.normalizedDigest],
        ["Recorded", benchmark.recordedAt],
        ["Publications", row.publicationCount],
        ["Submission summary", row.sourceSubmissionSummary],
      ]));
      detailRoot.append(benchmarkSection, renderResolution(selected));

      const criteria = host.node("section", "variant-section");
      criteria.append(host.node("h2", null, "Criterion decisions"));
      const groups = host.node("div", "criterion-groups");
      groups.append(
        criterionGroup(host, "Literature-independent", row.literatureIndependentCriteria),
        criterionGroup(host, "Human literature review", row.humanCriteria),
      );
      criteria.append(groups);
      detailRoot.append(criteria, renderModels(row));
    };

    const loadDetail = async (rowId) => {
      loadingDetail = true;
      renderDetail();
      try {
        selected = await host.request(`/v1/published-variants/${encodeURIComponent(rowId)}`);
        host.setWorkspaceSelection({
          benchmarkRowId: selected.row.rowId,
          datasetId: selected.benchmark.datasetId,
          version: selected.benchmark.version,
          resolutionUri: selected.resolutionUri,
          sourceDigests: selected.resolution?.sourceSnapshots.map((item) => item.digest) ?? [],
          runIds: selected.resolution?.sourceSnapshots.map((item) => item.runId) ?? [],
        });
        status.textContent = selected.resolution
          ? `Resolved · ${selected.row.variantText} · ${selected.resolution.sourceSnapshots.length} pinned source responses`
          : `Published row · ${selected.row.variantText} · source resolution not registered`;
      } catch (error) {
        selected = null;
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        loadingDetail = false;
        renderIndex();
        renderDetail();
      }
    };

    const loadList = async () => {
      status.textContent = "Loading registered variants.";
      const params = new URLSearchParams({ role: role.value, limit: String(limit), offset: String(offset) });
      if (classification.value) params.set("classification", classification.value);
      if (search.value.trim()) params.set("q", search.value.trim());
      try {
        page = await host.request(`/v1/published-variants?${params}`);
        status.textContent = `${page.totalCount} registered rows · ${page.benchmark.datasetId}@${page.benchmark.version}`;
        renderIndex();
        const unfilteredFirstPage = offset === 0 && !classification.value && !search.value.trim();
        const preferred = page.featuredRowId && unfilteredFirstPage && role.value === "external_validation"
          ? page.featuredRowId
          : page.rows[0]?.rowId;
        if (preferred) await loadDetail(preferred);
        else {
          selected = null;
          renderDetail();
        }
      } catch (error) {
        page = null;
        selected = null;
        status.textContent = error instanceof Error ? error.message : String(error);
        renderIndex();
        renderDetail();
      }
    };

    container.querySelector("#variant-filters").addEventListener("submit", (event) => {
      event.preventDefault();
      offset = 0;
      void loadList();
    });
    container.querySelector("#variant-refresh").addEventListener("click", () => { void loadList(); });
    role.addEventListener("change", () => { offset = 0; void loadList(); });
    container.querySelector("#variant-previous").addEventListener("click", () => {
      offset = Math.max(0, offset - limit);
      void loadList();
    });
    container.querySelector("#variant-next").addEventListener("click", () => {
      offset += limit;
      void loadList();
    });
    ask.addEventListener("click", () => {
      if (!selected || !host.getActiveSession()) return;
      const snapshots = selected.resolution?.sourceSnapshots.map((item) => `${item.sourceId}=${item.digest}`).join(", ") || "no independent source snapshots";
      host.setAgentDraft(`Review published variant row ${selected.row.rowId} from ${selected.benchmark.datasetId}@${selected.benchmark.version}. The workbook records ${selected.row.variantText}, source classification ${selected.row.sourceClassification.raw}, and human reassessment ${selected.row.referenceClassification.raw}. Independent resolution: ${selected.resolutionUri ?? "not registered"}; source snapshots: ${snapshots}. Treat workbook and current source classifications as separate time-stamped observations. Inspect the ledger and CAS evidence before making any biomedical claim.`);
    });

    await loadList();
    return {
      activate() { updateAsk(); },
      dispose() { unsubscribeSession(); },
    };
  },
});
