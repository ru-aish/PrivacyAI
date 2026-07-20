# Contextual-model public sources

This package converts only explicitly approved public datasets into the private
PrivacyAI contextual-model interchange format. Raw text remains local and is
written with mode `0600` inside directories with mode `0700`. Standard output
and manifests contain counts, hashes, revisions, licensing, and attribution
metadata only.

## Source policy

| Key | Dataset | License | Status |
|---|---|---|---|
| `tab` | `ildpil/text-anonymization-benchmark` | MIT | enabled |
| `openpii_1_5m` | `ai4privacy/pii-masking-openpii-1.5m` | CC-BY-4.0 | enabled |
| `the_stack_smol` | `bigcode/the-stack-smol` | mixed source licenses + BigCode terms | gated; automatic access disabled |

Preserve the TAB MIT license notice. For OpenPII outputs and derived models,
credit **Ai4Privacy / Ai Suisse SA, OpenPII 1.5M (2026)** under CC-BY-4.0.
BigCode data is not fetched unless the user has separately accepted the current
terms and the implementation has been extended to preserve per-example license
provenance and deletion/version obligations.

## Metadata-only inventory

```bash
python -m tools.contextual_model.public_sources.cli inventory
python -m tools.contextual_model.public_sources.cli check-access tab
# Deliberately fails closed:
python -m tools.contextual_model.public_sources.cli check-access the_stack_smol
```

## TAB

Download the three official ZIP archives from the Hugging Face dataset page and
pin the dataset revision used. ZIP contents are parsed in memory; absolute paths,
`..` traversal, and symlink members are rejected.

```bash
umask 077
python -m tools.contextual_model.public_sources.cli tab \
  echr_train.zip echr_dev.zip echr_test.zip \
  --revision <dataset-commit> \
  --target-tokens 160000 \
  --output ~/.local/share/privacyai-contextual-model/public/tab.jsonl \
  --manifest ~/.local/share/privacyai-contextual-model/manifests/tab.json
```

`DIRECT` and `QUASI` mentions map to `MASK`; `NO_MASK` maps to `KEEP`. All
annotators, co-reference mentions, and task variants for one `doc_id` share the
same group, preventing ECHR document leakage across splits.

## OpenPII 1.5M

The converter uses Hugging Face `datasets` streaming and reservoir sampling; it
does not require downloading all 5+ GB. Every `privacy_mask` value is verified
against its Unicode code-point offsets before it is accepted.

```bash
umask 077
python -m tools.contextual_model.public_sources.cli openpii \
  --split train \
  --revision <dataset-commit> \
  --max-rows 20000 \
  --target-tokens 100000 \
  --seed 1729 \
  --language-quotas en=5000,hi=2500,ja=2500,ko=2500 \
  --output ~/.local/share/privacyai-contextual-model/public/openpii.jsonl \
  --manifest ~/.local/share/privacyai-contextual-model/manifests/openpii.json
```

The label files contain offsets, entity types, actions, hashes, and provenance;
they do not duplicate the sensitive substring. OpenPII values are synthetic,
but the raw source text is still handled as owner-only training data.

## Integration rules

1. Split by complete `group_id`, never by individual mention or annotator row.
2. Run exact and normalized-hash contamination checks against all train,
   validation, holdout, and benchmark manifests before training.
3. Choose calibration thresholds only on the validation split.
4. Never use TAB or any real-session source to construct the locked synthetic
   benchmark templates.
5. Record dataset revision hashes and required attribution in the final model
   card and release report.
