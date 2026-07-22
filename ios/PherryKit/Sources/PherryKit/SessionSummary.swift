import Foundation

/// One live session in a host's listing — mirrors `sessions_list.result` items exactly.
///
/// `id` is the `sessionRef`, so a `SessionSummary` is directly `Identifiable` for SwiftUI lists.
public struct SessionSummary: Sendable, Codable, Identifiable {
    /// The session reference a controller subscribes to. Also the `Identifiable` id.
    public let sessionRef: String
    /// Current terminal width in character cells (1–1000).
    public let cols: Int
    /// Current terminal height in character cells (1–1000).
    public let rows: Int
    /// The verbatim command the session runs.
    public let argv: [String]
    /// The session's realpath working directory.
    public let cwd: String
    /// How many viewers are currently subscribed.
    public let subscribers: Int

    /// `Identifiable` conformance — the session reference is the stable id.
    public var id: String { sessionRef }

    /// Build a session summary.
    public init(sessionRef: String, cols: Int, rows: Int, argv: [String], cwd: String, subscribers: Int) {
        self.sessionRef = sessionRef
        self.cols = cols
        self.rows = rows
        self.argv = argv
        self.cwd = cwd
        self.subscribers = subscribers
    }
}

/// A decoded terminal event delivered to a subscribed controller.
///
/// The host speaks binary PTY frames; ``ControllerClient`` turns that stream into this small,
/// closed set of semantic events. The snapshot arrives on the wire as start + N chunks + end
/// and is reassembled into a single `snapshot` carrying the full serialized-ANSI bytes.
public enum PtyEvent: Sendable, Equatable {
    /// The reassembled full-screen snapshot bytes.
    case snapshot(Data)
    /// Incremental terminal output bytes.
    case output(Data)
    /// The terminal was resized.
    case resized(cols: Int, rows: Int)
    /// The session ended, carrying the exit code (or `nil` when killed by a signal).
    case ended(code: Int?)
    /// A sequence gap was detected (frames were dropped).
    case gap
}
