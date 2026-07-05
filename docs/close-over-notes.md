# Close-over notes

This repo is the application split from `pi-bio-agent`. It should consume substrate primitives directly and only
promote a new primitive after a second concrete use proves it.

## First binding

The clinical-genomics example is an evidence workflow, not a completed clinical classification kernel.

- Direct lane: observed variants -> candidate / abstention / exclusion buckets.
- Inverted lane: observed phenotypes -> gene/disease hypotheses -> supporting variant, abstained variant, or gap.
- Reanalysis lane: current evidence status vs prior evidence status; only new/upgraded review-worthy rows become
  reanalysis signals.

The two directions differ by traversal order, not by storage model. Both close into one evidence packet, one CAS
artifact, and one `case:<id>` observation with links to the three `run:<id>` facts.

## Substrate Used As-Is

- `runBioOperationFromManifest` for all scientific steps.
- `openBioStore` / `bio_observations` for the app packet and graph links.
- `fsCasStore` for the packet artifact and run-result CAS references.
- `recordObservation` / `recordObservationLink` for app-owned case nodes and packet links.

No new substrate primitive was needed for this first slice.

## Gaps Not Yet Promoted

- The evidence-packet schema is app-owned until another binding needs the same report contract.
- Runtime host-event receipts remain deferred until review/steer/interrupt capture is used by a concrete workflow.
- `CasStore` is not exported as a package-root SDK type. This app works around it with
  `ReturnType<typeof fsCasStore>`. Promote only when a second host CAS implementation needs the interface at the app
  boundary.

## Clinical Kernel Boundary

Do not claim clinical-kernel completion here. Fixtures still needed before a classifier claim include recessive
carrier guards, SNV/CNV unification, CNV dosage, loss-of-function entry gates, common-pathogenic exception lists,
benign blocking for hotspot evidence, family QC, and phenotype information-content denominators.
