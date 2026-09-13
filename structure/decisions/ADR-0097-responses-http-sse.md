# ADR-0097 — decision recorded under "Responses HTTP/SSE"

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Prevent a successful image-reading turn from making the next canonical ChatGPT
  continuation fail in the upstream Responses WebSocket prelude.
- 기존 구현 및 제약 조건: OpenCodex serialized every eligible streaming continuation, including
  retained Base64 image parts, into one `response.create` frame on the ChatGPT WebSocket beta path;
  native HTTP/SSE forwarding of the same input remained healthy.
- 검토한 주요 대안: Remove images from the transcript; summarize images permanently; increase the
  WebSocket prelude deadline again; disable upstream WebSocket globally; select HTTP only for
  structurally image-bearing canonical input.
- 선택한 방식: Detect `input_image` and `computer_screenshot` parts with a bounded structural scan
  of canonical Responses `input`, and choose HTTP/SSE before dialing. Keep prompt strings and
  explicitly WebSocket-enabled noncanonical providers unchanged.
- 다른 대안 대신 이 방식을 선택한 이유: The proxy does not own the client's durable transcript,
  and post-send fallback can duplicate an inference. A pre-dial, destination-scoped decision fixes
  the failing transport without deleting user context or removing the text fast lane.
- 장점, 단점 및 영향: Canonical vision continuations trade the WebSocket latency optimization for
  the native HTTP/SSE path's reliability. Text-only canonical turns and operator-configured custom
  WebSocket routes retain their existing behavior.
