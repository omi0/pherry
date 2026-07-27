# Pherry — the architecture map

The whole system on one page: what runs where, every arrow, and the trust boundaries.
Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the full design); this file is the
drawable/diagrammable version. One sentence of orientation: **all user compute stays on user
hardware — the cloud is a thin rendezvous layer that routes metadata and splices ciphertext.**

## The component map

```mermaid
flowchart LR
  subgraph LAPTOP["💻 LAPTOP — the user's machine (all compute lives here)"]
    AGENT["Agent TUI<br/>claude · gemini · codex …"]
    SHIM["PATH shim<br/>(pherry board)"]
    DAEMON["Host daemon — pherry serve<br/>owns every PTY · Mirror · enrollment keyring<br/>host static key · audit.log"]
    LOCAL["Local terminal viewer<br/>(subscriber #1 — no privilege)"]
    CLI["CLI<br/>pherry dock · devices · attention"]
  end

  subgraph PHONE["📱 iPHONE — the other endpoint"]
    APP["SwiftUI app<br/>Hosts · Sessions · SwiftTerm · Inbox"]
    KIT["PherryKit<br/>the wire in Swift (vector-proven)"]
    SE["DeviceIdentity + PresenceSession<br/>Secure Enclave P-256 · Face ID per foreground session"]
  end

  subgraph CLOUD["☁️ CLOUD — thin rendezvous, no user compute"]
    CP["Control plane<br/>identity · pairing · tickets<br/>attention routing · audit log"]
    RELAY["Relay cell(s)<br/>blind TCP splice :9443<br/>ciphertext only — stateless"]
    PG[("Postgres")]
    RD[("Redis")]
  end

  subgraph THIRD["Third parties"]
    APNS["Apple APNs"]
    CLERK["Clerk — identity<br/>(behind a swappable seam)"]
  end

  BROWSER["🖥️ Browser dashboard<br/>approve dock · hosts/devices · inbox · Log"]

  SHIM -->|spawn under custody| DAEMON
  AGENT <-->|PTY bytes| DAEMON
  LOCAL <-->|unix socket: subscribe · input<br/>custody is local-only| DAEMON
  CLI <-->|unix socket: admin| DAEMON

  DAEMON -->|persistent TCP dial-out<br/>host proof · waits for bridges| RELAY
  DAEMON -->|HTTPS heartbeats| CP
  CLI -->|HTTPS: register host · mint pair QR| CP

  APP -->|HTTPS: redeem QR → device token + pinned host key<br/>tickets · inbox · push tokens| CP
  APP -->|TCP: conn-open + one-time ticket| RELAY

  APP <==>|"🔒 E2EE tunnel (through the splice)<br/>Noise-NK, host key pinned from QR<br/>+ Hello signed by Secure Enclave (= Face ID)"| DAEMON

  RELAY -.->|private internal API<br/>validate + consume tickets| CP
  CP --- PG
  CP --- RD
  CP -->|alert + VoIP push| APNS
  APNS -->|push| APP
  CP <-.-> CLERK
  BROWSER -->|HTTPS, human token| CP

  KIT --- APP
  SE --- KIT
```

## The boxes — what each component does

### 💻 Laptop (user's machine)

| Component | Role |
|---|---|
| **Agent TUI** | The coding agent itself, launched by typing its name. |
| **PATH shim** (`pherry board`) | Intercepts the launch, hands it to the daemon → the session is born under custody. |
| **Host daemon** (`pherry serve`) | The heart. Owns every PTY (invariant: viewers are equal subscribers). Runs the Mirror, enforces device enrollment (keyring of enrolled phone keys), writes the local audit log, holds the host static key. Remote surface is **steer-only**: list · subscribe · input · resize — custody actions never leave the unix socket. |
| **Local terminal viewer** | The user's own terminal — subscriber #1, no privilege over the phone. |
| **CLI** | Onboarding + admin: `dock` (registration + pairing ceremony), `devices` (enrollment, revoke, audit tail), `attention`. |

### 📱 iPhone

| Component | Role |
|---|---|
| **SwiftUI app** | The controller UI; terminal rendered in SwiftTerm. |
| **PherryKit** | The wire in Swift: E2EE channel (Noise-NK initiator), protocol, device auth — conformance-vector-proven equal to the TS implementation. |
| **DeviceIdentity + PresenceSession** | Secure Enclave P-256 key; every signature demands user presence, supplied once per foreground session (Face ID at the door, silence inside, relock on leaving). |
| **Keychain / PushKit / CallKit** | Device token + pinned host keys; APNs alert and VoIP-ring reception. |

### ☁️ Cloud (the only part you host)

| Component | Role |
|---|---|
| **Control plane** | Router, never the content: identity (Clerk behind `IdentityProvider`), orgs/users, host registration + revocation, pair-QR mint/redeem, **one-time relay tickets**, attention routing (in-app · push · ring), append-only audit log, dashboard API. Internal API on a **private listener**, relay-only. |
| **Relay cell(s)** | The blind rendezvous: both sides dial out to it, it validates tickets + host MACs and splices the two sockets. Stateless, horizontal, sees **ciphertext only**. ~tens of KB RAM per online host (the persistent dial-out is the NAT escape). |
| **Postgres / Redis** | Control-plane state / one-time tickets (atomic GETDEL) + rate limits. |

### Third parties

| Component | Role |
|---|---|
| **Apple APNs** | Delivers alert + VoIP pushes. Free. |
| **Clerk** | Human sign-in, behind a seam — swappable without touching the product. |

### 🖥️ Browser dashboard

Sign-in, the dock **approval page**, hosts/sessions/devices, attention inbox, pair-QR modal,
the audit **Log** tab.

## Trust boundaries (the two dashed lines worth drawing)

1. **Around the E2EE tunnel** — session content exists only at the two endpoints. The relay
   splices ciphertext; the control plane routes metadata. Nothing in the cloud can read a byte
   of a terminal.
2. **Around pairing** — the host key pins from the QR (never from the server), and enrollment
   is a **human-to-human fingerprint comparison** (phone screen vs. terminal, answered `y` on
   the host). The control plane is outside the trust loop even for key exchange: a malicious
   server can neither MITM a session nor enroll a device.

## The three flows

```mermaid
sequenceDiagram
    autonumber
    participant T as Laptop (CLI + daemon)
    participant B as Browser
    participant CP as Control plane
    participant R as Relay
    participant P as iPhone
    participant A as APNs

    rect rgb(235, 245, 235)
    Note over T,P: ① PAIRING — the trust ceremony
    T->>CP: pherry dock — register host, mint pair token
    CP->>B: 302 → approval page
    B->>CP: Approve (human token)
    CP-->>T: one-time code → QR printed in terminal
    P->>CP: scan QR → redeem (device pubkey rides along)
    CP-->>P: device token + pinned host key
    Note over T,P: fingerprints compared by the human — terminal vs phone → "y" enrolls
    end

    rect rgb(235, 240, 250)
    Note over T,P: ② STEER — continue the session anywhere
    P->>CP: mint one-time relay ticket
    P->>R: conn-open { ticket }
    R->>CP: validate + consume (internal API)
    T->>R: host data-dial (MAC-bound)
    R-->>R: splice — ciphertext only from here
    P->>T: Noise-NK (pinned host key) + Hello signed by Secure Enclave (Face ID)
    T-->>P: session mirror — subscribe · input · resize
    end

    rect rgb(250, 240, 230)
    Note over T,A: ③ ATTENTION — the agent needs a human
    T->>CP: raise (kind, summary — host-authored metadata only)
    CP->>A: route → alert push (or VoIP ring)
    A->>P: notification
    P->>CP: retrieve · ack
    Note over P: tap → flow ② into the session
    end
```

## Where cost lives (for the ops-minded reader)

Per **online** host: one idle TCP socket on a relay cell (~30 KB RAM) + a heartbeat row-update
every couple of minutes. Terminal bytes are a few KB/s while actively mirrored — egress is a
rounding error. The scaling axes, in order: relay-cell RAM (add cells), heartbeat write rate
(batch before ~100k hosts), and the identity provider's per-MAU pricing (the seam exists for a
reason).
