# ADR-0101 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- Intent: Stop images already represented by a successful context compaction from being resent on
  every later Responses turn.
- Prior constraints: Codex can retain original image-bearing messages beside its compacted summary;
  OpenCodeX does not own or safely rewrite that client transcript, but it does own provider ingress
  and its process-local continuation cache. Compaction ciphertext and provider-issued identities
  must remain untouched.
- Alternatives considered: delete all images after one use; generate permanent captions in a
  second model call; rely on Codex's image budget; mutate rollout files; strip every image on every
  turn; use the latest completed compaction item as the lifetime boundary.
- Decision: On Responses parsing, find the latest completed compact-wire item and copy-on-write
  replace earlier `input_image` blocks in schema-compatible message and tool-output arrays with a
  fixed text marker. Preserve newer images, and do not treat `compaction_trigger` as success.
- Why: The compacted summary is the semantic replacement text already produced by the compaction
  workflow. A deterministic marker records that media existed without inventing another model
  description, while the completed boundary prevents loss before compaction succeeds.
- Consequences: Requests and OpenCodeX continuation state stop carrying historical image bytes after
  compaction. Codex may still keep those bytes locally; removing them there remains a client-owned
  concern. A user who needs pixels again must attach the image after the latest compaction boundary.
