import Foundation

/// One project a host offers to launch in — mirrors the wire's `launch.options` result
/// `projects` items exactly (leg-P3e's constrained remote launch).
///
/// `id` is the stable, opaque handle (sha256 of the path, first 16 hex chars) — the only
/// thing a controller ever sends back. `path` is **display only** on the controller; the
/// host never accepts it back.
public struct LaunchProject: Sendable, Equatable, Identifiable {
    /// The stable, opaque project id — what `launchStart` sends back. Also the `Identifiable` id.
    public let id: String
    /// The display name (the path's basename on the host).
    public let name: String
    /// The project's path on the host — display only, never accepted back.
    public let path: String

    /// Build a project option.
    public init(id: String, name: String, path: String) {
        self.id = id
        self.name = name
        self.path = path
    }
}

/// One model an agent offers, by opaque id and display name — mirrors the wire's
/// `LaunchModel` exactly. The host always lists `default` first (no model flag).
public struct LaunchModel: Sendable, Equatable, Identifiable {
    /// The opaque model id — what `launchStart` sends back (absent means `default`).
    public let id: String
    /// The display name.
    public let name: String

    /// Build a model option.
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// One agent detected on the host's PATH, with its curated models — mirrors the wire's
/// `LaunchAgent` exactly. (Named `LaunchAgentOption` on this side to keep the app's
/// namespace clear of `Agent`-ish clashes.)
public struct LaunchAgentOption: Sendable, Equatable, Identifiable {
    /// The agent id (`claude` / `codex` / `kimi` / …) — what `launchStart` sends back.
    public let id: String
    /// The display name.
    public let name: String
    /// The models this agent offers; `models[0]` is always the default.
    public let models: [LaunchModel]
    /// Whether this agent's CLI can take a starting prompt at all. Absent on the wire
    /// means `true`; the host sends `false` for a CLI with no interactive-with-prompt
    /// form (and refuses a prompt aimed at one), so the picker hides the prompt field.
    public let promptSupported: Bool

    /// Build an agent option.
    public init(id: String, name: String, models: [LaunchModel], promptSupported: Bool = true) {
        self.id = id
        self.name = name
        self.models = models
        self.promptSupported = promptSupported
    }
}

/// The host's constrained-launch allowlists — its boarded projects and PATH-detected
/// agents, exactly as `launch.options` answers them. The controller picks **ids only**
/// from these lists; the host joins them against its own current lists on `launch.start`.
public struct LaunchOptions: Sendable, Equatable {
    /// The projects the host offers (its boarded directories).
    public let projects: [LaunchProject]
    /// The agents detected on the host's PATH.
    public let agents: [LaunchAgentOption]

    /// Build a launch-options set.
    public init(projects: [LaunchProject], agents: [LaunchAgentOption]) {
        self.projects = projects
        self.agents = agents
    }
}
