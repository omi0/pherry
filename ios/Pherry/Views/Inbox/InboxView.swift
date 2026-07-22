import SwiftUI

/// The attention inbox — the pending nudges an agent raised, newest first.
///
/// WHY it reads from the shared store: the same events drive the tab badge, the push deep-link, and
/// the ring, so the inbox is a thin projection of ``AttentionStore`` rather than its own fetcher.
/// A row shows what happened, the question and its options, and two exits: open the session to steer
/// (P3c) or ack to clear. Tapping an option acks too — answering *into* the session is P3d; today an
/// option tap is just an acknowledgement. Pull-to-refresh and the foreground long-poll keep it live.
struct InboxView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                if model.attention.items.isEmpty {
                    empty
                } else {
                    list
                }
            }
            .navigationTitle("Inbox")
        }
    }

    private var empty: some View {
        Group {
            if model.attention.isLoading {
                ProgressView().tint(Theme.accent)
            } else {
                EmptyState(
                    symbol: "checkmark.circle",
                    title: "All clear",
                    message: "When an agent finishes, blocks, or asks, it surfaces here — and rings if it's urgent."
                )
            }
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(model.attention.items) { item in
                    AttentionRow(item: item, hostName: hostName(for: item))
                        .id(item.id)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .swipeActions(edge: .trailing) {
                            Button {
                                Task { await model.attention.ack(id: item.id) }
                                Haptics.success()
                            } label: {
                                Label("Ack", systemImage: "checkmark")
                            }
                            .tint(Theme.live)
                        }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await model.attention.refresh() }
            .onChange(of: model.pendingEventId) { _, id in
                guard let id else { return }
                withAnimation { proxy.scrollTo(id, anchor: .top) }
                model.pendingEventId = nil
            }
        }
    }

    private func hostName(for item: AttentionItem) -> String {
        model.hosts.first { $0.id == item.hostId }?.name ?? PairedHost.defaultName(for: item.hostId)
    }
}

/// One attention event — urgency, source, the ask, its options, and the two exits.
private struct AttentionRow: View {
    let item: AttentionItem
    let hostName: String

    @Environment(AppModel.self) private var model

    private var title: String {
        switch item.kind {
        case "done": "Agent finished"
        case "blocked": "Agent blocked"
        case "asks": "Agent asks"
        default: item.kind.capitalized
        }
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    UrgencyBadge(urgency: item.urgency)
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text)
                    Spacer()
                    Text(hostName)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                }

                Text(item.summary)
                    .font(.callout)
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)

                if let question = item.question {
                    Text(question)
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let options = item.options, !options.isEmpty {
                    FlowOptions(options: options) { _ in ack() }
                }

                MonoChip(item.sessionRef)

                HStack(spacing: 10) {
                    Button {
                        model.openSession(hostId: item.hostId, sessionRef: item.sessionRef)
                    } label: {
                        Label("Open session", systemImage: "terminal")
                            .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(PherryButtonStyle(prominent: false))

                    Button { ack() } label: {
                        Label("Ack", systemImage: "checkmark")
                            .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(PherryButtonStyle(prominent: false))
                }
                .padding(.top, 2)
            }
        }
    }

    private func ack() {
        Task { await model.attention.ack(id: item.id) }
        Haptics.success()
    }
}

/// The offered answers as a wrapping row of chips. Tapping one acks (P3c) — answering into the
/// session lands in P3d.
private struct FlowOptions: View {
    let options: [String]
    let onTap: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                Button { onTap(option) } label: {
                    Text(option)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Theme.accent.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
