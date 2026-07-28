import Foundation
import PherryKit

/// One live session with its host attached — the row the Sessions tab renders.
///
/// WHY it exists: the wire's `SessionSummary` is host-relative (a host only lists *its own*
/// sessions), but the sessions-first tab shows every host's sessions in one list — so each row
/// must carry whose host it came from, both to open it (`openSession(hostId:sessionRef:)`) and
/// to say so in the subtitle.
struct AggregatedSession: Identifiable, Equatable {
    /// The host that owns the session (the ticket subject for opening it).
    let hostId: String
    /// The host's user-facing label at aggregation time.
    let hostName: String
    /// The session as the host listed it.
    let summary: SessionSummary

    /// Stable across refreshes: a `sessionRef` is host-scoped, so the pair is globally unique.
    var id: String { "\(hostId)/\(summary.sessionRef)" }

    /// The row title — the agent. `argv[0]` is the *resolved* binary (often a long path);
    /// the human answer to "what is this session?" is `claude`, not where claude lives.
    var title: String { Self.title(argv: summary.argv) }

    /// The row subtitle — whose host, and where on it: `<host name> · <cwd basename>`.
    var subtitle: String { Self.subtitle(hostName: hostName, cwd: summary.cwd) }

    /// The last path component of `argv.first`, or `"session"` when the argv is empty.
    static func title(argv: [String]) -> String {
        guard let command = argv.first, !command.isEmpty else { return "session" }
        return command.split(separator: "/").last.map(String.init) ?? command
    }

    /// `<hostName> · <cwd last component>` (the whole cwd when it has no components, e.g. `/`).
    static func subtitle(hostName: String, cwd: String) -> String {
        let directory = cwd.split(separator: "/").last.map(String.init) ?? cwd
        return "\(hostName) · \(directory)"
    }

    /// Manual `==`: `SessionSummary` (a PherryKit type) declares no `Equatable`, so compare its
    /// wire fields here rather than re-declaring anything in the frozen kit.
    static func == (lhs: AggregatedSession, rhs: AggregatedSession) -> Bool {
        lhs.hostId == rhs.hostId
            && lhs.hostName == rhs.hostName
            && lhs.summary.sessionRef == rhs.summary.sessionRef
            && lhs.summary.argv == rhs.summary.argv
            && lhs.summary.cwd == rhs.summary.cwd
            && lhs.summary.cols == rhs.summary.cols
            && lhs.summary.rows == rhs.summary.rows
            && lhs.summary.subscribers == rhs.summary.subscribers
    }
}

/// The selected pill: everything, or one host's sessions.
enum SessionFilter: Equatable, Hashable {
    case all
    case host(String)
}

/// The Sessions tab's state: control-plane liveness per paired host, the aggregated live
/// sessions across every online host, and the selected pill filter.
///
/// WHY a store: the tab composes three sources — the paired hosts the model persists, the
/// control plane's `lastSeenAt` liveness (the dashboard's 90 s rule, adopted verbatim), and a
/// per-online-host `sessions.list` fan-out over one-shot E2EE dials. Degradation is the design:
/// a liveness fetch failure renders every host unknown/offline (the tab still shows them), and
/// a single host's failed dial marks *that host* offline without failing the refresh. The
/// fetchers are injected closures (defaulting to the real control plane + `HostConnection`), so
/// the pure logic below is unit-testable with no networking.
@MainActor
@Observable
final class SessionsStore {
    /// A host is online iff the control plane saw it within this many seconds — the dashboard's
    /// `LIVENESS_WINDOW_MS` rule, adopted verbatim.
    nonisolated static let livenessWindow: TimeInterval = 90

    /// `hostId → online` from the last liveness fetch; a missing key is unknown (shown offline).
    private(set) var liveness: [String: Bool] = [:]
    /// Every live session across every online host, in a stable host-then-ref order.
    private(set) var sessions: [AggregatedSession] = []
    /// Whether a refresh is in flight with nothing yet loaded (the first-load spinner).
    private(set) var isLoading = false
    /// The selected pill.
    var filter: SessionFilter = .all

    /// The rows the selected pill admits.
    var filtered: [AggregatedSession] { Self.apply(filter: filter, to: sessions) }

    /// The control-plane liveness fetch — `(apiUrl, deviceToken) → HostSummary` rows.
    typealias HostsFetcher = @Sendable (URL, String) async throws -> [ControlPlaneClient.HostSummary]
    /// One host's one-shot session listing — dial, list, close (never held open for a list).
    typealias HostSessionsFetcher =
        @Sendable (URL, String, PairedHost, any DeviceSigner) async throws -> [SessionSummary]

    private let fetchHosts: HostsFetcher
    private let fetchHostSessions: HostSessionsFetcher
    private let now: @Sendable () -> Date

    /// Create the store. The defaults are the real fetchers; tests inject scripted closures and
    /// a fixed clock so the liveness math is deterministic.
    init(
        fetchHosts: @escaping HostsFetcher = { apiUrl, deviceToken in
            try await ControlPlaneClient(apiUrl: apiUrl).listHosts(deviceToken: deviceToken)
        },
        fetchHostSessions: @escaping HostSessionsFetcher = { apiUrl, deviceToken, host, signer in
            // Listing is a one-shot question, exactly the old per-host list's discipline:
            // dial, take the connect-time listing (the reply that proved the pin), close.
            let connection = try await HostConnection.connect(
                apiUrl: apiUrl,
                deviceToken: deviceToken,
                hostId: host.id,
                pinnedHostStatic: host.staticPublicKey,
                deviceSigner: signer
            )
            let sessions = connection.sessions
            await connection.close()
            return sessions
        },
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.fetchHosts = fetchHosts
        self.fetchHostSessions = fetchHostSessions
        self.now = now
    }

    /// One full refresh: liveness for every paired host, then a parallel session fan-out to the
    /// online ones. Never throws — every failure degrades (see the type comment).
    func refresh(
        hosts: [PairedHost],
        apiUrl: URL?,
        deviceToken: String?,
        deviceSigner: any DeviceSigner
    ) async {
        // A pill pointing at an unpaired host filters everything forever — snap back to All.
        if case let .host(id) = filter, !hosts.contains(where: { $0.id == id }) {
            filter = .all
        }
        guard let apiUrl, let deviceToken, !hosts.isEmpty else {
            liveness = [:]
            sessions = []
            return
        }
        isLoading = sessions.isEmpty
        defer { isLoading = false }

        // 1. Control-plane liveness. A failed fetch leaves every host unknown/offline — the tab
        //    still renders the paired hosts, it just doesn't dial any of them.
        var live: [String: Bool]
        do {
            let summaries = try await fetchHosts(apiUrl, deviceToken)
            let lastSeen = Dictionary(
                summaries.map { ($0.id, $0.lastSeenAt) }, uniquingKeysWith: { first, _ in first }
            )
            live = Self.liveness(paired: hosts, lastSeen: lastSeen, now: now())
        } catch {
            live = [:]
        }

        // 2. Fan the one-shot dials out to the online hosts in parallel. A host whose dial
        //    fails degrades to offline and contributes no rows; the refresh itself never fails.
        let online = hosts.filter { live[$0.id] == true }
        var rows: [AggregatedSession] = []
        let fetch = fetchHostSessions
        await withTaskGroup(of: (hostId: String, rows: [AggregatedSession]?).self) { group in
            for host in online {
                group.addTask {
                    do {
                        let summaries = try await fetch(apiUrl, deviceToken, host, deviceSigner)
                        return (host.id, summaries.map {
                            AggregatedSession(hostId: host.id, hostName: host.name, summary: $0)
                        })
                    } catch {
                        return (host.id, nil)
                    }
                }
            }
            for await (hostId, hostRows) in group {
                if let hostRows {
                    rows.append(contentsOf: hostRows)
                } else {
                    live[hostId] = false
                }
            }
        }
        liveness = live
        sessions = Self.sorted(rows)
    }

    // MARK: - Pure logic (unit-tested without networking)

    /// The liveness rule: seen within ``livenessWindow`` of `now`. Never seen → offline.
    nonisolated static func isOnline(lastSeenAt: Date?, now: Date) -> Bool {
        guard let lastSeenAt else { return false }
        return now.timeIntervalSince(lastSeenAt) <= livenessWindow
    }

    /// Liveness per **paired** host from the control plane's `lastSeenAt` map. Every paired host
    /// gets an entry; one the control plane didn't mention is offline.
    nonisolated static func liveness(
        paired: [PairedHost], lastSeen: [String: Date?], now: Date
    ) -> [String: Bool] {
        var result: [String: Bool] = [:]
        for host in paired {
            result[host.id] = isOnline(lastSeenAt: lastSeen[host.id] ?? nil, now: now)
        }
        return result
    }

    /// The pill filter as a pure function: `.all` admits everything, `.host` one host's rows.
    nonisolated static func apply(
        filter: SessionFilter, to sessions: [AggregatedSession]
    ) -> [AggregatedSession] {
        switch filter {
        case .all: sessions
        case let .host(id): sessions.filter { $0.hostId == id }
        }
    }

    /// A stable order — by host name, then session ref — so a refresh never shuffles the list.
    nonisolated static func sorted(_ rows: [AggregatedSession]) -> [AggregatedSession] {
        rows.sorted {
            ($0.hostName, $0.summary.sessionRef) < ($1.hostName, $1.summary.sessionRef)
        }
    }
}
