import PherryKit
import SwiftUI

/// The pure decisions behind the New-session sheet — enablement, wire mappings, and host
/// preselection — kept out of the view so `PherryTests` can pin them with no networking.
///
/// WHY primitives, not view state: each rule is a total function over ids/strings, so the tests
/// (and the view) can never disagree about when Start lights up or what rides the wire.
enum CreateSessionLogic {
    /// Start is enabled exactly when a host, a project, and an agent are chosen. (A model is
    /// never required — the default model is a valid choice, and it maps to a nil `modelId`.)
    static func canStart(hostId: String?, projectId: String?, agentId: String?) -> Bool {
        hostId != nil && projectId != nil && agentId != nil
    }

    /// The wire's `modelId`: the host treats *absent* as "default", so the default (first)
    /// model — or no selection at all — maps to `nil`; anything else rides verbatim.
    static func wireModelId(selected: String?, defaultModelId: String?) -> String? {
        guard let selected else { return nil }
        return selected == defaultModelId ? nil : selected
    }

    /// The wire's `prompt`: `nil` when effectively empty — or when the chosen agent's CLI
    /// can't take one (`promptSupported: false`; the host would refuse it) — else the text
    /// as typed.
    static func wirePrompt(_ raw: String, promptSupported: Bool = true) -> String? {
        guard promptSupported else { return nil }
        return raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : raw
    }

    /// The host to preselect when the sheet opens: the tab's filtered host if it is online,
    /// else the single online host when exactly one is — otherwise no preselection.
    static func preselectedHost(
        filter: SessionFilter, hosts: [PairedHost], liveness: [String: Bool]
    ) -> String? {
        if case let .host(id) = filter, liveness[id] == true {
            return id
        }
        let online = hosts.filter { liveness[$0.id] == true }
        return online.count == 1 ? online.first?.id : nil
    }

    /// Whether an RPC refusal code means "this host predates the launch contract" — an absent
    /// hook answers `METHOD_NOT_FOUND`, a de-negotiated capability `FORBIDDEN`.
    static func hostCannotLaunch(code: String) -> Bool {
        code == "METHOD_NOT_FOUND" || code == "FORBIDDEN"
    }
}

/// The sheet's working state: the selected host's **open** connection + its launch options,
/// the picks, and the start flow.
///
/// WHY the connection stays open: `launchOptions` and `launchStart` must speak to the *same*
/// host over one authenticated channel — re-dialing between them would re-prompt a
/// presence-gated key (S4) and race the options against a changed host. The sheet closes it on
/// dismiss/cancel, and `deinit` is the safety net for any other way the sheet can vanish.
@MainActor
@Observable
final class CreateSessionModel {
    /// The options fetch for the selected host.
    enum OptionsState {
        /// No host chosen yet.
        case idle
        /// Dialing + fetching.
        case loading
        /// The host's projects/agents, over the still-open connection.
        case loaded(LaunchOptions)
        /// The host answered `METHOD_NOT_FOUND`/`FORBIDDEN` — it can't launch; no retry.
        case unsupported
        /// A transient failure worth a retry.
        case failed(String)
    }

    /// The selected host (drives the options fetch).
    private(set) var host: PairedHost?
    private(set) var optionsState: OptionsState = .idle
    /// The picks. `modelId` is the *picker's* selection; ``CreateSessionLogic/wireModelId``
    /// decides what actually rides the wire.
    var projectId: String?
    var agentId: String?
    var modelId: String?
    var prompt: String = ""
    /// The start flow.
    private(set) var isStarting = false
    private(set) var startError: String?

    /// The open connection behind `.loaded` — closed by ``teardown()``, or by the box's own
    /// `deinit` for any exit path that skips it (a `@MainActor` class can't touch this state
    /// from its nonisolated `deinit`, so the box owns the last-resort close).
    private let connectionBox = ConnectionBox()

    var hostId: String? { host?.id }

    /// Start is live only with the trio picked over a loaded host, and never mid-start.
    var canStart: Bool {
        guard case .loaded = optionsState else { return false }
        return CreateSessionLogic.canStart(hostId: hostId, projectId: projectId, agentId: agentId)
            && !isStarting
    }

    /// Select `host`: drop any previous connection and picks, then dial + fetch its options.
    func select(host: PairedHost, apiUrl: URL, deviceToken: String, signer: any DeviceSigner) async {
        guard self.host?.id != host.id else { return }
        self.host = host
        projectId = nil
        agentId = nil
        modelId = nil
        startError = nil
        await loadOptions(apiUrl: apiUrl, deviceToken: deviceToken, signer: signer)
    }

    /// Dial the selected host and ask for its launch options — the retry path re-enters here.
    func loadOptions(apiUrl: URL, deviceToken: String, signer: any DeviceSigner) async {
        guard let host else { return }
        if let stale = connectionBox.take() {
            await stale.close()
        }
        optionsState = .loading
        let dialed: HostConnection
        do {
            dialed = try await HostConnection.connect(
                apiUrl: apiUrl,
                deviceToken: deviceToken,
                hostId: host.id,
                pinnedHostStatic: host.staticPublicKey,
                deviceSigner: signer
            )
        } catch let error as HostConnectionError {
            optionsState = .failed(error.errorDescription ?? "Couldn't reach the host.")
            return
        } catch {
            optionsState = .failed("Couldn't reach the host.")
            return
        }
        // The user may have tapped another host while this dial was in flight — a stale
        // connection must close, never overwrite the current one.
        guard self.host?.id == host.id else {
            await dialed.close()
            return
        }
        do {
            let options = try await dialed.controller.launchOptions()
            if let displaced = connectionBox.replace(dialed) {
                await displaced.close()
            }
            optionsState = .loaded(options)
        } catch let rpc as RpcClientError where CreateSessionLogic.hostCannotLaunch(code: rpc.code) {
            await dialed.close()
            optionsState = .unsupported
        } catch {
            await dialed.close()
            optionsState = .failed("The host couldn't list its projects and agents. Try again.")
        }
    }

    /// Launch over the open connection. Returns the new `sessionRef` on success; on failure
    /// sets ``startError`` and returns `nil` (the sheet stays up).
    func start() async -> String? {
        guard let connection = connectionBox.current, case let .loaded(options) = optionsState,
              let projectId, let agentId
        else { return nil }
        isStarting = true
        startError = nil
        defer { isStarting = false }
        let agent = options.agents.first { $0.id == agentId }
        do {
            return try await connection.controller.launchStart(
                projectId: projectId,
                agentId: agentId,
                modelId: CreateSessionLogic.wireModelId(
                    selected: modelId, defaultModelId: agent?.models.first?.id
                ),
                prompt: CreateSessionLogic.wirePrompt(
                    prompt, promptSupported: agent?.promptSupported ?? true
                ),
                cols: 80,
                rows: 24
            )
        } catch let rpc as RpcClientError {
            startError = "The host refused the launch: \(rpc.message)"
            return nil
        } catch {
            startError = "Couldn't start the agent — the connection may have dropped. Try again."
            return nil
        }
    }

    /// Close the open connection (idempotent) — the dismiss/cancel path.
    func teardown() {
        guard let connection = connectionBox.take() else { return }
        Task { await connection.close() }
    }
}

/// A tiny Sendable owner for the sheet's open ``HostConnection`` — lock-guarded swaps, and a
/// `deinit` that closes whatever is still open.
///
/// WHY it exists: ``CreateSessionModel`` is `@MainActor`, and Swift 6 forbids its nonisolated
/// `deinit` from touching isolated state — so the *box* owns the connection, and the box dying
/// (with the model) is itself the deinit-safe close. `@unchecked` because the lock is the proof.
private final class ConnectionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var connection: HostConnection?

    /// The current connection, if any.
    var current: HostConnection? {
        lock.withLock { connection }
    }

    /// Swap in `new`, returning the displaced connection for the caller to close.
    func replace(_ new: HostConnection?) -> HostConnection? {
        lock.withLock {
            let old = connection
            connection = new
            return old
        }
    }

    /// Take the connection out (empty afterwards).
    func take() -> HostConnection? {
        replace(nil)
    }

    deinit {
        if let connection {
            Task { await connection.close() }
        }
    }
}

/// The New-session sheet: pick an online host, then a project / agent / model the host itself
/// advertises, type an optional prompt, and start the agent — landing straight in its terminal.
///
/// WHY the pickers are host-advertised only: the P3e contract sends nothing but ids — the host
/// joins them against allowlists it alone composes (its boarded repos, its detected agents), so
/// no path, argv, or model list ever ships in Swift.
struct CreateSessionSheet: View {
    /// The tab's pill at present time — an online filtered host is preselected.
    let filter: SessionFilter
    /// The tab's liveness snapshot — offline hosts render disabled.
    let liveness: [String: Bool]

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var form = CreateSessionModel()

    var body: some View {
        @Bindable var form = form
        NavigationStack {
            ZStack {
                Theme.bg.ignoresSafeArea()
                Form {
                    hostSection
                    optionsSections
                    startSection
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        form.teardown()
                        dismiss()
                    }
                    .foregroundStyle(Theme.muted)
                }
            }
        }
        .onAppear(perform: preselect)
        // Covers swipe-down and every other exit; idempotent after a Cancel/start teardown.
        .onDisappear { form.teardown() }
        // A newly chosen agent starts on its default model (the host's `models[0]`).
        .onChange(of: form.agentId) {
            guard case let .loaded(options) = form.optionsState else { return }
            form.modelId = options.agents.first { $0.id == form.agentId }?.models.first?.id
        }
    }

    // MARK: - Host

    private var hostSection: some View {
        Section("Host") {
            ForEach(model.hosts) { host in
                let online = liveness[host.id] == true
                Button {
                    select(host)
                } label: {
                    HStack(spacing: 10) {
                        StatusDot(color: online ? Theme.live : Theme.muted)
                        Text(host.name)
                            .foregroundStyle(online ? Theme.text : Theme.muted)
                        Spacer()
                        if form.hostId == host.id {
                            Image(systemName: "checkmark")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
                .disabled(!online)
            }
        }
        .listRowBackground(Theme.surface)
    }

    // MARK: - Options (project / agent / model / prompt)

    @ViewBuilder
    private var optionsSections: some View {
        @Bindable var form = form
        switch form.optionsState {
        case .idle:
            Section {
                Text("Pick an online host to load its projects and agents.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            .listRowBackground(Theme.surface)
        case .loading:
            Section {
                HStack(spacing: 10) {
                    ProgressView().tint(Theme.accent)
                    Text("Reaching the host…")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
            .listRowBackground(Theme.surface)
        case .unsupported:
            Section {
                Label(
                    "This host can't start agents yet — update pherry on it.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            }
            .listRowBackground(Theme.surface)
        case let .failed(message):
            Section {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                Button("Try again") { retryOptions() }
                    .foregroundStyle(Theme.accent)
            }
            .listRowBackground(Theme.surface)
        case let .loaded(options):
            Section("Project") {
                Picker("Project", selection: $form.projectId) {
                    Text("Choose…").tag(String?.none)
                    ForEach(options.projects, id: \.id) { project in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(project.name)
                            Text(project.path)
                                .font(.mono(11))
                                .foregroundStyle(Theme.muted)
                        }
                        .tag(String?.some(project.id))
                    }
                }
                .pickerStyle(.navigationLink)
                .foregroundStyle(Theme.text)
            }
            .listRowBackground(Theme.surface)

            Section("Agent") {
                Picker("Agent", selection: $form.agentId) {
                    Text("Choose…").tag(String?.none)
                    ForEach(options.agents, id: \.id) { agent in
                        Text(agent.name).tag(String?.some(agent.id))
                    }
                }
                .pickerStyle(.menu)
                .foregroundStyle(Theme.text)
                if let agent = options.agents.first(where: { $0.id == form.agentId }) {
                    Picker("Model", selection: $form.modelId) {
                        ForEach(agent.models, id: \.id) { model in
                            Text(model.name).tag(String?.some(model.id))
                        }
                    }
                    .pickerStyle(.menu)
                    .foregroundStyle(Theme.text)
                }
            }
            .listRowBackground(Theme.surface)

            // An agent whose CLI can't take a starting prompt gets the honest note
            // instead of a field the host would refuse.
            let chosenAgent = options.agents.first { $0.id == form.agentId }
            Section("Prompt") {
                if let agent = chosenAgent, !agent.promptSupported {
                    Text("\(agent.name) can't take a starting prompt yet — it opens ready for input.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                } else {
                    TextField(
                        "What should the agent do? (optional)",
                        text: $form.prompt,
                        axis: .vertical
                    )
                    .lineLimit(3...6)
                    .foregroundStyle(Theme.text)
                }
            }
            .listRowBackground(Theme.surface)
        }
    }

    // MARK: - Start

    private var startSection: some View {
        Section {
            Button {
                startAgent()
            } label: {
                HStack(spacing: 8) {
                    if form.isStarting { ProgressView().tint(.white) }
                    Text(form.isStarting ? "Starting…" : "Start agent")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(PherryButtonStyle())
            .disabled(!form.canStart)
            if let error = form.startError {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    // MARK: - Actions

    private func preselect() {
        guard form.hostId == nil,
              let id = CreateSessionLogic.preselectedHost(
                  filter: filter, hosts: model.hosts, liveness: liveness
              ),
              let host = model.hosts.first(where: { $0.id == id })
        else { return }
        select(host)
    }

    private func select(_ host: PairedHost) {
        guard let apiUrl = model.apiUrl, let deviceToken = model.deviceToken else { return }
        let signer = model.deviceSigner
        Task {
            await form.select(host: host, apiUrl: apiUrl, deviceToken: deviceToken, signer: signer)
        }
    }

    private func retryOptions() {
        guard let apiUrl = model.apiUrl, let deviceToken = model.deviceToken else { return }
        let signer = model.deviceSigner
        Task {
            await form.loadOptions(apiUrl: apiUrl, deviceToken: deviceToken, signer: signer)
        }
    }

    private func startAgent() {
        Task {
            guard let sessionRef = await form.start(), let hostId = form.hostId else { return }
            Haptics.success()
            form.teardown()
            dismiss()
            model.openSession(hostId: hostId, sessionRef: sessionRef)
        }
    }
}
