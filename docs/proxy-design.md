# The broker — proxy layer design

The broker is the only path from the agent plane to anything else. Its job is to make one property
true: **no agent sandbox ever possesses a credential, and no agent sandbox reaches a host that its
run policy did not name.**

This document specifies how. See [plan.md](plan.md) for where the broker sits in the system.

---

## 1. Threat model

**What we assume.** Every agent sandbox is compromised. Not "might be" — *is*. Pi's own docs are
clear that prompt injection from repository files, comments, documentation, and build output is
expected local-agent risk that the harness cannot reliably prevent. An agent with a `bash` tool
reading an attacker-influenced file is an attacker-controlled shell. Design accordingly.

**What we defend.** The attacker has arbitrary code execution as the agent user, in the sandbox,
with the network reachability we granted. They want: model API keys, cloud credentials, source
code, tokens for GitHub/registries/internal services, and a route out to send them.

**What we concede.** Data the agent is *supposed* to see — the workspace, the model's responses —
can be misused within the boundary. An agent authorized to push to a branch can push bad code to
that branch. We narrow authority and audit it; we do not pretend to eliminate it.

**Non-goals.** Stopping a legitimately-authorized action taken for an illegitimate reason. That is
what approval gates and code review are for, and they belong upstream of the network layer.

---

## 2. The two gateways

The broker runs two distinct data paths. Conflating them is a common mistake — they have different
protocols, different trust properties, and different failure modes.

```
                  ┌─────────────────────── broker ────────────────────────┐
  sandbox         │                                                       │
  ┌──────────┐    │  ┌── model gateway ──┐    ┌── policy ──┐              │
  │ pi ──────┼────┼─▶│ reverse proxy     │───▶│  engine    │──┐           │
  │ (sentinel│    │  │ anthropic-messages│    │            │  │           │
  │  in hdr) │    │  └───────────────────┘    │ - allowlist│  ▼           │
  │          │    │                           │ - budget   │ upstream:    │
  │ bash ────┼────┼─▶┌── egress gateway ─┐───▶│ - identity │ Bedrock /    │
  │ git      │    │  │ HTTP CONNECT      │    │ - audit    │ api.anthropic│
  │ npm      │    │  │ MITM w/ orc CA    │    └────────────┘ github.com   │
  └──────────┘    │  └───────────────────┘           │      npmjs.org     │
   HTTPS_PROXY    │                                  ▼                    │
                  │                           Secrets Manager             │
                  └───────────────────────────────────────────────────────┘
```

---

## 3. Model gateway

### 3.1 Wire path

Pi is pointed at the broker by `@orc/pi`, using Pi's own provider override:

```ts
// inside @orc/pi, loaded into every sandboxed agent
pi.registerProvider("anthropic", {
  baseUrl: `${process.env.ORC_BROKER_URL}/m/anthropic`,
  apiKey: "$ORC_MODEL_SENTINEL",
  api: "anthropic-messages",
});
```

`$ORC_MODEL_SENTINEL` is resolved by Pi at request time from the sandbox environment. Its value is
a **sentinel**, not a credential.

### 3.2 Sentinels

A sentinel is a syntactically valid, semantically worthless token:

```
sk-ant-orc01-<run_id>-<agent_id>-<32 bytes base62>
```

Shape matters: it must survive client-side validation in Pi and in any SDK the agent might invoke,
or we get confusing failures instead of clean proxying. Pi's documented sandbox integration uses
the same trick with a `sk-ant-oat01-{rand}` placeholder.

Properties:

| Property | Value |
| --- | --- |
| Minted | At sandbox start, by `orcd`, one per agent |
| Bound to | run id, agent id, role, policy hash |
| TTL | Run wall-clock limit + 5 min grace |
| Stored | DynamoDB with TTL; broker caches in memory with short expiry |
| Revocation | Immediate on run end, agent kill, or budget exhaustion |
| Value if stolen | None outside the VPC — the broker has no public route and validates source |

Sentinel validation is constant-time, and a failure is logged with the presenting agent's identity
before the request is dropped. Repeated failures from one agent are a signal, and they raise an
alert rather than being silently rate-limited.

### 3.3 Substitution

On a valid sentinel, the broker strips the inbound auth header entirely and attaches the real
credential for the upstream. **It never echoes a credential, a credential fragment, or a
credential-derived error body back toward the sandbox.** Upstream 401/403 responses are rewritten
into a generic `502 upstream_auth_failed` — an attacker must not be able to use the gateway as an
oracle for probing key validity.

Streaming responses (SSE) proxy through unbuffered. The broker parses only enough of the stream to
extract token usage for budget accounting.

### 3.4 Bedrock: the better default on AWS

Direct provider keys mean a long-lived secret exists *somewhere* — in Secrets Manager, in the
broker's memory, in a rotation runbook. Amazon Bedrock removes it:

1. Sandbox sends `anthropic-messages` format to the broker with a sentinel. Unchanged — Pi does not
   know or care what backend is behind the gateway.
2. Broker validates, translates to the Bedrock **Converse / ConverseStream** API, and **signs with
   SigV4 using its own ECS task role**.
3. IAM policy on that role is the authorization boundary: which models, which regions, and
   (via condition keys) under what constraints.

Converse rather than per-model `InvokeModel` payloads, deliberately: Converse is model-agnostic and
normalizes tool use across the whole catalog, so one translation (`anthropic-messages` → Converse)
covers every model rather than one adapter per family. Pi's agent loop depends entirely on tool
calling, and a uniform tool-call shape is what makes swapping models a config change.

No model API key exists in the system at all. Rotation becomes an IAM concern. Per-run attribution
lands in CloudTrail for free. **This is the recommended default**; direct-key support exists for
models Bedrock doesn't carry, and it is the same code path with a different credential resolver.

#### Open-weight models

Choosing Bedrock does not narrow the model lineup. As of early 2026 the serverless catalog carries
roughly two dozen managed open-weight models — Llama, Mistral (Ministral, Large 3, Magistral),
DeepSeek V3.2, the Qwen3 family including Qwen3 Coder, OpenAI's gpt-oss, Gemma, Nemotron, and
others — alongside the frontier models. Beyond that, Bedrock Marketplace deploys models to managed
endpoints, and **Custom Model Import** runs your own weights serverlessly for supported
architectures (Llama, Mistral, Qwen, gpt-oss), currently in `us-east-1`, `us-west-2`, and
`eu-central-1`.

All of it is reached through the same SigV4-signed Converse call, which means the credential-free
property holds for open-weight models exactly as it does for frontier ones.

The practical caveat is capability, not availability: **open-weight models vary widely in tool-calling
reliability**, and an agent loop that mis-calls tools fails in expensive, hard-to-debug ways. This
argues for a mixed fleet rather than a single model choice — a strong model for the orchestrator and
architect roles, where a bad plan costs a whole fan-out, and cheaper open-weight models for narrow,
well-specified worker roles. `orc.yaml` already sets `model` per role, so this is a policy decision
per role and not an architectural one. Validate any open-weight model against the real tool schemas
before trusting it in a worker role; the recorded-session test harness (plugin-api.md §7) is the
cheap way to do that.

### 3.5 Budget enforcement

The broker sees every token in both directions, which makes it the only correct place to enforce
spend. Per-run counters in DynamoDB, updated per response. When a run crosses `limits.usd_budget`,
its sentinels are revoked and in-flight requests are allowed to drain. The run halts and reports —
it does not degrade quietly to a cheaper model, which would produce a confusing result rather than
an honest failure.

---

## 4. Egress gateway

Model traffic is a narrow, well-understood path. Everything else an agent does — `git clone`,
`npm install`, `pip download`, an arbitrary `curl` in a bash tool — is the hard part.

### 4.1 Transport

The sandbox image sets `HTTPS_PROXY=http://broker.orc.internal:8080` and trusts the **orc internal
CA**. Agents issue ordinary HTTP CONNECT. Three outcomes per request:

| Decision | When | Behavior |
| --- | --- | --- |
| **Intercept** | Host is allowlisted *and* needs credential injection or content audit | MITM with a CA-signed leaf, inspect, inject, forward |
| **Passthrough** | Host is allowlisted but pins certificates or requires client mTLS | Blind CONNECT tunnel, host-level allowlist only, logged as uninspected |
| **Deny** | Everything else | `403`, logged with run/agent/host/rule, counted |

Deny is the default and requires no policy entry. Allow always does.

Passthrough is an honest concession: certificate-pinning clients cannot be intercepted, and
pretending otherwise produces mysterious TLS failures that plugin authors will "fix" by disabling
verification. Better to make it an explicit, logged policy decision per host.

### 4.2 Policy evaluation

Per request, against the run's resolved policy bundle (from `orc.yaml` + role + run overrides):

```
allow if  host matches role.egress.allow          (exact or single-label wildcard)
     and  method ∈ role.egress.methods            (default: all)
     and  run is within budget and TTL
     and  requesting agent's identity is valid
deny otherwise
```

Wildcards are single-label only: `*.amazonaws.com` matches `s3.amazonaws.com`, never
`evil.amazonaws.com.attacker.net`. Matching is on the CONNECT target and re-verified against the
TLS SNI and the HTTP `Host` header — a mismatch between any two is a denial and an alert, since
it is a deliberate smuggling attempt, not a mistake.

DNS is resolved **by the broker, not the sandbox**. Sandboxes get a resolver that answers only for
the broker and `orcd`. This closes DNS-tunnel exfiltration, which otherwise walks straight past an
HTTP-layer allowlist.

### 4.3 Credential injection

Policy names a secret and the hosts it may attach to:

```yaml
secrets:
  - { name: GITHUB_TOKEN, scope: [github.com, api.github.com], mode: inject }
  - { name: NPM_TOKEN,    scope: [registry.npmjs.org],         mode: inject }
```

On an intercepted request to an in-scope host, the broker fetches the secret (cached, with a short
TTL) and attaches it in the form that host expects — `Authorization: Bearer` for the GitHub API,
a rewritten URL credential for `git` over HTTPS, `_authToken` for npm. **Scope binding is
absolute**: a request to any host outside a secret's `scope` gets no injection, regardless of what
headers the agent set itself. An agent asking for `github.com` gets the GitHub token; the same
agent asking for `attacker.example` gets a 403 and an audit entry.

Agent-supplied `Authorization` headers to injected hosts are **stripped and replaced**, never
merged. This prevents an agent from smuggling its own values into an authenticated channel.

### 4.4 git, specifically

Git is the most common egress need and the easiest to get wrong. The runner configures:

```
url.https://github.com/.insteadOf = git@github.com:
http.proxy = http://broker.orc.internal:8080
http.sslCAInfo = /etc/orc/ca.pem
```

SSH is disabled in the sandbox image outright — it is a credential-bearing protocol we cannot
inspect or inject at the HTTP layer, and permitting it would create a second, unmanaged egress path.

---

## 5. Identity between planes

Sandboxes authenticate to both the broker and `orcd` with **short-lived mTLS certificates**, issued
by `orcd` at task start and delivered through the ECS task metadata path rather than baked into the
image. Certificate SAN carries `spiffe://orc/run/<run_id>/agent/<agent_id>`.

This gives every request across the plane boundary a cryptographic identity, so the audit log says
*which agent* attempted the denied request — not merely which IP. It also means a stolen sentinel is
useless without the corresponding client certificate, which lives in the runner's memory rather than
on disk.

Certificates are short-lived (1 hour, auto-renewed by the runner) so revocation is a matter of
declining renewal rather than maintaining a CRL.

---

## 6. IAM separation

The isolation model is only as good as the IAM boundary behind it.

| Role | Grants | Explicitly denies |
| --- | --- | --- |
| `orc-sandbox-task` | ECR pull, CloudWatch Logs write | `secretsmanager:*`, `bedrock:*`, `s3:*` on run buckets, `sts:AssumeRole` |
| `orc-broker-task` | `secretsmanager:GetSecretValue` on `orc/*`, `bedrock:InvokeModel*`, DynamoDB on budget/sentinel tables | `s3:*` on workspace buckets, `ecs:*` |
| `orcd-task` | DynamoDB full on run tables, S3 on session/artifact buckets, `ecs:RunTask`/`StopTask`, ECR | `secretsmanager:GetSecretValue` on model/injection secrets |

Note the third row: **`orcd` schedules agents but cannot read the secrets the broker injects.**
Compromising the scheduler does not yield credentials, and compromising the broker does not yield
the ability to schedule arbitrary workloads. Neither component alone is sufficient.

There is no VPC endpoint for Secrets Manager in the agent subnet. Even with a stolen IAM credential,
there is no route from a sandbox to the Secrets Manager API.

---

## 7. Audit

Every broker decision emits a structured record to CloudWatch Logs, batched to S3 for retention:

```json
{
  "ts": "2026-09-11T14:22:31.104Z",
  "run": "run_01J8...", "agent": "agent_impl_api", "role": "backend",
  "gateway": "egress", "decision": "deny", "rule": "not_in_allowlist",
  "method": "CONNECT", "host": "paste.example.com", "port": 443,
  "sni": "paste.example.com", "bytes_in": 0, "bytes_out": 0,
  "identity": "spiffe://orc/run/run_01J8.../agent/agent_impl_api"
}
```

Model-gateway records carry token counts and cost instead of byte counts. Credential *values* never
appear — the secret's *name* does, so an auditor can see that `GITHUB_TOKEN` was injected into a
request to `api.github.com` without the log itself becoming a secret store.

Three alarms matter and should page rather than dashboard:

- Denied-egress rate spiking for one agent — active exfiltration attempt.
- Sentinel validation failures — credential probing.
- SNI / Host / CONNECT-target mismatch — deliberate smuggling. This is never a mistake.

---

## 8. Verification

The security claims above are testable, and M3 does not pass without them passing:

1. **Static sweep.** From inside a live sandbox: dump `environ` for every process, walk the
   filesystem, read the Pi session JSONL. Assert no string matches any real credential.
2. **Hostile plugin.** An orchestration plugin explicitly written to exfiltrate — scan env,
   enumerate metadata endpoints, try DNS tunneling, try SNI/Host mismatch, try `curl` to a
   collector, try to reach Secrets Manager, try to use the sentinel from outside the VPC. Assert
   every attempt fails and every attempt is in the audit log.
3. **Injection scope.** Assert `GITHUB_TOKEN` reaches `api.github.com` and reaches nothing else,
   including hosts that merely resemble it.
4. **Oracle check.** Assert an invalid upstream credential produces `502 upstream_auth_failed`
   inward, with no upstream error body leaking through.
5. **Budget halt.** Assert a run exceeding `usd_budget` stops, and that its sentinels are dead
   immediately afterward.

Test 2 is the real one, and it should be written by someone who did not write the broker.
