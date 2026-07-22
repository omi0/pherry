import SwiftUI

/// The home port: the docked hosts, each a tap away from its live sessions.
///
/// WHY this is the first tab: a host is the unit of the product — you dock one, then steer its
/// sessions. Empty, it teaches the one action that fills it (`pherry dock`, or the dashboard QR);
/// full, it's a calm list of cards. The "+" and the empty-state button open the same pair flow, so
/// adding the second host feels identical to the first.
struct HostsView: View {
    @Environment(AppModel.self) private var model
    @State private var showPairing = false

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                if model.hosts.isEmpty {
                    empty
                } else {
                    list
                }
            }
            .navigationTitle("Hosts")
            .toolbar {
                if !model.hosts.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showPairing = true } label: {
                            Image(systemName: "plus")
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showPairing) {
            PairFlowView(link: nil)
        }
    }

    private var empty: some View {
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

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(model.hosts) { host in
                    NavigationLink {
                        SessionListView(host: host)
                    } label: {
                        HostCard(host: host)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
    }
}

/// One host row — name, pinned-key prefix, and a chevron into its sessions.
private struct HostCard: View {
    let host: PairedHost

    var body: some View {
        Card {
            HStack(spacing: 14) {
                Image(systemName: "ferry.fill")
                    .font(.title2)
                    .foregroundStyle(Theme.accent)
                    .frame(width: 34)
                VStack(alignment: .leading, spacing: 4) {
                    Text(host.name)
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                    MonoChip("key \(host.keyPrefix)…")
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }
        }
    }
}
