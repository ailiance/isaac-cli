# Runbook — Mirror the MCP-retrieval embedding dependency (HITL)

**Date:** 2026-06-02
**Status:** Prepared for human-in-the-loop execution (merge blocker for PR #50).
**Why:** Per the ailiance supply-chain policy (no blind upstream; pin + mirror;
HITL diff review), the adaptive MCP retrieval feature's embedding stack must be
vendored into the `ailiance` org before it ships to production. This runbook is
**not** auto-executed — forks/pushes require human review.

## What must be mirrored

1. **npm package** `@huggingface/transformers@3.3.3` (pinned, sha512 in
   `package-lock.json`).
2. **Model weights** `Xenova/all-MiniLM-L6-v2` (ONNX, ~88 MB) — the
   feature-extraction model loaded at runtime by `createDefaultEmbedder`.

## Runtime is already mirror-ready (no code change needed after mirroring)

`src/core/mcp/retrieval/Embedder.ts` reads two env vars:
- `AILIANCE_EMBED_MODEL` — model id/path (default `Xenova/all-MiniLM-L6-v2`).
  Point it at the mirrored repo/local path.
- `AILIANCE_EMBED_OFFLINE=1` — sets `transformers.env.allowRemoteModels = false`
  so transformers.js loads ONLY from the local cache (no HF CDN fetch).

So production sets, e.g.:
```
AILIANCE_EMBED_MODEL=Ailiance-fr/all-MiniLM-L6-v2   # or an absolute local dir
AILIANCE_EMBED_OFFLINE=1
```

## Step 1 — Mirror the model weights into the ailiance HF org

On a host with `huggingface_hub` + write token for `Ailiance-fr`:
```bash
python - <<'PY'
from huggingface_hub import snapshot_download, create_repo, upload_folder
# 1. pull the exact upstream snapshot (pin the revision after first fetch)
local = snapshot_download("Xenova/all-MiniLM-L6-v2")  # capture the commit sha
# 2. create the mirror + upload
create_repo("Ailiance-fr/all-MiniLM-L6-v2", repo_type="model", private=False, exist_ok=True)
upload_folder(repo_id="Ailiance-fr/all-MiniLM-L6-v2", folder_path=local, repo_type="model")
PY
```
- Record the upstream commit SHA in the SBOM (audit trail).
- Set the mirror's license/card to match upstream (Apache-2.0).
- Verify the ONNX file (`onnx/model.onnx` / `model_quantized.onnx`) is present
  and byte-identical (hash) to upstream.

## Step 2 — Vendor/mirror the npm package

Follow `ailiance-gateway/docs/superpowers/specs/2026-05-29-dependency-fork-audit-strategy.md`.
Options (pick per the strategy):
- Mirror the exact tarball `@huggingface/transformers@3.3.3` to the ailiance npm
  registry/mirror, OR vendor it under the org. Keep the sha512 from
  `package-lock.json` as the integrity anchor.
- **Image-dep trim (resolves the `sharp` duplicate):** the package pulls
  `sharp@^0.33.5` (→ `@img/sharp-libvips@1.0.4`), which collides with the repo's
  `sharp@0.34.5` (→ libvips `1.2.4`) and is never used by text feature-extraction.
  At vendor time, drop/patch the `sharp` dependency from the vendored package
  (text inference does not need it). This eliminates the duplicate-libvips objc
  warning that a lockfile `overrides` cannot fix cleanly (forcing it cross-major
  leaves npm in an `invalid` state — verified 2026-06-02).

## Step 3 — Point production at the mirror + offline

- Set `AILIANCE_EMBED_MODEL` + `AILIANCE_EMBED_OFFLINE=1` in the isaac CLI /
  extension runtime environment.
- Pre-seed the local model cache on the deploy host (so first run is offline).
- Smoke test: `createDefaultEmbedder().embed(["test"])` returns a 384-d vector
  with no network egress (verify with the network disabled).

## Step 4 — SBOM + audit

- Add `@huggingface/transformers@3.3.3` (+ sha512) and
  `Ailiance-fr/all-MiniLM-L6-v2` (+ upstream commit SHA) to the SBOM.
- Note the HITL review date + reviewer.

## Verification checklist

- [x] Model mirror exists in `Ailiance-fr/`, ONNX hash matches upstream.
- [x] npm package pinned with sha512 anchor (org strategy = pin-only, NOT vendor).
- [ ] `AILIANCE_EMBED_MODEL` + `AILIANCE_EMBED_OFFLINE=1` set in prod (deploy-time).
- [x] Embed works against the mirror (verified end-to-end, 384-d).
- [x] Audit recorded (below); HITL review done by user 2026-06-02.
- [ ] PR #50 merge unblocked (pending deploy-time env wiring).

## Correction vs the org supply-chain strategy

The org policy (`ailiance-gateway/docs/.../2026-05-29-dependency-fork-audit-strategy.md`
§11–§12, user decision 2026-05-29) is **pin-only + SBOM for every ecosystem;
vendoring is reserved for the single Tier-0 untrusted case (`omlx`)**. npm is
explicitly *pin-only* (lockfile + `npm audit`), NOT vendored. So Step 2's
"vendor the npm package" over-specified: `@huggingface/transformers@3.3.3` is
already correctly frozen by its sha512 in `package-lock.json` — no fork/vendor
needed. The `sharp` trim is a perf nicety, not a supply-chain requirement.

The only genuine supply-chain action was mirroring the **model weights** into
the `ailiance` org for a sovereign offline runtime posture (matching the 20
other `Ailiance-fr` models).

## Execution record (2026-06-02, HITL-approved)

- **Model mirror:** `Ailiance-fr/all-MiniLM-L6-v2` (public, Apache-2.0) created
  and populated from the full upstream snapshot.
  - upstream `Xenova/all-MiniLM-L6-v2` commit sha = `751bff37182d3f1213fa05d7196b954e230abad9`
  - mirror commit sha = `5cbc3683c2dbc1a6372202305af9762e7973c73e`
  - contents: `onnx/model.onnx` (90.39 MB) + 7 quantized variants
    (`model_fp16/int8/quantized/uint8/q4/q4f16/bnb4.onnx`) + tokenizer/config/
    vocab/README — byte-identical to upstream.
  - mirrored by `clemsail` (Ailiance-fr admin, write token) via
    `huggingface_hub` `snapshot_download` → `create_repo` → `upload_folder`.
  - verified: `AILIANCE_EMBED_MODEL=Ailiance-fr/all-MiniLM-L6-v2` loads through
    `createDefaultEmbedder()` and returns a 384-d vector.
- **npm pin (audit anchor):** `@huggingface/transformers@3.3.3`,
  `sha512-OcMubhBjW6u1xnp0zSt5SvCxdGHuhP2k+w2Vlm3i0vNcTJhJTZWxxYQmPBfcb7PX+Q6c43lGSzWD6tsJFwka4Q==`,
  license Apache-2.0 (`package-lock.json`). Pin-only per org strategy.
- **Remaining (deploy-time, not a code change):** set
  `AILIANCE_EMBED_MODEL=Ailiance-fr/all-MiniLM-L6-v2` + `AILIANCE_EMBED_OFFLINE=1`
  in the isaac CLI/extension runtime env and pre-seed the model cache on the
  deploy host so first run is offline.
