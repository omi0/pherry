import PherryKit
import SwiftUI

/// A host's live sessions, reached over the wire.
///
/// WHY it connects then closes: listing is a one-shot question — mint a ticket, dial the cell,
/// authenticate, `sessions.list`, done. Holding the channel open for a passive list would burn a
/// relay bridge for nothing, so this closes it and re-connects on pull-to-refresh. Tapping a row
/// hands off to the terminal, which makes its *own* live connection (a push or a ring answer opens
/// the same terminal with no list in the path, so the terminal must stand alone).
struct SessionListView: View {
    let host: PairedHost

    @Environment(AppModel.self) private var model
    @State private var phase: LoadPhase<[SessionSummary]> = .idle

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            AsyncStateView(phase: phase, retry: { Task { await load() } }) { sessions in
                if sessions.isEmpty {
                    EmptyState(
                        symbol: "terminal",
                        title: "No live sessions",
                        message: "Board a repo on this host, then launch an agent — it appears here."
                    ) {
                        MonoChip("pherry board", color: Theme.text)
                    }
                } else {
                    listBody(sessions)
                }
            }
        }
        .navigationTitle(host.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { if case .idle = phase { await load() } }
    }

    private func listBody(_ sessions: [SessionSummary]) -> some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(sessions) { session in
                    Button {
                        model.openSession(hostId: host.id, sessionRef: session.sessionRef)
                    } label: {
                        SessionRow(session: session)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
        .refreshable { await load() }
    }

    private func load() async {
        guard let apiUrl = model.apiUrl, let token = model.deviceToken else {
            phase = .failed("This device isn't paired.")
            return
        }
        phase = .loading
        do {
            let connection = try await HostConnection.connect(
                apiUrl: apiUrl,
                deviceToken: token,
                hostId: host.id,
                pinnedHostStatic: host.staticPublicKey
            )
            let sessions = connection.sessions
            await connection.close()
            phase = .loaded(sessions)
        } catch let error as HostConnectionError {
            phase = .failed(error.errorDescription ?? "Couldn't reach the host.")
        } catch {
            phase = .failed("Couldn't reach the host.")
        }
    }
}

/// One session row — the agent, its working directory, the ref, and a liveness dot.
private struct SessionRow: View {
    let session: SessionSummary

    private var agent: String { session.argv.first ?? "session" }

    var body: some View {
        Card {
            HStack(spacing: 12) {
                StatusDot(color: Theme.live)
                VStack(alignment: .leading, spacing: 6) {
                    Text(agent)
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                    Text(session.cwd)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HStack(spacing: 8) {
                        MonoChip(session.sessionRef)
                        Text("\(session.cols)×\(session.rows)")
                            .font(.mono(11))
                            .foregroundStyle(Theme.muted)
                        if session.subscribers > 0 {
                            Label("\(session.subscribers)", systemImage: "eye")
                                .font(.mono(11))
                                .foregroundStyle(Theme.muted)
                        }
                    }
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }
        }
    }
}
