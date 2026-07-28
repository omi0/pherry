import PherryKit
import SwiftUI

/// The sessions-first home tab: every live session across every paired host in one list,
/// filtered by a row of host pills, with the dock flow behind the `+` pill and remote launch
/// behind the floating `+`.
///
/// WHY sessions-first: the thing the user steers is a session, not a host — hosts are just
/// where sessions live. The pills keep the per-host view one tap away (with liveness at a
/// glance), while the default answer to "what's running?" is everything. Empty, the tab teaches
/// the one action that fills it (`pherry dock` when no host is paired; the `+` / `pherry board`
/// once one is). Tapping a row hands off to `model.openSession`, which presents the terminal
/// from the root — the same path a push or a ring answer takes, so deep links keep working.
struct SessionsView: View {
    @Environment(AppModel.self) private var model
    @State private var store = SessionsStore()
    @State private var showPairing = false
    @State private var showCreate = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                if model.hosts.isEmpty {
                    emptyNoHosts
                } else {
                    content
                    floatingCreateButton
                }
            }
            .navigationTitle("Sessions")
        }
        .sheet(isPresented: $showPairing) {
            PairFlowView(link: nil)
        }
        .sheet(isPresented: $showCreate, onDismiss: {
            // A launch (or even a cancelled sheet after a long think) deserves fresh rows.
            Task { await refresh() }
        }) {
            CreateSessionSheet(filter: store.filter, liveness: store.liveness)
        }
        // Runs on first appearance and again whenever the paired-host set changes (a fresh dock
        // shows up without a manual pull).
        .task(id: model.hosts) { await refresh() }
    }

    // MARK: - Content

    private var content: some View {
        VStack(spacing: 0) {
            pillRow
            if store.isLoading {
                VStack(spacing: 12) {
                    ProgressView().tint(Theme.accent)
                    Text("Reaching…").font(.footnote).foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.filtered.isEmpty {
                emptyNoSessions
            } else {
                sessionList
            }
        }
    }

    private var sessionList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(store.filtered) { session in
                    Button {
                        model.openSession(hostId: session.hostId, sessionRef: session.summary.sessionRef)
                    } label: {
                        SessionCard(session: session)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
            // Keep the last row reachable above the floating button.
            .padding(.bottom, 72)
        }
        .refreshable { await refresh() }
    }

    // MARK: - Pills

    private var pillRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                FilterPill(label: "All", isSelected: store.filter == .all) {
                    store.filter = .all
                }
                ForEach(model.hosts) { host in
                    FilterPill(
                        label: host.name,
                        dotColor: store.liveness[host.id] == true ? Theme.live : Theme.muted,
                        isSelected: store.filter == .host(host.id)
                    ) {
                        store.filter = .host(host.id)
                    }
                }
                // The `+` pill — dock another host, the same flow as the very first one.
                Button {
                    showPairing = true
                } label: {
                    Image(systemName: "plus")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Theme.surface2, in: Capsule())
                        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dock a host")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    // MARK: - Empty states

    /// No host docked at all — teach the one action that fills the app (the old Hosts empty).
    private var emptyNoHosts: some View {
        EmptyState(
            symbol: "ferry",
            title: "Dock a host to begin",
            message: "Run the command below, or scan the dashboard's Pair phone QR."
        ) {
            VStack(spacing: 14) {
                MonoChip("pherry dock", color: Theme.text)
                Button("Dock a host") { showPairing = true }
                    .buttonStyle(PherryButtonStyle())
            }
        }
    }

    /// Hosts exist but nothing is live (under the current pill).
    private var emptyNoSessions: some View {
        ScrollView {
            EmptyState(
                symbol: "terminal",
                title: "No live sessions",
                message: "Start one with the + button below, or board a repo on a host and launch an agent there."
            ) {
                MonoChip("pherry board", color: Theme.text)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
        }
        .refreshable { await refresh() }
    }

    // MARK: - The floating launch button

    private var floatingCreateButton: some View {
        Button {
            showCreate = true
        } label: {
            Image(systemName: "plus")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Theme.accent, in: Circle())
                .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
        }
        .accessibilityLabel("New session")
        // Bottom-trailing, inside the safe area — the tab bar already insets it.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .padding(.trailing, 20)
        .padding(.bottom, 16)
    }

    // MARK: - Refresh

    private func refresh() async {
        await store.refresh(
            hosts: model.hosts,
            apiUrl: model.apiUrl,
            deviceToken: model.deviceToken,
            deviceSigner: model.deviceSigner
        )
    }
}

/// One capsule filter pill — selected reads accent-tinted (the `UrgencyBadge` treatment),
/// unselected a bordered raised chip; a host pill carries its liveness dot.
private struct FilterPill: View {
    let label: String
    var dotColor: Color?
    let isSelected: Bool
    let action: () -> Void

    init(label: String, dotColor: Color? = nil, isSelected: Bool, action: @escaping () -> Void) {
        self.label = label
        self.dotColor = dotColor
        self.isSelected = isSelected
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let dotColor {
                    StatusDot(color: dotColor)
                }
                Text(label)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(isSelected ? Theme.accent : Theme.muted)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                isSelected ? AnyShapeStyle(Theme.accent.opacity(0.14)) : AnyShapeStyle(Theme.surface2),
                in: Capsule()
            )
            .overlay {
                if !isSelected {
                    Capsule().strokeBorder(Theme.border, lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// One aggregated session row — the agent, whose host and where, the ref, and a liveness dot.
private struct SessionCard: View {
    let session: AggregatedSession

    var body: some View {
        Card {
            HStack(spacing: 12) {
                StatusDot(color: Theme.live)
                VStack(alignment: .leading, spacing: 6) {
                    Text(session.title)
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                    Text(session.subtitle)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HStack(spacing: 8) {
                        MonoChip(session.summary.sessionRef)
                        Text("\(session.summary.cols)×\(session.summary.rows)")
                            .font(.mono(11))
                            .foregroundStyle(Theme.muted)
                        if session.summary.subscribers > 0 {
                            Label("\(session.summary.subscribers)", systemImage: "eye")
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
