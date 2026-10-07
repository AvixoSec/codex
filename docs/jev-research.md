# Jev research notes

Checked against the public sources available on 2026-10-07.

## Canonical facts used by the harness

- Jev is TypeSafe's first System One model: it evaluates application `state`
  against typed questions and returns structured decisions rather than worker
  prose.
- `Choice`, `Score`, and `Noul` questions can be evaluated independently in a
  single request. Choice supplies an option, a probability distribution, and a
  confidence value; Noul supplies a probability from 0 to 1.
- The public HTTP contract is `POST https://api.typesafe.ai/v1/systemone` with
  `state`, `model`, and `questions`. Choice supports at most 255 options.
- TypeSafe recommends narrow atomic questions and confidence-gated routing,
  while application code remains responsible for thresholds and effects.

Those points directly produced this architecture: one batched Jev request per
semantic step, one independent Choice for every route coordinate, a Noul for
completion, local confidence fallbacks, and a separate policy/approval kernel
for effects.

## Sources

- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe HTTP API reference](https://docs.typesafe.ai/api)
- [TypeSafe confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing)
- [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe AI on X](https://x.com/typesafeai)

## X search limitation

The supplied generic X search page is session-dependent and did not expose its
post feed to the available web reader. Search-engine results and the public
TypeSafe account were checked, but this work does not claim an exhaustive
review of every post matching the word “Jev”; the official documentation above
is the source of truth for the wire contract.
