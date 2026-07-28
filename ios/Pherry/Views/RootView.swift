import PherryKit
import SwiftUI

/// The shell: three tabs (Sessions, Inbox, Settings), the pair sheet, and the terminal cover.
///
/// WHY it owns the lifecycle: the attention long-poll should run only while the app is foreground
/// (quiet in the background, where push takes over), so this ties `AttentionStore`'s poll `Task` to
/// `scenePhase`. It also hosts the two modal surfaces the whole app can summon — the pair flow (a
/// scan or deep link) and a session terminal (an inbox row, a push, or a ring answer) — so any
/// screen can navigate by setting an intent on the model.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model

        TabView(selection: $model.selectedTab) {
            SessionsView()
                .tabItem { Label("Sessions", systemImage: "rectangle.stack") }
                .tag(RootTab.sessions)

            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray") }
                .badge(model.attention.unreadCount)
                .tag(RootTab.inbox)

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(RootTab.settings)
        }
        .sheet(item: $model.pendingPair) { link in
            PairFlowView(link: link)
        }
        .fullScreenCover(item: $model.pendingSessionTarget) { target in
            TerminalScreen(target: target)
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            switch phase {
            case .active:
                model.attention.startPolling()
            case .background, .inactive:
                model.attention.stopPolling()
            @unknown default:
                break
            }
        }
    }
}

/// `PairLink` is the sheet item; make it `Identifiable` by its pair token for `.sheet(item:)`.
extension PherryKit.PairLink: @retroactive Identifiable {
    public var id: String { pairToken }
}
