import PherryKit
import SwiftUI

/// Drives one live session: connect, subscribe, pump events into the renderer, and forward input.
///
/// WHY it owns its own connection: the terminal is opened from three places (a session row, an
/// alert push, a ring answer), and two of those have no list in the path — so it must stand alone.
/// It reaches the host exactly like `attach`, subscribes at the local grid size, feeds every
/// snapshot/output byte into SwiftTerm, mirrors host resizes, and relays keystrokes/resizes back.
/// A dropped stream is a recoverable state, not a dead end — the screen offers reconnect.
@MainActor
@Observable
final class TerminalSession {
    /// Where the mirror stands right now.
    enum Phase: Equatable {
        case connecting
        case live
        case ended
        case dropped(String)
    }

    let target: SessionTarget
    let terminal = TerminalController()
    private(set) var phase: Phase = .connecting

    private var connection: HostConnection?
    private var eventTask: Task<Void, Never>?

    init(target: SessionTarget) {
        self.target = target
        terminal.onData = { [weak self] data in
            guard let self, let controller = connection?.controller else { return }
            let ref = target.sessionRef
            Task { try? await controller.input(sessionRef: ref, data: data) }
        }
        terminal.onResize = { [weak self] cols, rows in
            guard let self, let controller = connection?.controller else { return }
            let ref = target.sessionRef
            Task { try? await controller.resize(sessionRef: ref, cols: cols, rows: rows) }
        }
    }

    /// Reach the host, subscribe, and start pumping events.
    func start(model: AppModel) async {
        phase = .connecting
        guard let apiUrl = model.apiUrl, let token = model.deviceToken else {
            phase = .dropped("This device isn't paired.")
            return
        }
        // The pair-time key is the only acceptable pin (S1). A target this phone has never docked
        // — an attention event for an org host paired on someone else's device — has no pin here,
        // and there is deliberately no fallback to the control plane's copy: dock it first.
        guard let pin = model.pinnedKey(for: target.hostId) else {
            phase = .dropped("This host isn't docked on this phone yet. Pair it to open its sessions.")
            return
        }
        do {
            let connection = try await HostConnection.connect(
                apiUrl: apiUrl,
                deviceToken: token,
                hostId: target.hostId,
                pinnedHostStatic: pin,
                deviceSigner: model.deviceSigner
            )
            self.connection = connection
            let (cols, rows) = terminal.size
            let subscription = try await connection.controller.subscribe(
                sessionRef: target.sessionRef,
                cols: max(cols, 20),
                rows: max(rows, 10)
            )
            phase = .live
            terminal.focus()
            eventTask = Task { [weak self] in await self?.consume(subscription) }
        } catch let error as HostConnectionError {
            phase = .dropped(error.errorDescription ?? "The connection dropped.")
        } catch {
            phase = .dropped("The connection dropped.")
        }
    }

    private func consume(_ subscription: ControllerClient.Subscription) async {
        do {
            for try await event in subscription.events {
                switch event {
                case let .snapshot(data), let .output(data):
                    terminal.feed(data)
                case let .resized(cols, rows):
                    terminal.resizeLocal(cols: cols, rows: rows)
                case .ended:
                    phase = .ended
                case .gap:
                    break
                }
            }
            if phase == .live { phase = .ended }
        } catch {
            phase = .dropped("The connection dropped.")
        }
    }

    /// Tear the live connection down (on close / dismiss).
    func close() async {
        eventTask?.cancel()
        await connection?.close()
        connection = nil
    }
}

/// The full-screen terminal: a slim status bar, the mirror, and the keyboard accessory SwiftTerm
/// brings. It closes cleanly and offers reconnect on a drop — the phone's whole steering surface.
struct TerminalScreen: View {
    let target: SessionTarget

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var session: TerminalSession

    init(target: SessionTarget) {
        self.target = target
        _session = State(initialValue: TerminalSession(target: target))
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                statusBar
                terminalBody
            }
        }
        .task { await session.start(model: model) }
        .onDisappear { Task { await session.close() } }
        .onChange(of: session.phase) { _, phase in
            if phase == .ended {
                Haptics.tap()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { finish() }
            }
        }
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            Button { finish() } label: {
                Image(systemName: "chevron.down")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }
            MonoChip(target.sessionRef)
            Spacer()
            statusPill
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Theme.surface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Theme.border).frame(height: 1)
        }
    }

    @ViewBuilder
    private var statusPill: some View {
        switch session.phase {
        case .connecting:
            Label("Connecting…", systemImage: "dot.radiowaves.left.and.right")
                .font(.mono(11))
                .foregroundStyle(Theme.muted)
        case .live:
            Label("E2EE · relay", systemImage: "lock.fill")
                .font(.mono(11, weight: .medium))
                .foregroundStyle(Theme.live)
        case .ended:
            Label("Ended", systemImage: "stop.fill")
                .font(.mono(11))
                .foregroundStyle(Theme.muted)
        case .dropped:
            Button {
                Task { await session.start(model: model) }
            } label: {
                Label("Reconnect", systemImage: "arrow.clockwise")
                    .font(.mono(11, weight: .medium))
            }
            .foregroundStyle(Theme.accent)
        }
    }

    @ViewBuilder
    private var terminalBody: some View {
        switch session.phase {
        case .connecting:
            VStack(spacing: 12) {
                ProgressView().tint(Theme.accent)
                Text("Reaching the session…").font(.footnote).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .dropped(message):
            VStack(spacing: 14) {
                Image(systemName: "bolt.horizontal.circle")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(Theme.danger)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                Button("Reconnect") { Task { await session.start(model: model) } }
                    .buttonStyle(PherryButtonStyle())
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .live, .ended:
            SwiftTermView(controller: session.terminal)
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    private func finish() {
        Task { await session.close() }
        model.pendingSessionTarget = nil
        dismiss()
    }
}
