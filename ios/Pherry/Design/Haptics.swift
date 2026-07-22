import UIKit

/// Tiny haptic vocabulary — the app speaks touch at exactly three moments the spec calls out:
/// pair success, a ring answered, and an attention ack. Centralised so the *feel* is consistent
/// and so a call site reads as intent (`Haptics.success()`) rather than UIKit ceremony.
@MainActor
enum Haptics {
    /// A crisp success thunk — pairing landed, an ack cleared.
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// A soft confirming tap — answering a ring, a lighter acknowledgement.
    static func tap() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// A warning buzz — a destructive confirm (unpair) or a failed reach.
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
