import SwiftUI

/// The shared, small view vocabulary — the pieces every screen reuses so the surfaces read as
/// one system: calm empty states, a status dot, a mono chip for ids, and a uniform
/// loading/error/retry envelope. Keeping them here (rather than re-inventing per screen) is what
/// makes the polish consistent instead of accidental.

/// A card container — the raised surface every row and panel sits on.
struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .strokeBorder(Theme.border, lineWidth: 1)
            )
    }
}

/// A monospaced pill for a ref / id / command — the "this is machine text" signal.
struct MonoChip: View {
    let text: String
    var color: Color = Theme.muted

    init(_ text: String, color: Color = Theme.muted) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(.mono(12))
            .foregroundStyle(color)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
    }
}

/// A small filled circle used for liveness / status. Green = live, muted = idle, danger = gone.
struct StatusDot: View {
    var color: Color = Theme.live
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
    }
}

/// The calm empty state every list owes the user: an icon, one sentence, and the action that
/// fills it. WHY a component: an empty screen is a design surface, not an absence — this makes
/// sure each one gets the same considered treatment.
struct EmptyState<Action: View>: View {
    let symbol: String
    let title: String
    let message: String
    @ViewBuilder var action: Action

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(Theme.accent)
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text(message)
                .font(.callout)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            action
                .padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: 380)
    }
}

extension EmptyState where Action == EmptyView {
    init(symbol: String, title: String, message: String) {
        self.init(symbol: symbol, title: title, message: message) { EmptyView() }
    }
}

/// The three states of any async surface — loading, failed (with retry), or loaded — in one
/// envelope so no screen forgets the sad paths. `Loaded` renders on success; `retry` re-runs the
/// fetch on failure.
struct AsyncStateView<Value, Loaded: View>: View {
    let phase: LoadPhase<Value>
    let retry: () -> Void
    @ViewBuilder var loaded: (Value) -> Loaded

    var body: some View {
        switch phase {
        case .idle, .loading:
            VStack(spacing: 12) {
                ProgressView().tint(Theme.accent)
                Text("Reaching…").font(.footnote).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(Theme.danger)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                Button("Try again", action: retry)
                    .buttonStyle(PherryButtonStyle())
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .loaded(value):
            loaded(value)
        }
    }
}

/// A generic three-way load phase for an async fetch.
enum LoadPhase<Value> {
    case idle
    case loading
    case loaded(Value)
    case failed(String)
}

/// The app's primary button — a filled indigo pill. One style so every call-to-action matches.
struct PherryButtonStyle: ButtonStyle {
    var prominent = true
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(prominent ? Color.white : Theme.accent)
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(
                prominent ? Theme.accent : Theme.surface2,
                in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// A wrapping horizontal layout — chips flow onto the next line when they run out of width. Used
/// for an event's answer options, which are short and arbitrary in count.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rows: [CGFloat] = [0]
        var rowWidth: CGFloat = 0
        var totalHeight: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth + size.width > maxWidth, rowWidth > 0 {
                totalHeight += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
                rows.append(0)
            }
            rowWidth += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        totalHeight += rowHeight
        return CGSize(width: maxWidth == .infinity ? rowWidth : maxWidth, height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// A small urgency badge for the inbox: `call` shouts, `notify` nudges, `digest` whispers.
struct UrgencyBadge: View {
    let urgency: String

    private var label: String {
        switch urgency {
        case "call": "Ring"
        case "notify": "Notify"
        default: "Digest"
        }
    }

    var body: some View {
        Text(label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(0.5)
            .foregroundStyle(Theme.urgencyColor(urgency))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                Theme.urgencyColor(urgency).opacity(0.14),
                in: Capsule()
            )
    }
}
